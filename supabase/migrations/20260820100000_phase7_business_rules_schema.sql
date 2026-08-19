-- Fase 7 — modelo de datos del motor de reglas de asistencia (horario
-- efectivo, exenciones de control horario, salida anticipada + flujo médico,
-- documento obligatorio de licencia, cumpleaños). NO toca
-- `workera_attendance_events` (fuente cruda inmutable, Fase 6A/6B) ni
-- `attendance_records`/`late_arrival_records`/`overtime_records` existentes
-- más allá de una extensión aditiva puntual sobre `absence_decisions` y
-- `supporting_documents`. Reutiliza `work_schedules`/`work_schedule_rules`/
-- `schedule_assignments` (Fase 2) tal cual para horarios general/individual
-- -- Alejandro Valencia y María Vera no requieren tabla nueva, solo filas
-- nuevas en esas tablas ya existentes (ver seed administrativo separado).

-- =============================================================================
-- 1) employee_time_control_policies — exención de control horario
--    (Claudio Andrés Barrera: sin marcación; Michel Mendy: Artículo 22).
-- =============================================================================
--
-- Mismo patrón exacto que employee_group_assignments/schedule_assignments/
-- supervisor_assignments: vigencia con effective_from/to + exclusion
-- constraint que impide solapamiento. Ausencia de fila = NORMAL (default
-- implícito, no se siembra una fila NORMAL para cada trabajador). Un único
-- policy_code (EXEMPT_FROM_TIME_CONTROL) cubre ambos casos del encargo --
-- "sin marcación" y "Artículo 22" son el MISMO efecto operacional (cero
-- atraso/salida anticipada/overtime/tarjeta-no-marcada automáticos);
-- `legal_basis` distingue el motivo para auditoría/reportes sin bifurcar el
-- motor en dos mecanismos.
create table public.employee_time_control_policies (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees(id),

  policy_code     text not null check (policy_code in ('NORMAL', 'EXEMPT_FROM_TIME_CONTROL')),
  legal_basis     text check (legal_basis is null or legal_basis in ('NO_MARKING_REQUIRED', 'ARTICLE_22', 'OTHER')),

  effective_from  date not null,
  effective_to    date,

  reason          text,
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),

  constraint employee_time_control_policies_range_chk
    check (effective_to is null or effective_to >= effective_from),
  constraint employee_time_control_policies_legal_basis_chk
    check ((policy_code = 'EXEMPT_FROM_TIME_CONTROL') = (legal_basis is not null)),
  constraint employee_time_control_policies_no_overlap
    exclude using gist (employee_id with =, daterange(effective_from, effective_to, '[]') with &&)
);

comment on table public.employee_time_control_policies is
  'Exención de control horario con vigencia (Fase 7). Un trabajador SIN fila '
  'vigente aquí se evalúa NORMAL por defecto. EXEMPT_FROM_TIME_CONTROL '
  'excluye al trabajador de atraso/salida anticipada/overtime automático y '
  'de la alerta de tarjeta no marcada -- nunca se infiere por nombre en el '
  'motor, solo por esta tabla.';

create index employee_time_control_policies_employee_id_idx
  on public.employee_time_control_policies (employee_id);

alter table public.employee_time_control_policies enable row level security;

create policy employee_time_control_policies_select on public.employee_time_control_policies
  for select to authenticated using (public.is_corporate_user());
create policy employee_time_control_policies_write_admin on public.employee_time_control_policies
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

-- Este proyecto NO usa ALTER DEFAULT PRIVILEGES (Fase 3, grants_lockdown) --
-- toda tabla nueva debe repetir el GRANT explícito, la policy RLS por sí
-- sola no basta (el privilegio de tabla se evalúa antes que RLS).
grant select, insert, update, delete on table public.employee_time_control_policies to authenticated;

