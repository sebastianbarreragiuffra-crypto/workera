-- Fase 2 — 03: sincronización y asistencia (hecho crudo, versionado, inmutable)
--
-- Principio no negociable (docs/BUSINESS_RULES_PRE_PHASE2.md sección 0):
-- WORKERA RAW DATA nunca se sobrescribe in situ. Un cambio posterior de Workera
-- crea una NUEVA fila versionada; la fila anterior permanece intacta para que
-- cualquier decisión que la referenció (OvertimeDecision, etc.) siga siendo
-- interpretable exactamente como era al momento de decidir.

-- ---------------------------------------------------------------------------
-- Función genérica de inmutabilidad
--
-- Reutilizada por attendance_records, overtime_records, overtime_decisions,
-- late_arrival_records, late_arrival_decisions, absence_records y
-- absence_decisions: en todas ellas, "corregir" significa insertar una fila
-- nueva y marcar la anterior is_current = false, nunca editar los hechos ya
-- escritos. Se implementa como trigger (no como CHECK) porque la regla
-- "estas columnas no cambian salvo is_current" no es expresable con CHECK de
-- una sola fila (docs/BUSINESS_RULES_PRE_PHASE2.md sección 19 ya anticipaba
-- esta necesidad).
create or replace function public.enforce_immutable_columns()
returns trigger
language plpgsql
as $$
declare
  mutable_cols text[] := tg_argv;
  col          text;
  old_val      text;
  new_val      text;
begin
  for col in select jsonb_object_keys(to_jsonb(old)) loop
    if col = any(mutable_cols) then
      continue;
    end if;
    old_val := (to_jsonb(old) ->> col);
    new_val := (to_jsonb(new) ->> col);
    if old_val is distinct from new_val then
      raise exception
        'Column "%" is immutable on %.% (only % may change after insert)',
        col, tg_table_schema, tg_table_name, mutable_cols;
    end if;
  end loop;
  return new;
end;
$$;

comment on function public.enforce_immutable_columns() is
  'Rechaza UPDATE que modifique cualquier columna no listada como mutable en '
  'los argumentos del trigger. Aplica el principio hecho-original-inmutable a '
  'las tablas de hechos y decisiones versionadas.';

-- ---------------------------------------------------------------------------
-- sync_runs (SyncRun)
--
-- Se crea en esta migración (no en la de auditoría) porque attendance_records
-- y, más adelante, absence_records referencian qué corrida de sincronización
-- las originó.
create type public.sync_run_status as enum ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

comment on type public.sync_run_status is
  'Estado técnico de una corrida de sincronización. Enum: pequeño, estable, '
  'no depende de configuración de negocio (docs/BUSINESS_RULES_PRE_PHASE2.md sección 40).';

create table public.sync_runs (
  id                    uuid primary key default gen_random_uuid(),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  status                public.sync_run_status not null default 'RUNNING',
  target_period_start   date,
  target_period_end     date,
  records_read          integer not null default 0,
  records_created       integer not null default 0,
  records_updated       integer not null default 0,
  records_conflicted    integer not null default 0,
  -- Resumen de errores sanitizado, NUNCA payloads completos de Workera ni
  -- credenciales (docs/BUSINESS_RULES_PRE_PHASE2.md sección 31 / prompt Fase 2 §31).
  error_summary         jsonb,
  created_at            timestamptz not null default now(),

  constraint sync_runs_period_chk
    check (target_period_end is null or target_period_start is null
           or target_period_end >= target_period_start),
  constraint sync_runs_counts_chk
    check (records_read >= 0 and records_created >= 0
           and records_updated >= 0 and records_conflicted >= 0)
);

comment on table public.sync_runs is
  'Registro de cada corrida de sincronización con Workera. No almacena API keys '
  'ni payloads completos — error_summary es un resumen sanitizado.';

-- ---------------------------------------------------------------------------
-- attendance_records (AttendanceRecord)
create table public.attendance_records (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id),
  work_date           date not null,

  -- Hechos crudos: se conservan exactamente como los entrega Workera, sin
  -- alterarlos para aplicar reglas de horas extra (docs/BUSINESS_RULES_PRE_PHASE2.md
  -- sección 7 — un clock_out de 19:43 se guarda como 19:43, nunca recortado).
  actual_clock_in     timestamptz,
  actual_clock_out    timestamptz,

  source              text not null default 'workera' check (source in ('workera', 'manual')),
  external_id         text,
  source_updated_at   timestamptz,
  -- Huella de los campos relevantes para una decisión (clock_in/clock_out).
  -- Existe siempre (la calcula nuestro sync), a diferencia de external_id que
  -- depende de que Workera lo entregue (fallback documentado en
  -- docs/PRE_FASE2_WORKERA_VALIDATION.md sección 8 / prompt Fase 2 §33).
  source_hash         text not null,

  source_version      integer not null default 1,
  is_current          boolean not null default true,

  sync_run_id         uuid references public.sync_runs(id),
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  constraint attendance_records_version_key
    unique (employee_id, work_date, source_version),
  constraint attendance_records_version_positive_chk
    check (source_version >= 1),
  -- Asume asistencia dentro del mismo día calendario (igual supuesto que
  -- work_schedule_rules) — no contempla salida después de medianoche.
  constraint attendance_records_clock_order_chk
    check (
      actual_clock_in is null or actual_clock_out is null
      or actual_clock_out >= actual_clock_in
    )
);

comment on table public.attendance_records is
  'Hecho crudo de marcación por fecha, versionado. Inmutable tras insertar '
  '(salvo is_current). Un cambio de Workera crea una fila nueva, nunca edita la '
  'existente — así toda decisión que referencie una versión sigue siendo '
  'interpretable aunque Workera corrija el dato después (SYNC_CONFLICT).';
comment on column public.attendance_records.source_hash is
  'Huella de los campos relevantes para decisiones (clock_in/clock_out), '
  'calculada por nuestro sync — existe siempre, a diferencia de external_id.';

-- Solo una versión "actual" por trabajador+fecha: es el puntero que el resto
-- del sistema (cálculo de overtime/atrasos, DailyReview) debe usar por defecto.
create unique index attendance_records_current_key
  on public.attendance_records (employee_id, work_date)
  where is_current;

-- Idempotencia real cuando Workera entrega un id de registro estable.
create unique index attendance_records_source_external_id_key
  on public.attendance_records (source, external_id)
  where external_id is not null;

create index attendance_records_employee_work_date_idx
  on public.attendance_records (employee_id, work_date);
create index attendance_records_sync_run_id_idx
  on public.attendance_records (sync_run_id);

create trigger attendance_records_immutable
  before update on public.attendance_records
  for each row
  execute function public.enforce_immutable_columns('is_current');
