-- Fase 2 — 04: horas extra y atrasos (candidato/cálculo separado de decisión)
--
-- OvertimeRecord/LateArrivalRecord = CÁLCULO DEL SISTEMA (candidato), nunca una
-- aprobación. OvertimeDecision/LateArrivalDecision = DECISIÓN HUMANA, con
-- cantidades explícitas, nunca un booleano. Ambas parejas siguen el mismo
-- patrón de inmutabilidad que attendance_records (docs/BUSINESS_RULES_PRE_PHASE2.md
-- secciones 2-3 y 7, y principio de la sección 0).

-- ---------------------------------------------------------------------------
-- overtime_types (OvertimeType)
--
-- Catálogo, no columnas fijas hh50/hh100 en overtime_records: un día puede tener
-- ambos tipos simultáneamente, y una tercera tasa futura no requeriría alterar
-- la tabla (docs/BUSINESS_RULES_PRE_PHASE2.md sección 2).
create table public.overtime_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.overtime_types is
  'Catálogo de tipos de horas extra (OVERTIME_50, OVERTIME_100, extensible). '
  'La regla que determina qué tasa corresponde a cada caso sigue pendiente de '
  'confirmación de negocio (P0) — este catálogo solo representa que ambas tasas '
  'existen, no la regla de clasificación.';

-- ---------------------------------------------------------------------------
-- overtime_records (OvertimeRecord) — candidato calculado, inmutable
create table public.overtime_records (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references public.employees(id),
  work_date             date not null,

  -- Referencia a la versión EXACTA e inmutable de asistencia usada para calcular
  -- este candidato. Al ser attendance_records inmutable, esta FK por sí sola ya
  -- deja la decisión posterior totalmente reconstruible sin necesidad de
  -- duplicar el clock_out en esta tabla (ver overtime_decisions más abajo para
  -- el mismo razonamiento aplicado a "candidate_minutes_snapshot").
  attendance_record_id  uuid not null references public.attendance_records(id),

  overtime_type_id      uuid not null references public.overtime_types(id),

  -- Universal: nunca negativo. El tope de 120 min NO es una constraint aquí —
  -- vive en overtime_policies (docs/BUSINESS_RULES_PRE_PHASE2.md sección 9).
  candidate_minutes     integer not null check (candidate_minutes >= 0),

  -- Política efectivamente aplicada al calcular. NOT NULL a propósito: si no
  -- existe una overtime_policy para employee_group+day_of_week (ej. viernes de
  -- Producción, regla P0 pendiente), el motor de cálculo (fase futura) NO debe
  -- crear una fila aquí adivinando un tope — debe abstenerse y dejar el día en
  -- NEEDS_REVIEW. Por eso no se permite un overtime_record sin política.
  overtime_policy_id    uuid not null references public.overtime_policies(id),

  -- Se incrementa cada vez que el motor de cálculo recalcula este
  -- empleado+fecha+tipo (típicamente porque attendance_record_id cambió de
  -- versión). No es un "sync" de Workera: es un recálculo interno.
  calculation_version   integer not null default 1,
  is_current            boolean not null default true,

  calculated_at         timestamptz not null default now(),
  created_at            timestamptz not null default now(),

  constraint overtime_records_version_key
    unique (employee_id, work_date, overtime_type_id, calculation_version),
  constraint overtime_records_version_positive_chk
    check (calculation_version >= 1)
);

comment on table public.overtime_records is
  'Horas extra CANDIDATAS calculadas por el sistema a partir de una versión '
  'específica de attendance_records + la política vigente. NO es una aprobación. '
  'Inmutable tras insertar (salvo is_current) — un recálculo crea una fila nueva.';

create unique index overtime_records_current_key
  on public.overtime_records (employee_id, work_date, overtime_type_id)
  where is_current;

create index overtime_records_attendance_record_id_idx
  on public.overtime_records (attendance_record_id);
create index overtime_records_employee_work_date_idx
  on public.overtime_records (employee_id, work_date);

create trigger overtime_records_immutable
  before update on public.overtime_records
  for each row
  execute function public.enforce_immutable_columns('is_current');