-- =============================================================================
-- 2) early_departure_records / early_departure_decisions -- nueva pareja
--    candidato/decisión, mismo patrón exacto que late_arrival_records/
--    late_arrival_decisions (Fase 2A/3), incluyendo flujo médico Producción.
-- =============================================================================
create table public.early_departure_records (
  id                     uuid primary key default gen_random_uuid(),
  employee_id            uuid not null references public.employees(id),
  work_date              date not null,
  attendance_record_id   uuid not null references public.attendance_records(id),

  scheduled_end          time not null,       -- snapshot del horario EFECTIVO del día (nunca 17:00 fijo)
  actual_end             timestamptz not null,
  detected_minutes       integer not null check (detected_minutes >= 0),

  calculation_version    integer not null default 1,
  is_current             boolean not null default true,

  calculated_at          timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  constraint early_departure_records_version_key unique (employee_id, work_date, calculation_version)
);

comment on table public.early_departure_records is
  'Candidato de salida anticipada (Fase 7) -- hecho calculado por el motor, '
  'inmutable tras insertar salvo is_current. scheduled_end es el horario '
  'EFECTIVO resuelto para ese trabajador/día (general, individual, o el '
  'motor nunca genera esta fila para un trabajador EXEMPT_FROM_TIME_CONTROL).';

create index early_departure_records_employee_work_date_idx
  on public.early_departure_records (employee_id, work_date);
create index early_departure_records_current_idx
  on public.early_departure_records (employee_id) where is_current;

create trigger early_departure_records_immutable
  before update on public.early_departure_records
  for each row execute function public.enforce_immutable_columns('is_current');

create table public.early_departure_decisions (
  id                          uuid primary key default gen_random_uuid(),
  early_departure_record_id   uuid not null references public.early_departure_records(id),

  -- MEDICAL exige documento (PASO 17/18); BIRTHDAY_AUTHORIZED es la salida de
  -- cumpleaños (PASO 29-32, deduction=0 siempre); OTHER_JUSTIFIED cubre otras
  -- justificaciones ya soportadas por el modelo (ej. permiso); UNJUSTIFIED =
  -- se descuenta; NEEDS_REVIEW = estado intermedio mientras se investiga (ej.
  -- PENDING_DOCUMENT mientras se espera el comprobante médico).
  reason_category             text not null check (
    reason_category in ('MEDICAL', 'BIRTHDAY_AUTHORIZED', 'OTHER_JUSTIFIED', 'UNJUSTIFIED', 'NEEDS_REVIEW')
  ),

  document_required           boolean not null default false,
  -- Plazo en días HÁBILES (lunes-viernes, sin calendario de feriados legales
  -- todavía -- PASO 18, limitación documentada) calculado por la capa de
  -- aplicación (addBusinessDays) y persistido aquí, nunca recalculado en SQL.
  document_deadline           date,

  payroll_minutes             integer not null check (payroll_minutes >= 0),
  payroll_effect               text not null check (payroll_effect in ('DEDUCT', 'DO_NOT_DEDUCT', 'NEEDS_REVIEW')),

  reason                      text,
  decided_by                  uuid not null references public.profiles(id) default auth.uid(),
  decided_at                  timestamptz not null default now(),

  is_current                  boolean not null default true,
  created_at                  timestamptz not null default now(),

  constraint early_departure_decisions_document_deadline_chk
    check (document_required = (document_deadline is not null))
);

comment on table public.early_departure_decisions is
  'Decisión sobre un early_departure_record (Fase 7). MEDICAL siempre exige '
  'documento; no puede cerrarse DO_NOT_DEDUCT por motivo médico sin un '
  'supporting_documents adjunto al early_departure_record (validado por '
  'trigger, no solo por convención de aplicación). BIRTHDAY_AUTHORIZED '
  'siempre DO_NOT_DEDUCT (deduction=0) -- ver PASO 31.';

create unique index early_departure_decisions_current_key
  on public.early_departure_decisions (early_departure_record_id) where is_current;

