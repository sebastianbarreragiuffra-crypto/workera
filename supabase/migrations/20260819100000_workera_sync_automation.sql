-- Fase 6B — infraestructura de automatización de la ingesta Workera (sin
-- reglas de negocio, sin UI, sin cron real desplegado). Esta migración NO
-- toca `workera_attendance_events` ni cómo se persisten los eventos —
-- extiende exclusivamente `sync_runs` (metadata/lifecycle + concurrencia).

-- =============================================================================
-- 1) sync_runs — extensión aditiva para observabilidad de automatización.
-- =============================================================================

-- Quién disparó la corrida — necesario para auditar "¿esto lo hizo el cron o
-- un rerun manual de un admin?" (Fase 6B, PASO 13/26). Default 'MANUAL' para
-- no romper la semántica de las filas ya escritas en Fase 6A (todas fueron
-- manuales).
alter table public.sync_runs
  add column triggered_by text not null default 'MANUAL'
    check (triggered_by in ('CRON', 'MANUAL'));

comment on column public.sync_runs.triggered_by is
  'CRON = disparado por el scheduler automático (Fase 6B). MANUAL = corrida '
  'manual/dry-run (Fase 6A) o rerun administrativo (Fase 6B). Default MANUAL '
  'por compatibilidad con las filas existentes de Fase 6A.';

-- Número de intento dentro de una misma secuencia de reintentos para el
-- mismo rango de fechas (Fase 6B, PASO 14/15: "nunca infinite retry",
-- "configurable"). Cada intento es una fila NUEVA -- mismo patrón de
-- hecho-inmutable-versionado que el resto del esquema, no una fila mutada.
alter table public.sync_runs
  add column attempt integer not null default 1
    check (attempt >= 1);

comment on column public.sync_runs.attempt is
  'Número de intento (1 = primer intento) dentro de una secuencia de '
  'reintentos para el mismo rango. Cada reintento crea una fila nueva -- '
  'nunca se muta un sync_run existente para "reintentarlo".';

-- Enlaza un reintento con el intento anterior de la misma secuencia (Fase
-- 6B, PASO 51: poder reconstruir la cadena "FAILED -> FAILED -> SUCCEEDED").
-- Nullable: el primer intento de una secuencia no tiene predecesor.
alter table public.sync_runs
  add column retry_of uuid references public.sync_runs(id);

comment on column public.sync_runs.retry_of is
  'sync_runs.id del intento anterior de la misma secuencia de reintentos, '
  'si esta fila es un reintento. NULL en el primer intento.';

-- Categoría estable de error, poblada SOLO cuando status = FAILED (Fase 6B,
-- PASO 27). Permite a la capa de orquestación decidir "reintentar o no" sin
-- tener que parsear el texto libre de error_summary, y permite health
-- checks/observabilidad agrupar fallos por causa sin exponer detalles
-- internos.
alter table public.sync_runs
  add column error_category text
    check (error_category is null or error_category in (
      'WORKERA_AUTH',
      'WORKERA_RATE_LIMIT',
      'WORKERA_TIMEOUT',
      'WORKERA_NETWORK',
      'WORKERA_SERVER',
      'WORKERA_PAYLOAD',
      'EMPLOYEE_RESOLUTION',
      'DATABASE',
      'CONCURRENCY',
      'CONFIGURATION'
    ));

comment on column public.sync_runs.error_category is
  'Categoría estable de fallo (Fase 6B, PASO 27), poblada solo cuando '
  'status=FAILED. Nunca contiene stack traces, secretos ni PII -- ver '
  'src/lib/sync/errors.ts classifySyncError().';

-- =============================================================================
-- 2) Concurrencia -- protección real a nivel de BASE DE DATOS (Fase 6B, PASO
--    10/11/12), no un lock separado.
-- =============================================================================
--
-- Decisión de diseño: se evaluó explícitamente una tabla-mutex dedicada
-- (`sync_locks` + `pg_advisory_lock`/UPSERT atómico) antes de escribir esta
-- versión, y se descartó tras confirmarlo con una prueba real: el propio
-- `syncWorkeraAttendance` (Fase 6A, src/lib/sync/workera-attendance-sync.ts)
-- YA inserta su propia fila `sync_runs` con status='RUNNING' como parte de
-- su flujo normal, antes de cualquier escritura de negocio. Un mutex
-- separado sería una SEGUNDA fuente de verdad de concurrencia, redundante
-- con esa inserción y con el riesgo real de desincronizarse de ella (ej. el
-- lock se libera pero el sync_run real sigue RUNNING, o viceversa).
--
-- En su lugar, este índice único parcial convierte esa inserción YA
-- EXISTENTE en el mecanismo de exclusión mutua: a lo sumo una fila RUNNING
-- por rango de fechas exacto en cualquier momento. Dos procesos que intenten
-- iniciar un sync para el mismo día compiten por la MISMA fila de índice --
-- Postgres serializa esa competencia internamente (exactamente la garantía
-- de atomicidad que pedía un advisory lock, sin necesitar una tabla nueva ni
-- afinidad de conexión, que no existe de todas formas sobre PostgREST/un
-- pooler en modo transacción). El segundo INSERT falla con `23505` -- la
-- capa de aplicación (src/lib/sync/scheduler.ts) traduce eso a
-- ALREADY_RUNNING.
create unique index sync_runs_no_concurrent_running_key
  on public.sync_runs (target_period_start, target_period_end)
  where status = 'RUNNING';

comment on index public.sync_runs_no_concurrent_running_key is
  'A lo sumo un sync_run RUNNING por rango de fechas exacto -- ES el '
  'mecanismo de concurrencia de Fase 6B (no una tabla de lock separada). Un '
  'segundo INSERT para el mismo rango falla con 23505; la capa de '
  'aplicación lo traduce a ALREADY_RUNNING.';

-- Recuperación de locks huérfanos (Fase 6B, PASO 20/25: un proceso caído -- '
-- crash de la función serverless, deployment matado a mitad de camino -- no
-- puede dejar una fila RUNNING bloqueando el día para siempre). Se invoca al
-- INICIO de cada intento de sync, antes de competir por el índice único de
-- arriba: cualquier fila RUNNING más vieja que el umbral se marca FAILED con
-- error_category='CONCURRENCY', liberando el rango para un intento nuevo.
create or replace function public.reclaim_stale_workera_sync_runs(
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count integer;
begin
  update public.sync_runs
    set status = 'FAILED',
        finished_at = now(),
        error_category = 'CONCURRENCY',
        error_summary = jsonb_build_object(
          'reason', 'STALE_RUNNING_RECLAIMED',
          'started_at', started_at
        )
  where status = 'RUNNING'
    and started_at < now() - make_interval(secs => p_stale_after_seconds);

  get diagnostics v_row_count = row_count;
  return v_row_count;
end;
$$;

comment on function public.reclaim_stale_workera_sync_runs(integer) is
  'Marca FAILED cualquier sync_run RUNNING más viejo que p_stale_after_seconds '
  '(proceso caído sin terminar limpio). Devuelve cuántas filas reclamó. '
  'Se invoca al inicio de cada intento, antes del INSERT que compite por '
  'sync_runs_no_concurrent_running_key (Fase 6B).';

revoke all on function public.reclaim_stale_workera_sync_runs(integer) from public;
grant execute on function public.reclaim_stale_workera_sync_runs(integer) to service_role;