-- ---------------------------------------------------------------------------
-- overtime_decisions (OvertimeDecision) — decisión humana, con cantidades
create type public.overtime_decision_status as enum (
  'FULLY_APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'
);

comment on type public.overtime_decision_status is
  'Estado técnico derivado de approved_minutes/rejected_minutes, persistido para '
  'poder filtrar/indexar sin recalcular. Enum: pequeño y estable.';

create table public.overtime_decisions (
  id                  uuid primary key default gen_random_uuid(),

  -- Apunta a una fila inmutable específica de overtime_records: es el
  -- "candidate_minutes_snapshot" implícito — no se duplica el valor porque el
  -- registro referenciado nunca cambia (alternativa elegida sobre duplicar el
  -- campo, ver docs/DATA_MODEL_PHASE2.md).
  overtime_record_id  uuid not null references public.overtime_records(id),

  approved_minutes    integer not null check (approved_minutes >= 0),
  rejected_minutes    integer not null check (rejected_minutes >= 0),
  decision_status     public.overtime_decision_status not null,

  reason              text,
  decided_by          uuid not null references public.profiles(id),
  decided_at          timestamptz not null default now(),

  -- Igual patrón de versionado que los hechos: una corrección de una decisión
  -- ya tomada (CORRECTED_AFTER_REVIEW) crea una fila nueva, la anterior queda
  -- como historial con is_current = false — nunca se pierde qué se decidió antes.
  is_current          boolean not null default true,
  created_at          timestamptz not null default now(),

  -- Row-local: coherencia entre el estado declarado y las cantidades. La
  -- coherencia CONTRA el candidato (approved+rejected = candidate_minutes) no es
  -- expresable aquí porque candidate_minutes vive en otra tabla — se aplica con
  -- el trigger validate_overtime_decision() más abajo (docs/BUSINESS_RULES_PRE_PHASE2.md
  -- sección 19).
  constraint overtime_decisions_status_consistency_chk
    check (
      (decision_status = 'REJECTED' and approved_minutes = 0 and rejected_minutes > 0)
      or (decision_status = 'FULLY_APPROVED' and rejected_minutes = 0 and approved_minutes > 0)
      or (decision_status = 'PARTIALLY_APPROVED' and approved_minutes > 0 and rejected_minutes > 0)
    )
);

comment on table public.overtime_decisions is
  'Decisión humana sobre un overtime_record específico, con cantidades explícitas '
  '(nunca un booleano). Aprobación total/parcial/rechazo total. Append-only: una '
  'corrección posterior inserta una fila nueva, is_current marca la vigente.';

create unique index overtime_decisions_current_key
  on public.overtime_decisions (overtime_record_id)
  where is_current;

create trigger overtime_decisions_immutable
  before update on public.overtime_decisions
  for each row
  execute function public.enforce_immutable_columns('is_current');

-- Constraint cruzada: approved_minutes + rejected_minutes debe igualar
-- exactamente el candidate_minutes de la fila referenciada, y approved_minutes
-- nunca puede excederlo. No es expresable como CHECK (requiere leer otra
-- tabla) — se implementa como trigger, tal como el encargo pide explícitamente
-- para este caso (Fase 2 §19).
create or replace function public.validate_overtime_decision()
returns trigger
language plpgsql
as $$
declare
  v_candidate integer;
begin
  select candidate_minutes into v_candidate
  from public.overtime_records
  where id = new.overtime_record_id;

  if v_candidate is null then
    raise exception 'overtime_record % not found', new.overtime_record_id;
  end if;

  if new.approved_minutes > v_candidate then
    raise exception
      'approved_minutes (%) cannot exceed candidate_minutes (%) for overtime_record %',
      new.approved_minutes, v_candidate, new.overtime_record_id;
  end if;

  if new.approved_minutes + new.rejected_minutes <> v_candidate then
    raise exception
      'approved_minutes + rejected_minutes (%) must equal candidate_minutes (%) for overtime_record %',
      new.approved_minutes + new.rejected_minutes, v_candidate, new.overtime_record_id;
  end if;

  return new;
end;
$$;

create trigger overtime_decisions_validate
  before insert or update on public.overtime_decisions
  for each row
  execute function public.validate_overtime_decision();

