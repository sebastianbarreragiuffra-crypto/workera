-- GESTORA MT-3B (recorte 2, parte 2): aísla por empresa el pipeline de
-- sincronización Workera y el motor de reglas -- el hallazgo más grave que
-- dejó el análisis previo de este dominio (ver
-- docs/PLATFORM_MULTI_COMPANY.md sección 4, punto 4: "propagar el tenant
-- resuelto a ... sync ... y jobs").
--
-- Hoy, con ARCOTEX como única empresa operativa, esto es inofensivo. Pero
-- tal cual está el esquema, encender Workera para una segunda empresa
-- produciría alguno de estos tres desastres:
--
--   1. employees_external_workera_id_key es UNIQUE global (no por empresa).
--      Si dos empresas usan Workera y comparten un código de empleado
--      (plausible: son códigos secuenciales cortos del lado de Workera),
--      la segunda empresa simplemente no podría dar de alta a ese
--      trabajador -- 23505 al insertar.
--   2. sync_runs_no_concurrent_running_key y
--      rule_engine_runs_no_concurrent_running_key son locks GLOBALES
--      keyed solo por rango de fechas / por día. Dos empresas
--      sincronizando o procesando el mismo día se bloquearían
--      mutuamente con ALREADY_RUNNING, sin relación real entre sí.
--   3. workera_attendance_events_fingerprint_current_key (y su gemelo
--      compuesto con source_version) son UNIQUE globales sobre
--      external_fingerprint, que se deriva de external_employee_code --
--      el código de Workera, no nuestro employee_id. Dos empresas con el
--      mismo código de empleado y el mismo tipo de marcación el mismo día
--      colisionarían: la segunda inserción del día fallaría, o -- peor,
--      si además coincidieran hora y origin_code -- se leería como el
--      MISMO evento aunque sean personas de empresas distintas.
--
-- La corrección: agregar company_id a las tres tablas de proceso que no lo
-- tenían (sync_runs, rule_engine_runs, workera_attendance_events) y
-- recomponer cada clave/índice de concurrencia e idempotencia para incluirlo.
-- sync_runs/rule_engine_runs son corridas de lote sin employee_id -- se
-- bootstrapean con el mismo default ARCOTEX transicional que ya usan
-- employees/employee_groups desde MT-3A (20260901120000), documentado ahí
-- como puente de compatibilidad, no como modelo objetivo: activar Workera
-- para una segunda empresa requerirá que el llamador (cron/acción manual)
-- pase su company_id explícitamente -- eso es trabajo de aplicación, fuera
-- de esta migración de esquema. workera_attendance_events sí tiene
-- employee_id, así que su company_id se resuelve automáticamente en el
-- servidor (mismo trigger que ya deriva work_date/timestamp interpretado),
-- nunca confiado de un valor de cliente.

-- ---------------------------------------------------------------------------
-- 1. employees.external_workera_id: unique global -> unique por empresa.
alter table public.employees
  drop constraint employees_external_workera_id_key;
alter table public.employees
  add constraint employees_external_workera_id_company_key
    unique (company_id, external_workera_id);

-- ---------------------------------------------------------------------------
-- 2. sync_runs: agrega company_id, recompone el lock de concurrencia y
--    escopa su única policy de lectura.
alter table public.sync_runs
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';
update public.sync_runs
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;
alter table public.sync_runs alter column company_id set not null;
create index sync_runs_company_id_idx on public.sync_runs(company_id);

drop index public.sync_runs_no_concurrent_running_key;
create unique index sync_runs_no_concurrent_running_key
  on public.sync_runs (company_id, target_period_start, target_period_end)
  where status = 'RUNNING';

comment on index public.sync_runs_no_concurrent_running_key is
  'A lo sumo un sync_run RUNNING por empresa y rango de fechas exacto. '
  'MT-3B recorte 2: antes de esta migración el lock era global (sin '
  'company_id), así que dos empresas sincronizando el mismo rango se '
  'bloqueaban entre sí sin motivo real.';

drop policy if exists sync_runs_select_admin on public.sync_runs;
create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated using (
    public.is_admin_rrhh() and public.is_active_company_member(company_id)
  );

-- ---------------------------------------------------------------------------
-- 3. rule_engine_runs: mismo tratamiento que sync_runs.
alter table public.rule_engine_runs
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';
update public.rule_engine_runs
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;
alter table public.rule_engine_runs alter column company_id set not null;
create index rule_engine_runs_company_id_idx on public.rule_engine_runs(company_id);

drop index public.rule_engine_runs_no_concurrent_running_key;
create unique index rule_engine_runs_no_concurrent_running_key
  on public.rule_engine_runs (company_id, work_date)
  where status = 'RUNNING';

drop policy if exists rule_engine_runs_select on public.rule_engine_runs;
create policy rule_engine_runs_select on public.rule_engine_runs
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

-- ---------------------------------------------------------------------------
-- 4. workera_attendance_events: company_id derivado en servidor desde
--    employees.company_id -- nunca confiado de un valor de cliente, mismo
--    criterio que work_date/attendance_timestamp_interpreted en
--    set_workera_attendance_event_derived_fields() (20260818190000).
alter table public.workera_attendance_events
  add column company_id uuid references public.companies(id);

-- Las filas históricas están protegidas por el trigger genérico de
-- inmutabilidad. Se retira solo durante este backfill transaccional y se
-- reinstala inmediatamente con exactamente las mismas columnas mutables.
-- Si cualquier sentencia de la migración falla, PostgreSQL revierte también
-- el DROP y nunca deja la tabla sin protección.
drop trigger workera_attendance_events_immutable
  on public.workera_attendance_events;

update public.workera_attendance_events wae
set company_id = e.company_id
from public.employees e
where wae.employee_id = e.id;

create trigger workera_attendance_events_immutable
  before update on public.workera_attendance_events
  for each row
  execute function public.enforce_immutable_columns('is_current', 'external_fingerprint');

alter table public.workera_attendance_events alter column company_id set not null;
create index workera_attendance_events_company_id_idx
  on public.workera_attendance_events(company_id);

create or replace function public.set_workera_attendance_event_derived_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.work_date := substring(new.attendance_timestamp_raw from 1 for 10)::date;
  new.attendance_timestamp_interpreted :=
    (new.attendance_timestamp_raw::timestamp) at time zone 'America/Santiago';
  select e.company_id into new.company_id
  from public.employees e
  where e.id = new.employee_id;
  return new;
end;
$$;

comment on function public.set_workera_attendance_event_derived_fields() is
  'Calcula work_date, attendance_timestamp_interpreted y company_id a '
  'partir de attendance_timestamp_raw/employee_id. company_id se resuelve '
  'siempre server-side desde employees.company_id (MT-3B recorte 2) -- '
  'nunca confiado de un valor enviado por el cliente de sync. La '
  'conversión de zona horaria usa AT TIME ZONE ''America/Santiago'' '
  '(respeta DST vía el tzdata de Postgres) -- nunca un offset fijo '
  'hardcodeado (Fase 6A, PASO 14 del encargo).';

-- Idempotencia por empresa: dos empresas distintas con el mismo código de
-- empleado, mismo timestamp crudo, mismo tipo y mismo origin_code ya NO
-- colisionan -- son fingerprints distintos porque ahora se comparan también
-- por company_id.
drop index public.workera_attendance_events_fingerprint_current_key;
create unique index workera_attendance_events_fingerprint_current_key
  on public.workera_attendance_events (company_id, external_fingerprint)
  where is_current;

alter table public.workera_attendance_events
  drop constraint workera_attendance_events_fingerprint_version_key;
alter table public.workera_attendance_events
  add constraint workera_attendance_events_fingerprint_version_key
    unique (company_id, external_fingerprint, source_version);

drop policy if exists workera_attendance_events_select on public.workera_attendance_events;
create policy workera_attendance_events_select on public.workera_attendance_events
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));