create or replace function public.validate_early_departure_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_detected_minutes integer;
begin
  select detected_minutes into v_detected_minutes
  from public.early_departure_records
  where id = new.early_departure_record_id;

  if v_detected_minutes is null then
    raise exception 'early_departure_record_id % no existe', new.early_departure_record_id;
  end if;

  if new.payroll_minutes > v_detected_minutes then
    raise exception
      'payroll_minutes (%) no puede exceder detected_minutes (%) del early_departure_record %',
      new.payroll_minutes, v_detected_minutes, new.early_departure_record_id;
  end if;

  if new.reason_category = 'MEDICAL' and not new.document_required then
    raise exception 'reason_category=MEDICAL requiere document_required=true (PASO 18 del encargo)';
  end if;

  if new.reason_category = 'BIRTHDAY_AUTHORIZED' and new.payroll_effect <> 'DO_NOT_DEDUCT' then
    raise exception 'reason_category=BIRTHDAY_AUTHORIZED debe tener payroll_effect=DO_NOT_DEDUCT (PASO 31: deduction=0)';
  end if;

  -- No cerrar como justificado (DO_NOT_DEDUCT) por motivo médico sin
  -- comprobante adjunto al early_departure_record (PASO 19: "no cerrar
  -- definitivamente el caso como justificado mientras falte respaldo").
  if new.reason_category = 'MEDICAL' and new.payroll_effect = 'DO_NOT_DEDUCT' then
    if not exists (
      select 1 from public.supporting_documents sd
      where sd.early_departure_record_id = new.early_departure_record_id
    ) then
      raise exception
        'No se puede cerrar DO_NOT_DEDUCT una salida médica (early_departure_record_id=%) sin supporting_documents adjunto.',
        new.early_departure_record_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger early_departure_decisions_validate
  before insert on public.early_departure_decisions
  for each row execute function public.validate_early_departure_decision();

create trigger early_departure_decisions_immutable
  before update on public.early_departure_decisions
  for each row execute function public.enforce_immutable_columns('is_current');

-- RLS: mismo patrón exacto que late_arrival_records/late_arrival_decisions
-- (Fase 3) -- lectura amplia corporativa, escritura de decisión scoped por
-- can_manage_employee(), override de decisión ya tomada solo admin
-- privilegiado (is_privileged_admin(), convención post-Fase-5D).
alter table public.early_departure_records enable row level security;
alter table public.early_departure_decisions enable row level security;

create policy early_departure_records_select on public.early_departure_records
  for select to authenticated using (public.is_corporate_user());

create policy early_departure_decisions_select on public.early_departure_decisions
  for select to authenticated using (public.is_corporate_user());

create policy early_departure_decisions_insert on public.early_departure_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and exists (
      select 1 from public.early_departure_records edr
      where edr.id = early_departure_record_id
        and public.can_manage_employee(edr.employee_id)
    )
  );

create policy early_departure_decisions_update_admin on public.early_departure_decisions
  for update to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

-- Hecho calculado por el motor (server-only) -- SOLO lectura para
-- `authenticated`, mismo criterio que overtime_records/late_arrival_records
-- (sin GRANT de escritura -- ni siquiera hay policy que lo permitiría, pero
-- se refuerza también a nivel de privilegio, no solo de policy).
grant select on table public.early_departure_records to authenticated;
grant select, insert, update on table public.early_departure_records to service_role;

-- early_departure_decisions: lectura + inserción scoped + actualización admin.
grant select, insert, update on table public.early_departure_decisions to authenticated;

-- =============================================================================
-- 3) supporting_documents -- extensión aditiva: los comprobantes médicos de
--    salida anticipada se adjuntan al RECORD (no a una decisión puntual),
--    exactamente el mismo patrón ya usado por absence_record_id.
-- =============================================================================
alter table public.supporting_documents
  add column early_departure_record_id uuid references public.early_departure_records(id);

alter table public.supporting_documents
  drop constraint supporting_documents_at_most_one_relation_chk;