-- ---------------------------------------------------------------------------
-- late_arrival_records (LateArrivalRecord) — atraso detectado, inmutable
create table public.late_arrival_records (
  id                     uuid primary key default gen_random_uuid(),
  employee_id            uuid not null references public.employees(id),
  work_date              date not null,
  attendance_record_id   uuid not null references public.attendance_records(id),

  -- Snapshot explícito del horario vigente al momento del cálculo (no solo una
  -- FK a schedule_assignments): si el horario del trabajador cambia después,
  -- este registro sigue siendo autocontenido e interpretable sin depender de
  -- que la asignación de horario histórica siga existiendo igual.
  scheduled_start        time not null,
  actual_start           timestamptz not null,
  detected_minutes       integer not null check (detected_minutes >= 0),

  late_arrival_policy_id uuid not null references public.late_arrival_policies(id),

  calculation_version    integer not null default 1,
  is_current             boolean not null default true,

  calculated_at          timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  constraint late_arrival_records_version_key
    unique (employee_id, work_date, calculation_version),
  constraint late_arrival_records_version_positive_chk
    check (calculation_version >= 1)
);

comment on table public.late_arrival_records is
  'Atraso CANDIDATO/detectado calculado por el sistema, uno por trabajador+fecha. '
  'No es una decisión de descuento. Inmutable tras insertar (salvo is_current).';

create unique index late_arrival_records_current_key
  on public.late_arrival_records (employee_id, work_date)
  where is_current;

create index late_arrival_records_attendance_record_id_idx
  on public.late_arrival_records (attendance_record_id);

create trigger late_arrival_records_immutable
  before update on public.late_arrival_records
  for each row
  execute function public.enforce_immutable_columns('is_current');

-- ---------------------------------------------------------------------------
-- late_arrival_decisions (LateArrivalDecision)
--
-- Incluye payroll_effect (DEDUCT/DO_NOT_DEDUCT/NEEDS_REVIEW): la decisión de
-- "se descuenta o no" vive aquí, atada al hecho que la origina, en vez de una
-- entidad genérica separada (docs/BUSINESS_RULES_PRE_PHASE2.md sección 17/22 —
-- recomendación C, reafirmada).
create table public.late_arrival_decisions (
  id                      uuid primary key default gen_random_uuid(),
  late_arrival_record_id  uuid not null references public.late_arrival_records(id),

  justified               boolean not null,
  payroll_minutes         integer not null check (payroll_minutes >= 0),
  payroll_effect          text not null check (payroll_effect in ('DEDUCT', 'DO_NOT_DEDUCT', 'NEEDS_REVIEW')),

  reason                  text,
  decided_by              uuid not null references public.profiles(id),
  decided_at              timestamptz not null default now(),

  is_current              boolean not null default true,
  created_at              timestamptz not null default now()
);

comment on table public.late_arrival_decisions is
  'Decisión humana sobre un late_arrival_record: justificación y efecto en '
  'remuneración. payroll_minutes <= detected_minutes del hecho referenciado '
  '(validado por trigger, no por CHECK, por ser una regla entre tablas).';

create unique index late_arrival_decisions_current_key
  on public.late_arrival_decisions (late_arrival_record_id)
  where is_current;

create trigger late_arrival_decisions_immutable
  before update on public.late_arrival_decisions
  for each row
  execute function public.enforce_immutable_columns('is_current');

create or replace function public.validate_late_arrival_decision()
returns trigger
language plpgsql
as $$
declare
  v_detected integer;
begin
  select detected_minutes into v_detected
  from public.late_arrival_records
  where id = new.late_arrival_record_id;

  if v_detected is null then
    raise exception 'late_arrival_record % not found', new.late_arrival_record_id;
  end if;

  if new.payroll_minutes > v_detected then
    raise exception
      'payroll_minutes (%) cannot exceed detected_minutes (%) for late_arrival_record %',
      new.payroll_minutes, v_detected, new.late_arrival_record_id;
  end if;

  return new;
end;
$$;

create trigger late_arrival_decisions_validate
  before insert or update on public.late_arrival_decisions
  for each row
  execute function public.validate_late_arrival_decision();
