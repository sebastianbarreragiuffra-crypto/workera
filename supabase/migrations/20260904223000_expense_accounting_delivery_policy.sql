-- GESTORA Rendiciones Fase 4B: política forward-only de entrega contable.
--
-- Esta migración redefine funciones creadas en 20260904200000 para que una
-- base que ya aplicó el outbox reciba los mismos guards que un reset limpio.
-- Solo RATE_LIMIT es reintentable automáticamente: cualquier timeout o código
-- desconocido puede esconder un asiento creado y termina en revisión humana.

create or replace function public.claim_expense_accounting_exports(p_limit integer default 10)
returns table (
  export_id uuid,
  company_id uuid,
  idempotency_key text,
  payload jsonb,
  attempt_count integer,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.expense_accounting_exports%rowtype;
begin
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'Límite de lote inválido.' using errcode = '23514';
  end if;

  with expired as (
    update public.expense_accounting_exports e
    set status = case when e.attempt_count >= e.max_attempts then 'FAILED'::public.expense_accounting_export_status else 'RETRY'::public.expense_accounting_export_status end,
        available_at = case when e.attempt_count >= e.max_attempts then e.available_at else clock_timestamp() end,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'LEASE_EXPIRED',
        last_error_summary = 'El worker no cerró el intento antes del vencimiento.'
    where e.status = 'PROCESSING' and e.lease_expires_at <= clock_timestamp()
    returning e.company_id, e.id,
      case when e.attempt_count >= e.max_attempts then 'FAILED' else 'LEASE_EXPIRED' end as event_type
  )
  insert into public.expense_accounting_export_events (company_id, export_id, event_type)
  select x.company_id, x.id, x.event_type from expired x;

  for v_job in
    select e.*
    from public.expense_accounting_exports e
    where e.status in ('QUEUED','RETRY')
      and e.available_at <= clock_timestamp()
      and exists (
        select 1
        from public.company_modules cm
        join public.companies c on c.id = cm.company_id
        where cm.company_id = e.company_id
          and cm.module_key = 'expenses'
          and cm.status in ('ENABLED', 'PILOT')
          and cm.settings @> '{"expense_accounting_export_enabled": true}'::jsonb
          and c.active
          and c.status in ('ACTIVE', 'ONBOARDING')
      )
    order by e.available_at, e.requested_at
    for update skip locked
    limit p_limit
  loop
    update public.expense_accounting_exports e
    set status = 'PROCESSING', attempt_count = e.attempt_count + 1,
        lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes',
        last_error_code = null, last_error_summary = null
    where e.id = v_job.id
    returning e.* into v_job;

    insert into public.expense_accounting_export_events (
      company_id, export_id, event_type, metadata
    ) values (
      v_job.company_id, v_job.id, 'CLAIMED', jsonb_build_object('attempt', v_job.attempt_count)
    );

    export_id := v_job.id;
    company_id := v_job.company_id;
    idempotency_key := v_job.idempotency_key;
    payload := v_job.payload;
    attempt_count := v_job.attempt_count;
    lease_token := v_job.lease_token;
    return next;
  end loop;
end;
$$;

create or replace function public.complete_expense_accounting_export(
  p_export_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_external_reference text default null,
  p_error_code text default null,
  p_error_summary text default null,
  p_retryable boolean default false
)
returns public.expense_accounting_export_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.expense_accounting_exports%rowtype;
  v_next_status public.expense_accounting_export_status;
  v_delay integer;
  v_error_code text := nullif(btrim(p_error_code), '');
  v_safe_retry boolean := false;
begin
  select e.* into v_job
  from public.expense_accounting_exports e
  where e.id = p_export_id and e.status = 'PROCESSING'
    and e.lease_token = p_lease_token and e.lease_expires_at > clock_timestamp()
  for update;
  if not found then
    raise exception 'Lease contable inválido o vencido.' using errcode = '23514';
  end if;

  if p_succeeded then
    if p_external_reference is null or char_length(btrim(p_external_reference)) not between 1 and 160 then
      raise exception 'Referencia externa inválida.' using errcode = '23514';
    end if;
    update public.expense_accounting_exports e
    set status = 'SUCCEEDED', lease_token = null, lease_expires_at = null,
        external_reference = btrim(p_external_reference), exported_at = clock_timestamp(),
        last_error_code = null, last_error_summary = null
    where e.id = p_export_id;
    insert into public.expense_accounting_export_events (company_id, export_id, event_type, metadata)
    values (v_job.company_id, v_job.id, 'SUCCEEDED', jsonb_build_object('attempt', v_job.attempt_count));
    return 'SUCCEEDED'::public.expense_accounting_export_status;
  end if;

  if v_error_code is null or char_length(v_error_code) not between 1 and 80
     or v_error_code ~ '[[:cntrl:]]'
     or p_error_summary is null
     or char_length(btrim(p_error_summary)) not between 1 and 240
     or p_error_summary ~ '[[:cntrl:]]' then
    raise exception 'Error contable inválido.' using errcode = '23514';
  end if;

  -- RATE_LIMIT demuestra rechazo previo a cualquier efecto financiero. Los
  -- timeouts, fallos de red y códigos nuevos quedan fail-closed en la DLQ.
  v_safe_retry := p_retryable is true and v_error_code in ('RATE_LIMIT');
  v_next_status := case
    when v_safe_retry and v_job.attempt_count < v_job.max_attempts
      then 'RETRY'::public.expense_accounting_export_status
    else 'FAILED'::public.expense_accounting_export_status
  end;
  v_delay := least(3600, 30 * (2 ^ greatest(v_job.attempt_count - 1, 0))::integer);

  update public.expense_accounting_exports e
  set status = v_next_status, lease_token = null, lease_expires_at = null,
      available_at = case when v_next_status = 'RETRY' then clock_timestamp() + make_interval(secs => v_delay) else e.available_at end,
      last_error_code = v_error_code, last_error_summary = btrim(p_error_summary)
  where e.id = p_export_id;
  insert into public.expense_accounting_export_events (company_id, export_id, event_type, metadata)
  values (
    v_job.company_id, v_job.id,
    case when v_next_status = 'RETRY' then 'RETRY_SCHEDULED' else 'FAILED' end,
    jsonb_build_object(
      'attempt', v_job.attempt_count,
      'error_code', v_error_code,
      'retry_delay_seconds', case when v_next_status = 'RETRY' then v_delay else null end
    )
  );
  return v_next_status;
end;
$$;

-- Repite explícitamente el mínimo privilegio para upgrades desde el outbox
-- original, que otorgaba acceso directo a las tablas al runtime.
revoke all on table public.expense_accounting_exports from service_role;
revoke all on table public.expense_accounting_export_events from service_role;
revoke all on sequence public.expense_accounting_export_events_id_seq from service_role;
revoke all on function public.queue_expense_accounting_export(uuid, uuid) from service_role;
revoke all on function public.claim_expense_accounting_exports(integer)
  from public, anon, authenticated;
revoke all on function public.complete_expense_accounting_export(
  uuid, uuid, boolean, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.claim_expense_accounting_exports(integer)
  to service_role;
grant execute on function public.complete_expense_accounting_export(
  uuid, uuid, boolean, text, text, text, boolean
) to service_role;

comment on function public.claim_expense_accounting_exports(integer) is
  'Reclama únicamente backlog de empresas activas con el piloto contable habilitado.';
comment on function public.complete_expense_accounting_export(uuid, uuid, boolean, text, text, text, boolean) is
  'Cierra una salida con fencing; solo RATE_LIMIT puede generar retry automático.';
