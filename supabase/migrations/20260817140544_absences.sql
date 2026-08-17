-- Fase 2 — 05: ausencias (vacaciones, licencias, permisos)
--
-- Minimización de datos aplicada explícitamente: nunca diagnóstico ni detalle
-- médico (docs/BUSINESS_RULES_PRE_PHASE2.md sección 15).

-- ---------------------------------------------------------------------------
-- absence_types (AbsenceType)
--
-- Catálogo, no enum: los nombres exactos siguen sin confirmarse del todo
-- (docs/BUSINESS_RULES_PRE_PHASE2.md sección 15/20 — "no convertir todavía en
-- enum definitivo"). Se siembra con el conjunto conceptual ya evidenciado por
-- el Excel real y los documentos de negocio (07_seeds.sql), pero al ser un
-- catálogo, renombrar o agregar un tipo es una fila nueva, no una migración de
-- esquema.
create table public.absence_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.absence_types is
  'Catálogo de tipos de ausencia (VACATION, MEDICAL_LEAVE, WORK_ACCIDENT_LEAVE, '
  'etc). MEDICAL_LEAVE y WORK_ACCIDENT_LEAVE son tipos separados (no una '
  'subcategoría), por su tratamiento legal distinto en Chile.';

-- ---------------------------------------------------------------------------
-- absence_records (AbsenceRecord) — hecho, inmutable, versionado
create table public.absence_records (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id),
  absence_type_id     uuid not null references public.absence_types(id),

  start_date          date not null,
  end_date            date not null,

  source              text not null default 'workera' check (source in ('workera', 'manual')),
  external_id         text,
  source_updated_at   timestamptz,
  source_hash         text not null,

  source_version      integer not null default 1,
  is_current          boolean not null default true,

  sync_run_id         uuid references public.sync_runs(id),
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  constraint absence_records_date_range_chk check (end_date >= start_date),
  constraint absence_records_version_positive_chk check (source_version >= 1)

  -- Deliberadamente SIN constraint que impida solapamiento de absence_records
  -- del mismo trabajador (ej. licencia y vacaciones superpuestas): Workera puede
  -- entregar datos ambiguos o contradictorios que el sistema debe poder
  -- almacenar para luego exigir una absence_decision que los resuelva. Impedirlo
  -- a nivel de constraint bloquearía la propia sincronización de datos crudos.
  -- La validación "vacaciones + licencia simultánea" es BLOCKING a nivel de
  -- DailyReview (fase futura), no una restricción de esta tabla.
);

comment on table public.absence_records is
  'Hecho crudo de ausencia (vacaciones/licencia/permiso/falta), versionado e '
  'inmutable tras insertar (salvo is_current), igual patrón que attendance_records.';

create unique index absence_records_source_external_id_key
  on public.absence_records (source, external_id)
  where external_id is not null;

create index absence_records_employee_dates_idx
  on public.absence_records (employee_id, start_date, end_date);
create index absence_records_current_idx
  on public.absence_records (employee_id)
  where is_current;

create trigger absence_records_immutable
  before update on public.absence_records
  for each row
  execute function public.enforce_immutable_columns('is_current');

-- ---------------------------------------------------------------------------
-- absence_decisions (AbsenceDecision)
--
-- No toda absence_record necesita una decisión explícita (docs/BUSINESS_RULES_PRE_PHASE2.md
-- sección 25): su rol es confirmar/disputar/corregir el tipo, no aprobar una
-- cantidad como en horas extra/atrasos. Un registro sin decisión asociada
-- mantiene el día en PENDING_REVIEW hasta que un supervisor lo confirme.
create table public.absence_decisions (
  id                        uuid primary key default gen_random_uuid(),
  absence_record_id         uuid not null references public.absence_records(id),

  decision_status           text not null check (decision_status in ('CONFIRMED', 'DISPUTED', 'CORRECTED')),
  corrected_absence_type_id uuid references public.absence_types(id),

  reason                    text,
  decided_by                uuid not null references public.profiles(id),
  decided_at                timestamptz not null default now(),

  is_current                boolean not null default true,
  created_at                timestamptz not null default now(),

  constraint absence_decisions_corrected_type_chk
    check (
      (decision_status = 'CORRECTED' and corrected_absence_type_id is not null)
      or (decision_status <> 'CORRECTED' and corrected_absence_type_id is null)
    )
);

comment on table public.absence_decisions is
  'Confirmación, disputa o corrección de tipo sobre un absence_record. No '
  'sobrescribe el hecho original — corrected_absence_type_id es la corrección, '
  'absence_records.absence_type_id nunca cambia.';

create unique index absence_decisions_current_key
  on public.absence_decisions (absence_record_id)
  where is_current;

create trigger absence_decisions_immutable
  before update on public.absence_decisions
  for each row
  execute function public.enforce_immutable_columns('is_current');
