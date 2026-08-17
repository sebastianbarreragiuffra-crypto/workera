-- Fase 2B — 12: ReportingPeriod (≈1 mes), relación con WeeklyReview, snapshot
-- de período y diferenciación de exports
--
-- weekly_reviews (Fase 2A) se mantiene sin cambios de significado: sigue
-- siendo el "check semanal". Se agrega un nivel superior para el cierre final,
-- que NO se asume igual a un mes calendario exacto.

-- ---------------------------------------------------------------------------
-- reporting_periods (ReportingPeriod)
--
-- Nombre elegido sobre "PayrollPeriod": este esquema todavía no calcula
-- remuneraciones, solo prepara los datos para ese proceso — "reporting" no
-- sugiere que el sistema sea el motor de nómina, solo el período sobre el que
-- se reporta/consolida.
create type public.reporting_period_status as enum (
  'OPEN', 'IN_REVIEW', 'READY_TO_CLOSE', 'CLOSED', 'REOPENED'
);

comment on type public.reporting_period_status is
  'Estado técnico pequeño y estable — mismo criterio enum que '
  'weekly_review_status (Fase 2A). Incluye IN_REVIEW porque, a diferencia de '
  'WeeklyReview, un ReportingPeriod puede estar activamente en revisión '
  'durante varias semanas antes de estar listo para cerrar.';

create table public.reporting_periods (
  id             uuid primary key default gen_random_uuid(),
  period_start   date not null,
  period_end     date not null,
  status         public.reporting_period_status not null default 'OPEN',

  closed_by      uuid references public.profiles(id),
  closed_at      timestamptz,
  reopened_by    uuid references public.profiles(id),
  reopened_at    timestamptz,
  reopen_reason  text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint reporting_periods_range_chk check (period_end >= period_start),

  -- Sin períodos superpuestos, mismo criterio que weekly_reviews (Fase 2A).
  constraint reporting_periods_no_overlap
    exclude using gist (daterange(period_start, period_end, '[]') with &&)
);

comment on table public.reporting_periods is
  'Período de cierre final (~1 mes, ciclo exacto sin confirmar — P0). No '
  'asume día 1 a último día del mes calendario: period_start/period_end son '
  'fechas libres, igual criterio que weekly_reviews.';

create trigger reporting_periods_set_updated_at
  before update on public.reporting_periods
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Relación WeeklyReview -> ReportingPeriod (aditiva, nullable: no rompe las
-- filas ni los tests de Fase 2A que insertan weekly_reviews sin este campo).
alter table public.weekly_reviews
  add column reporting_period_id uuid references public.reporting_periods(id);

create index weekly_reviews_reporting_period_id_idx
  on public.weekly_reviews (reporting_period_id);

comment on column public.weekly_reviews.reporting_period_id is
  'A qué ReportingPeriod pertenece este check semanal. Nullable: una semana '
  'puede existir/revisarse antes de asignarse formalmente a un período '
  '(proceso de periodización, fase futura).';

-- Nota de diseño (sección 32 del encargo): "semana revisada != mes cerrado" no
-- se aplica aquí como trigger (ej. impedir CLOSED en reporting_periods si
-- existen weekly_reviews no CLOSED). Mismo criterio ya usado en Fase 2A para
-- la relación DailyReview -> WeeklyReview: es una regla de negocio que la
-- capa de aplicación/validación debe verificar antes de cerrar (documentada en
-- docs/DATA_MODEL_PHASE2B.md), no una restricción de integridad estructural —
-- impedirlo con un trigger no evita ningún dato inválido en la base, solo
-- automatiza un paso de proceso que pertenece a una fase posterior (sección 48).

-- ---------------------------------------------------------------------------
-- period_snapshots — mismo patrón que weekly_review_snapshots (Fase 2A):
-- referencias por ID a filas ya inmutables, no duplicación de datos. Puede
-- referenciar los weekly_review_snapshots de las semanas que componen el
-- período en vez de reconstruir todo desde cero.
create table public.period_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  reporting_period_id uuid not null references public.reporting_periods(id),
  generated_by        uuid not null references public.profiles(id),
  generated_at        timestamptz not null default now(),

  -- Estructura documentada en docs/DATA_MODEL_PHASE2B.md: referencias a los
  -- weekly_review_snapshot_id de cada semana del período, más agregados
  -- (bonos, ausencias, etc.) por trabajador para exhibición rápida.
  payload              jsonb not null,

  created_at           timestamptz not null default now()
);

comment on table public.period_snapshots is
  'Congelamiento del período completo para el Excel final — referencia los '
  'weekly_review_snapshots de sus semanas, no copia la base. Uno o más por '
  'reporting_period (igual criterio que weekly_review_snapshots).';

create index period_snapshots_reporting_period_id_idx
  on public.period_snapshots (reporting_period_id);

-- ---------------------------------------------------------------------------
-- excel_exports (Fase 2A): diferenciar WEEKLY_CHECK vs FINAL_PERIOD
alter table public.excel_exports
  add column export_scope text not null default 'WEEKLY_CHECK'
    check (export_scope in ('WEEKLY_CHECK', 'FINAL_PERIOD')),
  add column reporting_period_id uuid references public.reporting_periods(id),
  add column period_snapshot_id uuid references public.period_snapshots(id);

-- weekly_review_id/snapshot_id (Fase 2A) eran NOT NULL porque todo export
-- era, hasta ahora, semanal. Un FINAL_PERIOD export no tiene un único
-- weekly_review — pasan a ser opcionales, y el CHECK de abajo exige el
-- conjunto correcto de referencias según el scope.
alter table public.excel_exports
  alter column weekly_review_id drop not null,
  alter column snapshot_id drop not null;

alter table public.excel_exports
  add constraint excel_exports_scope_references_chk
  check (
    (export_scope = 'WEEKLY_CHECK'
      and weekly_review_id is not null and snapshot_id is not null
      and reporting_period_id is null and period_snapshot_id is null)
    or
    (export_scope = 'FINAL_PERIOD'
      and reporting_period_id is not null and period_snapshot_id is not null
      and weekly_review_id is null and snapshot_id is null)
  );

comment on column public.excel_exports.export_scope is
  'WEEKLY_CHECK = preview/borrador semanal para verificar datos (no es el '
  'Excel de remuneraciones). FINAL_PERIOD = Excel definitivo del período '
  'cerrado. Cada scope exige su propio conjunto de referencias (CHECK).';
