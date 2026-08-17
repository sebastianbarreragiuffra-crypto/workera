-- Fase 2B — 09: códigos reales de asistencia (catálogo + hecho versionado)
--
-- Los 11 códigos que la empresa usa hoy (P, F, F-P, F-J, P-L, P-M, V, L, L-M,
-- R, ?) representan una clasificación DIARIA del trabajador, distinta de:
--   - attendance_records (Fase 2A): marcación cruda (clock_in/clock_out).
--   - absence_records (Fase 2A): EVENTO de ausencia por rango de fechas
--     (vacaciones/licencia/permiso), usado para AbsenceDecision.
-- P, R y "?" no son ausencias en absoluto (presente, recuperan horas, problema
-- de marcación) — no encajan en absence_records. Por eso se modela como una
-- entidad nueva y separada, no como una extensión de absence_records ni de
-- attendance_records: son tres hechos distintos del mismo día, cada uno con su
-- propio ciclo de vida y origen posible. Documentado en docs/DATA_MODEL_PHASE2B.md
-- como decisión deliberada, no redundancia accidental.

-- ---------------------------------------------------------------------------
-- attendance_statuses (catálogo, NO enum — el vocabulario de códigos podría
-- ajustarse sin deploy de código)
create table public.attendance_statuses (
  id               uuid primary key default gen_random_uuid(),
  -- El código visual (P, F, F-P, ...) es la clave de negocio, NO la PK técnica
  -- (se usa uuid como en el resto del esquema para consistencia de FKs).
  code             text not null unique,
  name             text not null,

  -- Categoría semántica: agrupa los códigos sin perder el código específico
  -- (el Excel mensual debe seguir mostrando F-J y F-P por separado, nunca
  -- colapsados). text + CHECK, no enum de Postgres: es una clasificación de
  -- negocio derivada de un análisis funcional que podría refinarse sin ser un
  -- estado técnico puro (mismo criterio aplicado a otras columnas *_status en
  -- Fase 2A que no ameritaban un enum de Postgres).
  category         text not null check (
    category in ('PRESENT', 'ABSENCE', 'PERMISSION', 'VACATION', 'LEAVE', 'RECOVERY', 'MARKING_PROBLEM')
  ),

  -- true solo para "?" (tarjeta no marcada) por ahora — confirmado
  -- explícitamente por el encargo. NO se marca en true para "R" (recuperan
  -- horas): su regla sigue pendiente de confirmación y no se inventa aquí.
  requires_review  boolean not null default false,

  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

comment on table public.attendance_statuses is
  'Catálogo de códigos diarios de asistencia (P, F, F-P, F-J, P-L, P-M, V, L, '
  'L-M, R, ?). category agrupa semánticamente sin perder el código original.';

-- ---------------------------------------------------------------------------
-- attendance_status_records — hecho versionado e inmutable, mismo patrón que
-- attendance_records/absence_records de Fase 2A.
create table public.attendance_status_records (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references public.employees(id),
  work_date             date not null,
  attendance_status_id  uuid not null references public.attendance_statuses(id),

  -- WORKERA / SYSTEM / MANUAL (más amplio que attendance_records.source de
  -- Fase 2A, que solo distingue workera/manual para la marcación cruda). SYSTEM
  -- se reserva para clasificaciones que el propio backend infiera en el futuro
  -- (ej. día no laboral). No se usa todavía en Fase 2B — el catálogo de
  -- valores queda listo para cuando exista esa lógica.
  source                text not null check (source in ('workera', 'system', 'manual')),
  external_id           text,
  source_updated_at     timestamptz,
  source_hash           text not null,

  source_version        integer not null default 1,
  is_current            boolean not null default true,

  -- Trazabilidad de novedades manuales (sección 11 del encargo): quién la
  -- registró y por qué, cuando Workera no trae correctamente una licencia,
  -- vacación, permiso o falta justificada.
  created_by            uuid references public.profiles(id),
  reason                text,

  sync_run_id           uuid references public.sync_runs(id),
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),

  constraint attendance_status_records_version_key
    unique (employee_id, work_date, source_version),
  constraint attendance_status_records_version_positive_chk
    check (source_version >= 1),
  constraint attendance_status_records_manual_requires_actor_chk
    check (source <> 'manual' or created_by is not null)
);

comment on table public.attendance_status_records is
  'Código diario de asistencia por trabajador+fecha, versionado e inmutable '
  'tras insertar (salvo is_current) — mismo patrón que attendance_records. '
  'Permite reconciliación sin fusión silenciosa: si Workera trae un valor '
  'después de una entrada manual para el mismo día, no puede sobreescribirla '
  '(solo una fila is_current por día), forzando una decisión humana explícita.';

create unique index attendance_status_records_current_key
  on public.attendance_status_records (employee_id, work_date)
  where is_current;

create unique index attendance_status_records_source_external_id_key
  on public.attendance_status_records (source, external_id)
  where external_id is not null;

create index attendance_status_records_employee_work_date_idx
  on public.attendance_status_records (employee_id, work_date);
create index attendance_status_records_status_idx
  on public.attendance_status_records (attendance_status_id);
create index attendance_status_records_sync_run_id_idx
  on public.attendance_status_records (sync_run_id);

create trigger attendance_status_records_immutable
  before update on public.attendance_status_records
  for each row
  execute function public.enforce_immutable_columns('is_current');

-- ---------------------------------------------------------------------------
-- Seed: los 11 códigos reales, confirmados por el encargo (no inferidos).
insert into public.attendance_statuses (code, name, category, requires_review) values
  ('P',   'Presente',                              'PRESENT',         false),
  ('F',   'Falta',                                 'ABSENCE',         false),
  -- F-P y F-J comparten familia semántica en el encargo ("ABSENCE/PERMISSION")
  -- pero se asigna una única categoría por código, por decisión de diseño
  -- documentada en docs/DATA_MODEL_PHASE2B.md: F-P se clasifica PERMISSION
  -- (el rasgo distintivo es que hay permiso), F-J se clasifica ABSENCE (el
  -- rasgo distintivo es que sigue siendo una falta, aunque justificada).
  ('F-P', 'Falta con permiso',                     'PERMISSION',      false),
  ('F-J', 'Falta justificada',                     'ABSENCE',         false),
  ('P-L', 'Permiso legal',                         'PERMISSION',      false),
  ('P-M', 'Permiso maternal',                      'PERMISSION',      false),
  ('V',   'Vacaciones',                            'VACATION',        false),
  ('L',   'Licencia',                               'LEAVE',           false),
  ('L-M', 'Licencia mutual',                        'LEAVE',           false),
  ('R',   'Recuperan horas',                        'RECOVERY',        false),
  ('?',   'Tarjeta no marcada o con problemas',     'MARKING_PROBLEM', true);
