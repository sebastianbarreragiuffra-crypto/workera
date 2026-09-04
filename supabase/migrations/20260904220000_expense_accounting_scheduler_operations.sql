-- GESTORA Rendiciones Fase 4A: operación durable del worker contable.
-- Registra cada ejecución, evita schedulers concurrentes, recupera runs
-- abandonados y expone un snapshot mínimo para watchdogs server-side.

create type public.expense_accounting_worker_run_status as enum (
  'RUNNING', 'SUCCEEDED', 'FAILED'
);

create table public.expense_accounting_worker_runs (
  id              uuid primary key default gen_random_uuid(),
  run_token       uuid not null default gen_random_uuid(),
  trigger_source  text not null check (trigger_source in ('CRON', 'AFTER_RESPONSE', 'MANUAL')),
  status          public.expense_accounting_worker_run_status not null default 'RUNNING',
  claimed_count   integer not null default 0 check (claimed_count between 0 and 10000),
  succeeded_count integer not null default 0 check (succeeded_count between 0 and 10000),
  retried_count   integer not null default 0 check (retried_count between 0 and 10000),
  failed_count    integer not null default 0 check (failed_count between 0 and 10000),
  error_code      text check (error_code is null or char_length(error_code) between 1 and 80),
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint expense_accounting_worker_runs_state_chk check (
    (status = 'RUNNING' and completed_at is null and error_code is null)
    or (status = 'SUCCEEDED' and completed_at is not null and error_code is null)
    or (status = 'FAILED' and completed_at is not null and error_code is not null)
  ),
  constraint expense_accounting_worker_runs_summary_chk check (
    succeeded_count + retried_count + failed_count <= claimed_count
  )
);

-- Solo una ejecución global puede reclamar la cola a la vez. SKIP LOCKED ya
-- evita duplicados por job; este índice además limita costo y simplifica el
-- watchdog cuando Vercel entrega dos invocaciones cercanas.
create unique index expense_accounting_worker_one_running_idx
  on public.expense_accounting_worker_runs(status)
  where status = 'RUNNING';
create index expense_accounting_worker_runs_started_idx
  on public.expense_accounting_worker_runs(started_at desc);
create index expense_accounting_worker_runs_completed_idx
  on public.expense_accounting_worker_runs(completed_at desc)
  where completed_at is not null;

alter table public.expense_accounting_worker_runs enable row level security;

