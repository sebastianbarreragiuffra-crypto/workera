-- Fase 2 — 06: revisión diaria/semanal, snapshot de cierre, export y auditoría

-- ---------------------------------------------------------------------------
-- daily_reviews (DailyReview)
--
-- A diferencia de las tablas de hechos/decisiones, esta SÍ es una fila mutable
-- por diseño (una por employee+work_date, que transiciona de estado): es el
-- puntero de estado "vivo" de la revisión, no un hecho a preservar versión por
-- versión. Cada transición queda igualmente registrada en audit_log (más abajo)
-- — se prefirió esta estrategia más simple sobre versionar también esta tabla,
-- para no duplicar el patrón de inmutabilidad donde no aporta trazabilidad
-- adicional (docs/BUSINESS_RULES_PRE_PHASE2.md sección 26, evitar sobreingeniería).
create type public.daily_review_status as enum (
  'IMPORTED',
  'PENDING_REVIEW',
  'REVIEWED',
  'NEEDS_REVIEW',
  'SYNC_CONFLICT',
  'CORRECTED_AFTER_REVIEW',
  'READY_FOR_WEEKLY_CLOSE'
);

comment on type public.daily_review_status is
  'Máquina de estados de revisión diaria (docs/BUSINESS_RULES_PRE_PHASE2.md '
  'sección 19/11). Enum: estado técnico pequeño y estable.';

create table public.daily_reviews (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.employees(id),
  work_date         date not null,
  status            public.daily_review_status not null default 'IMPORTED',

  -- Asignado cuando se determina a qué WeeklyReview pertenece esta fecha
  -- (proceso de periodización, fase futura). Nullable hasta entonces.
  weekly_review_id  uuid,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint daily_reviews_unique_employee_date unique (employee_id, work_date)
);

comment on table public.daily_reviews is
  'Estado de revisión agregado por trabajador+fecha. Única fila lógica activa '
  'por employee+date (constraint UNIQUE), mutable — el historial de '
  'transiciones vive en audit_log, no en versiones de esta tabla.';

create index daily_reviews_status_idx on public.daily_reviews (status);
create index daily_reviews_weekly_review_id_idx on public.daily_reviews (weekly_review_id);

create trigger daily_reviews_set_updated_at
  before update on public.daily_reviews
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- weekly_reviews (WeeklyReview)
--
-- period_start/period_end explícitos, NUNCA se asume "semana calendario"
-- (docs/BUSINESS_RULES_PRE_PHASE2.md sección 28 — el ciclo real del Excel es P0
-- sin confirmar). Alcance: a nivel de compañía (un período, todos los
-- trabajadores) — ningún documento de negocio describe cierres separados por
-- supervisor/equipo; se documenta como supuesto en docs/DATA_MODEL_PHASE2.md.
create type public.weekly_review_status as enum ('OPEN', 'READY_TO_CLOSE', 'CLOSED', 'REOPENED');

comment on type public.weekly_review_status is
  'Estado de cierre del período. Enum: estado técnico pequeño y estable.';

create table public.weekly_reviews (
  id             uuid primary key default gen_random_uuid(),
  period_start   date not null,
  period_end     date not null,
  status         public.weekly_review_status not null default 'OPEN',

  closed_by      uuid references public.profiles(id),
  closed_at      timestamptz,
  reopened_by    uuid references public.profiles(id),
  reopened_at    timestamptz,
  reopen_reason  text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Universal (no configurable): un período no puede terminar antes de empezar.
  constraint weekly_reviews_period_chk check (period_end >= period_start),

  -- Sin períodos superpuestos — un mismo día no puede pertenecer a dos cierres
  -- semanales distintos.
  constraint weekly_reviews_no_overlap
    exclude using gist (daterange(period_start, period_end, '[]') with &&)
);

comment on table public.weekly_reviews is
  'Período de cierre (no necesariamente una semana calendario). El cierre es un '
  'acto explícito (READY_TO_CLOSE -> CLOSED), nunca automático.';

alter table public.daily_reviews
  add constraint daily_reviews_weekly_review_id_fkey
  foreign key (weekly_review_id) references public.weekly_reviews(id);

