-- Trazabilidad del motor de reglas (MB-2).
--
-- Contexto: hasta esta migración el motor de Fase 7
-- (`deriveDailyAttendanceRecord` + los tres generadores de candidatos) no
-- tenía NINGÚN llamador en producción -- solo sus propios tests. El cron de
-- Workera ingesta eventos crudos y se detiene ahí, así que
-- `attendance_records` y las tablas de candidatos quedaban vacías y
-- `/revision-diaria` mostraba a todos como "Sin novedades".
--
-- Esta tabla registra cada corrida del orquestador que cierra ese hueco. Es
-- deliberadamente independiente de `sync_runs`: aquella tiene su propio índice
-- único de concurrencia atado al RANGO de sincronización, y mezclar dos
-- conceptos distintos en la misma tabla haría ambiguo qué significa una fila.

create table public.rule_engine_runs (
  id                          uuid primary key default gen_random_uuid(),

  work_date                   date not null,
  status                      text not null,
  triggered_by                text not null,

  started_at                  timestamptz not null default now(),
  finished_at                 timestamptz,

  employees_processed         integer not null default 0,
  attendance_derived          integer not null default 0,
  late_candidates             integer not null default 0,
  early_departure_candidates  integer not null default 0,
  overtime_candidates         integer not null default 0,
  -- Señal operativa central de la marcha blanca: un trabajador sin horario
  -- vigente es invisible para el motor. Si este número no es 0, hay gente
  -- cuyos atrasos y horas extra NO se están calculando.
  without_schedule            integer not null default 0,
  failure_count               integer not null default 0,

  -- Mensaje técnico corto, nunca payload ni PII -- mismo criterio que
  -- `sync_runs.error_summary`.
  error_summary               text,
  triggered_by_profile        uuid references public.profiles(id),

  constraint rule_engine_runs_status_chk
    check (status in ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  constraint rule_engine_runs_triggered_by_chk
    check (triggered_by in ('CRON', 'MANUAL')),
  constraint rule_engine_runs_finished_chk
    check ((status = 'RUNNING') = (finished_at is null))
);

comment on table public.rule_engine_runs is
  'Una fila por corrida del orquestador del motor de reglas para una fecha. '
  'PARTIAL = la corrida terminó pero algún trabajador falló individualmente.';
comment on column public.rule_engine_runs.without_schedule is
  'Trabajadores activos sin schedule_assignment vigente ese día: el motor no '
  'les calcula nada. Distinto de 0 significa cobertura incompleta.';

-- Mismo mecanismo de concurrencia ya probado en `sync_runs`
-- (20260819100000): un índice único parcial en vez de una tabla de locks. Dos
-- procesos que intenten procesar la misma fecha compiten por la misma fila de
-- índice y Postgres serializa; el segundo recibe 23505 y el orquestador lo
-- traduce a "ya hay una corrida en curso".
create unique index rule_engine_runs_no_concurrent_running_key
  on public.rule_engine_runs (work_date)
  where status = 'RUNNING';

create index rule_engine_runs_work_date_idx
  on public.rule_engine_runs (work_date desc, started_at desc);

alter table public.rule_engine_runs enable row level security;

-- Lectura para cualquier usuario corporativo activo: saber si el día ya fue
-- procesado es información operativa, no sensible. Sin PII en la tabla.
create policy rule_engine_runs_select on public.rule_engine_runs
  for select to authenticated
  using (public.is_corporate_user());

-- Sin policy de escritura para `authenticated`: el orquestador corre
-- server-side bajo service_role (que tiene BYPASSRLS), igual que el pipeline
-- de sincronización. Ningún usuario escribe esta tabla desde el navegador.
grant select on public.rule_engine_runs to authenticated;
grant select, insert, update on public.rule_engine_runs to service_role;
revoke all on public.rule_engine_runs from anon;

-- Recuperación de corridas huérfanas: una función serverless que muere a
-- mitad de camino dejaría una fila RUNNING bloqueando esa fecha para siempre.
-- Mismo patrón y mismo umbral por defecto que
-- `reclaim_stale_workera_sync_runs`.
create or replace function public.reclaim_stale_rule_engine_runs(
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.rule_engine_runs
    set status = 'FAILED',
        finished_at = now(),
        error_summary = 'Corrida abandonada: superó el umbral sin finalizar.'
  where status = 'RUNNING'
    and started_at < now() - make_interval(secs => p_stale_after_seconds);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.reclaim_stale_rule_engine_runs(integer) is
  'Marca FAILED las corridas RUNNING más viejas que el umbral, para que un '
  'proceso caído no bloquee una fecha indefinidamente.';

revoke all on function public.reclaim_stale_rule_engine_runs(integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_rule_engine_runs(integer) to service_role;