create or replace function public.start_expense_accounting_worker_run(
  p_trigger_source text
)
returns table (
  run_id uuid,
  run_token uuid,
  acquired boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_run_token uuid;
begin
  if p_trigger_source is null
     or p_trigger_source not in ('CRON', 'AFTER_RESPONSE', 'MANUAL') then
    raise exception 'Origen de ejecución contable inválido.' using errcode = '23514';
  end if;

  -- Serializa solamente la reserva del run. El trabajo de red ocurre fuera de
  -- esta transacción y queda protegido por run_token + leases por exportación.
  perform pg_advisory_xact_lock(hashtextextended('expense-accounting-worker-run', 0));

  -- maxDuration del handler es 60 s. Diez minutos deja margen y permite que
  -- una ejecución cortada por la plataforma no bloquee la cola para siempre.
  update public.expense_accounting_worker_runs r
  set status = 'FAILED', completed_at = clock_timestamp(),
      error_code = 'WORKER_ABANDONED'
  where r.status = 'RUNNING'
    and r.started_at <= clock_timestamp() - interval '10 minutes';

  if exists (
    select 1 from public.expense_accounting_worker_runs r
    where r.status = 'RUNNING'
  ) then
    run_id := null;
    run_token := null;
    acquired := false;
    return next;
    return;
  end if;

  insert into public.expense_accounting_worker_runs (trigger_source)
  values (p_trigger_source)
  returning id, expense_accounting_worker_runs.run_token
    into v_run_id, v_run_token;

  -- Retención acotada y por lotes; nunca borra ejecuciones activas.
  delete from public.expense_accounting_worker_runs r
  where r.id in (
    select old.id
    from public.expense_accounting_worker_runs old
    where old.completed_at < clock_timestamp() - interval '90 days'
    order by old.completed_at
    limit 500
  );

  run_id := v_run_id;
  run_token := v_run_token;
  acquired := true;
  return next;
end;
$$;

create or replace function public.complete_expense_accounting_worker_run(
  p_run_id uuid,
  p_run_token uuid,
  p_succeeded boolean,
  p_claimed_count integer,
  p_succeeded_count integer,
  p_retried_count integer,
  p_failed_count integer,
  p_error_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_run_id is null or p_run_token is null or p_succeeded is null
     or p_claimed_count is null or p_claimed_count not between 0 and 10000
     or p_succeeded_count is null or p_succeeded_count not between 0 and 10000
     or p_retried_count is null or p_retried_count not between 0 and 10000
     or p_failed_count is null or p_failed_count not between 0 and 10000
     or p_succeeded_count + p_retried_count + p_failed_count > p_claimed_count then
    raise exception 'Resumen de ejecución contable inválido.' using errcode = '23514';
  end if;
  if p_succeeded and p_succeeded_count + p_retried_count + p_failed_count <> p_claimed_count then
    raise exception 'Una ejecución exitosa debe cerrar todos sus trabajos.' using errcode = '23514';
  end if;
  if (p_succeeded and p_error_code is not null)
     or (not p_succeeded and (
       p_error_code is null
       or char_length(btrim(p_error_code)) not between 1 and 80
       or p_error_code ~ '[[:cntrl:]]'
     )) then
    raise exception 'Código de cierre contable inválido.' using errcode = '23514';
  end if;

  update public.expense_accounting_worker_runs r
  set status = case when p_succeeded
        then 'SUCCEEDED'::public.expense_accounting_worker_run_status
        else 'FAILED'::public.expense_accounting_worker_run_status end,
      claimed_count = p_claimed_count,
      succeeded_count = p_succeeded_count,
      retried_count = p_retried_count,
      failed_count = p_failed_count,
      error_code = case when p_succeeded then null else btrim(p_error_code) end,
      completed_at = clock_timestamp()
  where r.id = p_run_id and r.run_token = p_run_token and r.status = 'RUNNING';

  if not found then
    raise exception 'Token de ejecución contable inválido o ya cerrado.' using errcode = '23514';
  end if;
end;
$$;

create or replace function public.get_expense_accounting_worker_health(
  p_stale_after_seconds integer default 93600
)
returns table (
  queued_count bigint,
  retry_count bigint,
  processing_count bigint,
  failed_count bigint,
  stale_processing_count bigint,
  oldest_ready_at timestamptz,
  last_run_status public.expense_accounting_worker_run_status,
  last_run_started_at timestamptz,
  last_run_completed_at timestamptz,
  last_success_completed_at timestamptz,
  scheduler_stale boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_stale_after_seconds is null or p_stale_after_seconds not between 3600 and 604800 then
    raise exception 'Umbral de watchdog inválido.' using errcode = '23514';
  end if;

  return query
  with queue as (
    select
      count(*) filter (where e.status = 'QUEUED')::bigint as queued_count,
      count(*) filter (where e.status = 'RETRY')::bigint as retry_count,
      count(*) filter (where e.status = 'PROCESSING')::bigint as processing_count,
      count(*) filter (where e.status = 'FAILED')::bigint as failed_count,
      count(*) filter (
        where e.status = 'PROCESSING' and e.lease_expires_at <= now()
      )::bigint as stale_processing_count,
      min(e.available_at) filter (
        where e.status in ('QUEUED', 'RETRY') and e.available_at <= now()
      ) as oldest_ready_at
    from public.expense_accounting_exports e
  ), latest as (
    select r.status, r.started_at, r.completed_at
    from public.expense_accounting_worker_runs r
    where r.trigger_source = 'CRON'
    order by r.started_at desc, r.id desc
    limit 1
  ), success as (
    select max(r.completed_at) as completed_at
    from public.expense_accounting_worker_runs r
    where r.status = 'SUCCEEDED' and r.trigger_source = 'CRON'
  )
  select q.queued_count, q.retry_count, q.processing_count, q.failed_count,
         q.stale_processing_count, q.oldest_ready_at,
         l.status, l.started_at, l.completed_at, s.completed_at,
         (
           s.completed_at is null
           or s.completed_at < now() - make_interval(secs => p_stale_after_seconds)
         )
  from queue q
  left join latest l on true
  cross join success s;
end;
$$;

-- El runtime no necesita acceso directo al ledger ni a sus tokens. Todas las
-- operaciones pasan por RPC SECURITY DEFINER con contratos mínimos.
revoke all on table public.expense_accounting_worker_runs
  from public, anon, authenticated, service_role;
revoke all on table public.expense_accounting_exports
  from service_role;
revoke all on table public.expense_accounting_export_events
  from service_role;
revoke all on sequence public.expense_accounting_export_events_id_seq
  from service_role;

revoke all on function public.start_expense_accounting_worker_run(text)
  from public, anon, authenticated;
revoke all on function public.complete_expense_accounting_worker_run(
  uuid, uuid, boolean, integer, integer, integer, integer, text
) from public, anon, authenticated;
revoke all on function public.get_expense_accounting_worker_health(integer)
  from public, anon, authenticated;
grant execute on function public.start_expense_accounting_worker_run(text)
  to service_role;
grant execute on function public.complete_expense_accounting_worker_run(
  uuid, uuid, boolean, integer, integer, integer, integer, text
) to service_role;
grant execute on function public.get_expense_accounting_worker_health(integer)
  to service_role;

comment on table public.expense_accounting_worker_runs is
  'Heartbeat durable del scheduler contable. No contiene payload financiero, PII ni secretos.';
comment on function public.start_expense_accounting_worker_run(text) is
  'Reserva un único run, recupera ejecuciones abandonadas y entrega token de fencing solo a service_role.';
comment on function public.get_expense_accounting_worker_health(integer) is
  'Snapshot global server-only para cron/watchdog; la salud del scheduler usa exclusivamente heartbeats CRON.';