create trigger weekly_reviews_set_updated_at
  before update on public.weekly_reviews
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- weekly_review_snapshots (Snapshot de cierre)
--
-- Se permite más de un snapshot por weekly_review (no UNIQUE en weekly_review_id):
-- cada cierre (incluido un cierre posterior a un REOPENED) produce un snapshot
-- nuevo, dejando el anterior intacto como historial de "qué produjo el Excel
-- anterior" (docs/BUSINESS_RULES_PRE_PHASE2.md sección 14/29).
--
-- El payload referencia IDs de filas ya inmutables (overtime_decisions,
-- late_arrival_decisions, absence_decisions, attendance_records) en vez de
-- duplicar sus valores: como esas filas nunca cambian tras insertarse, un
-- snapshot que solo lista sus IDs es 100% suficiente para reconstruir "qué vio
-- el Excel", sin copiar la base completa (equilibrio auditabilidad/sobreingeniería
-- pedido explícitamente en el encargo).
create table public.weekly_review_snapshots (
  id                uuid primary key default gen_random_uuid(),
  weekly_review_id  uuid not null references public.weekly_reviews(id),
  generated_by      uuid not null references public.profiles(id),
  generated_at      timestamptz not null default now(),

  -- Estructura documentada en docs/DATA_MODEL_PHASE2.md: por trabajador,
  -- referencias a attendance_record_id / overtime_decision_id[] /
  -- late_arrival_decision_id / absence_decision_id[] vigentes al momento del
  -- cierre, más totales agregados para exhibición rápida.
  payload           jsonb not null,

  created_at        timestamptz not null default now()
);

comment on table public.weekly_review_snapshots is
  'Congelamiento de qué decisiones/hechos (por ID, no por valor duplicado) '
  'cerraron un período. Uno o más por weekly_review — un reopen+recierre agrega '
  'un snapshot nuevo, nunca reemplaza el anterior.';

create index weekly_review_snapshots_weekly_review_id_idx
  on public.weekly_review_snapshots (weekly_review_id);

-- ---------------------------------------------------------------------------
-- excel_exports (ExcelExport) — solo metadata en Fase 2, sin generar archivos
create table public.excel_exports (
  id                 uuid primary key default gen_random_uuid(),
  weekly_review_id   uuid not null references public.weekly_reviews(id),
  snapshot_id        uuid not null references public.weekly_review_snapshots(id),

  generated_by       uuid not null references public.profiles(id),
  generated_at       timestamptz not null default now(),
  template_version   text not null,
  validation_status  text not null check (validation_status in ('PASSED', 'PASSED_WITH_WARNINGS', 'FAILED')),

  -- Nulos en Fase 2: el archivo real aún no se genera (Fase 10). El binario del
  -- .xlsx NUNCA se guarda como blob en Postgres — storage_path apunta a
  -- Supabase Storage (docs Fase 2 §30).
  file_hash          text,
  storage_path       text,

  created_at         timestamptz not null default now()
);

comment on table public.excel_exports is
  'Metadata de cada export semanal. El archivo .xlsx vive en Supabase Storage '
  '(storage_path), nunca como blob en esta tabla. Sin generación de archivos en '
  'Fase 2 — file_hash/storage_path quedan nulos hasta Fase 10.';

create index excel_exports_weekly_review_id_idx on public.excel_exports (weekly_review_id);

-- ---------------------------------------------------------------------------
-- audit_log (AuditLog) — transversal, genérico por diseño
--
-- entity_id es un uuid suelto (sin FK) deliberadamente: es un log genérico de
-- "qué pasó, quién, cuándo" sobre cualquier entidad del dominio, no una tabla de
-- dominio en sí (docs/BUSINESS_RULES_PRE_PHASE2.md sección 32 — no sustituye
-- tablas específicas, por eso NO duplica aquí approved_minutes ni ningún otro
-- dato de negocio más allá de un metadata jsonb acotado).
create table public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles(id), -- null = acción del sistema (ej. sync)
  action       text not null,
  entity_type  text not null,
  entity_id    uuid not null,
  occurred_at  timestamptz not null default now(),
  metadata     jsonb
);

comment on table public.audit_log is
  'Auditoría transversal de acciones relevantes (decisiones, cierres, '
  'reaperturas, resultados de sync). entity_id sin FK a propósito: es un log '
  'genérico, no reemplaza las tablas de dominio específicas.';

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_occurred_at_idx on public.audit_log (occurred_at);
create index audit_log_actor_id_idx on public.audit_log (actor_id);