alter table public.supporting_documents
  add constraint supporting_documents_at_most_one_relation_chk
  check (num_nonnulls(
    absence_record_id, late_arrival_decision_id, attendance_status_record_id, early_departure_record_id
  ) <= 1);

create index supporting_documents_early_departure_record_id_idx
  on public.supporting_documents (early_departure_record_id) where early_departure_record_id is not null;

comment on column public.supporting_documents.early_departure_record_id is
  'Comprobante médico de una salida anticipada (Fase 7). Se adjunta al '
  'RECORD (candidato), no a una early_departure_decision puntual -- mismo '
  'patrón que absence_record_id, evita el problema de huevo-y-gallina de '
  'exigir el documento antes de poder crear la decisión que lo referencia.';

-- =============================================================================
-- 4) absence_decisions -- extensión aditiva: documento obligatorio de
--    licencia (PASO 22/23). LICENSE_REPORTED = absence_record sin decisión;
--    PENDING_DOCUMENT = decisión intermedia mientras se espera el
--    comprobante; DOCUMENT_RECEIVED -> CONFIRMED = nueva decisión (versionada,
--    nunca se muta la anterior) una vez adjunto el documento.
-- =============================================================================
alter table public.absence_decisions
  drop constraint absence_decisions_decision_status_check;
alter table public.absence_decisions
  add constraint absence_decisions_decision_status_check
  check (decision_status in ('CONFIRMED', 'DISPUTED', 'CORRECTED', 'PENDING_DOCUMENT'));

alter table public.absence_decisions
  add column document_required boolean not null default false;
alter table public.absence_decisions
  add column document_deadline date;
alter table public.absence_decisions
  add constraint absence_decisions_document_deadline_chk
  check (document_required = (document_deadline is not null));

comment on column public.absence_decisions.document_required is
  'Fase 7: cuando true, decision_status=CONFIRMED exige un supporting_documents '
  'ya adjunto a absence_record_id (validado por trigger). LICENSE_REPORTED -> '
  'PENDING_DOCUMENT -> (documento adjunto) -> nueva fila CONFIRMED -- nunca '
  'se muta esta fila para "agregar" el documento después.';

create or replace function public.validate_absence_decision_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.decision_status = 'CONFIRMED' and new.document_required then
    if not exists (
      select 1 from public.supporting_documents sd
      where sd.absence_record_id = new.absence_record_id
    ) then
      raise exception
        'No se puede CONFIRMED una absence_decision con document_required=true sin supporting_documents adjunto (absence_record_id=%).',
        new.absence_record_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger absence_decisions_validate_document
  before insert on public.absence_decisions
  for each row execute function public.validate_absence_decision_document();

-- =============================================================================
-- 5) employee_birthdays -- minimización de datos: SOLO mes/día, nunca año.
-- =============================================================================
create table public.employee_birthdays (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null unique references public.employees(id),

  birth_month   smallint not null check (birth_month between 1 and 12),
  birth_day     smallint not null check (birth_day between 1 and 31),

  imported_at   timestamptz not null default now(),
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),

  constraint employee_birthdays_valid_day_chk check (
    birth_day <= case birth_month
      when 2 then 29  -- se permite 29 (año de nacimiento deliberadamente no se almacena, PASO 28)
      when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30
      else 31
    end
  )
);

comment on table public.employee_birthdays is
  'Solo mes y día de cumpleaños (Fase 7, PASO 28: minimización de datos -- '
  'no se almacena año de nacimiento, no se necesita para la regla '
  'operacional de salida anticipada). Importado desde una fuente externa '
  '(Excel de RRHH) vía script controlado con dry-run -- ver '
  'docs/BUSINESS_RULES_PHASE7.md.';

alter table public.employee_birthdays enable row level security;

create policy employee_birthdays_select on public.employee_birthdays
  for select to authenticated using (public.is_corporate_user());
create policy employee_birthdays_write_admin on public.employee_birthdays
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

grant select, insert, update, delete on table public.employee_birthdays to authenticated;
grant select, insert, update on table public.employee_birthdays to service_role;
