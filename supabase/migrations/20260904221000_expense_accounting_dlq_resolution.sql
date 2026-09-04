-- GESTORA Rendiciones Fase 4B: DLQ y reconciliación humana de salidas
-- contables fallidas. Un segundo responsable decide; el sistema nunca asume
-- si un timeout creó o no un asiento en el ERP.

alter table public.expense_accounting_exports
  add column manual_replay_count integer not null default 0
    check (manual_replay_count between 0 and 3);

create index expense_accounting_exports_failed_company_idx
  on public.expense_accounting_exports(company_id, updated_at desc)
  where status = 'FAILED';

alter table public.expense_accounting_export_events
  drop constraint expense_accounting_export_events_event_type_check;
alter table public.expense_accounting_export_events
  add constraint expense_accounting_export_events_event_type_check check (
    event_type in (
      'QUEUED','CLAIMED','LEASE_EXPIRED','SUCCEEDED','RETRY_SCHEDULED',
      'FAILED','CANCELLED','REQUEUED','MANUAL_CONFIRMED'
    )
  );

create or replace function public.get_expense_accounting_company_health(
  p_company_id uuid
)
returns table (
  queued_count bigint,
  retry_count bigint,
  processing_count bigint,
  failed_count bigint,
  cancelled_count bigint,
  succeeded_count bigint,
  stale_processing_count bigint,
  stale_ready_count bigint,
  paused_backlog_count bigint,
  oldest_ready_at timestamptz,
  requires_human_review boolean,
  requires_worker_recovery boolean,
  requires_attention boolean,
  paused_with_backlog boolean,
  enqueue_enabled boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false)
     or (
       not coalesce(public.has_company_permission(p_company_id, 'expenses.reconcile'), false)
       and not coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false)
     ) then
    raise exception 'Tu rol no permite ver la operación contable.' using errcode = '42501';
  end if;

  return query
  with runtime as (
    select coalesce((
      select cm.status in ('ENABLED', 'PILOT')
        and cm.settings @> '{"expense_accounting_export_enabled": true}'::jsonb
        and c.active
        and c.status in ('ACTIVE', 'ONBOARDING')
      from public.company_modules cm
      join public.companies c on c.id = cm.company_id
      where cm.company_id = p_company_id and cm.module_key = 'expenses'
    ), false) as enqueue_enabled
  )
  select
    count(*) filter (where e.status = 'QUEUED')::bigint,
    count(*) filter (where e.status = 'RETRY')::bigint,
    count(*) filter (where e.status = 'PROCESSING')::bigint,
    count(*) filter (where e.status = 'FAILED')::bigint,
    count(*) filter (where e.status = 'CANCELLED')::bigint,
    count(*) filter (where e.status = 'SUCCEEDED')::bigint,
    count(*) filter (
      where e.status = 'PROCESSING' and e.lease_expires_at <= now()
    )::bigint,
    count(*) filter (
      where r.enqueue_enabled
        and e.status in ('QUEUED','RETRY')
        and e.available_at <= now() - interval '30 minutes'
    )::bigint,
    count(*) filter (
      where not r.enqueue_enabled and e.status in ('QUEUED','RETRY')
    )::bigint,
    min(e.available_at) filter (
      where e.status in ('QUEUED','RETRY') and e.available_at <= now()
    ),
    count(*) filter (where e.status = 'FAILED') > 0,
    (
      count(*) filter (
        where e.status = 'PROCESSING' and e.lease_expires_at <= now()
      ) > 0
      or count(*) filter (
        where r.enqueue_enabled
          and e.status in ('QUEUED','RETRY')
          and e.available_at <= now() - interval '30 minutes'
      ) > 0
    ),
    (
      count(*) filter (where e.status = 'FAILED') > 0
      or count(*) filter (
        where e.status = 'PROCESSING' and e.lease_expires_at <= now()
      ) > 0
      or count(*) filter (
        where r.enqueue_enabled
          and e.status in ('QUEUED','RETRY')
          and e.available_at <= now() - interval '30 minutes'
      ) > 0
    ),
    not r.enqueue_enabled
      and count(*) filter (where e.status in ('QUEUED','RETRY')) > 0,
    r.enqueue_enabled
  from runtime r
  left join public.expense_accounting_exports e on e.company_id = p_company_id
  group by r.enqueue_enabled;
end;
$$;

create or replace function public.resolve_expense_accounting_export(
  p_company_id uuid,
  p_export_id uuid,
  p_resolution text,
  p_reason text,
  p_external_reference text default null,
  p_confirm_not_exported boolean default false
)
returns public.expense_accounting_export_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_job public.expense_accounting_exports%rowtype;
  v_event_type text;
  v_next_status public.expense_accounting_export_status;
  v_external_reference text := nullif(btrim(p_external_reference), '');
begin
  if v_actor_id is null
     or not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false)
     or not coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false) then
    raise exception 'Tu rol no permite resolver fallos contables.' using errcode = '42501';
  end if;
  if p_resolution is null
     or p_resolution not in ('REQUEUE', 'CONFIRM_SUCCEEDED', 'CANCEL') then
    raise exception 'Resolución contable inválida.' using errcode = '23514';
  end if;
  if p_reason is null
     or char_length(btrim(p_reason)) not between 8 and 240
     or p_reason ~ '[[:cntrl:]]' then
    raise exception 'El motivo de resolución debe tener entre 8 y 240 caracteres.' using errcode = '23514';
  end if;

  select e.* into v_job
  from public.expense_accounting_exports e
  where e.company_id = p_company_id and e.id = p_export_id
  for update;
  if not found then
    raise exception 'Salida contable no encontrada.' using errcode = 'P0002';
  end if;

  -- La fila pudo quedar bloqueada por otro operador. Revalida permiso y estado
  -- después de adquirir el lock antes de cualquier transición financiera.
  if not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false)
     or not coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false) then
    raise exception 'Tu rol no permite resolver fallos contables.' using errcode = '42501';
  end if;
  if v_job.status <> 'FAILED' then
    raise exception 'Solo una salida fallida puede resolverse manualmente.' using errcode = '23514';
  end if;
  if v_job.requested_by = v_actor_id then
    raise exception 'La resolución requiere un segundo responsable.' using errcode = '23514';
  end if;

  if p_resolution = 'REQUEUE' then
    if not coalesce((
      select cm.status in ('ENABLED', 'PILOT')
        and cm.settings @> '{"expense_accounting_export_enabled": true}'::jsonb
      from public.company_modules cm
      where cm.company_id = p_company_id and cm.module_key = 'expenses'
    ), false) then
      raise exception 'La integración contable está pausada para esta empresa.'
        using errcode = '55000';
    end if;
    if p_confirm_not_exported is not true or v_external_reference is not null then
      raise exception 'Confirma que el asiento no existe antes de reintentar.' using errcode = '23514';
    end if;
    if v_job.manual_replay_count >= 3 then
      raise exception 'La salida alcanzó el máximo de reintentos manuales.' using errcode = '23514';
    end if;
    update public.expense_accounting_exports e
    set status = 'QUEUED', attempt_count = 0,
        manual_replay_count = e.manual_replay_count + 1,
        available_at = clock_timestamp(), lease_token = null,
        lease_expires_at = null, external_reference = null,
        exported_at = null, last_error_code = null, last_error_summary = null
    where e.id = v_job.id;
    v_next_status := 'QUEUED';
    v_event_type := 'REQUEUED';
  elsif p_resolution = 'CONFIRM_SUCCEEDED' then
    if p_confirm_not_exported is not false
       or v_external_reference is null
       or char_length(v_external_reference) not between 1 and 160
       or v_external_reference ~ '[[:cntrl:]]' then
      raise exception 'Ingresa una referencia externa válida para confirmar.' using errcode = '23514';
    end if;
    update public.expense_accounting_exports e
    set status = 'SUCCEEDED', external_reference = v_external_reference,
        exported_at = clock_timestamp(), lease_token = null,
        lease_expires_at = null, last_error_code = null, last_error_summary = null
    where e.id = v_job.id;
    v_next_status := 'SUCCEEDED';
    v_event_type := 'MANUAL_CONFIRMED';
  else
    if p_confirm_not_exported is not true or v_external_reference is not null then
      raise exception 'Confirma que el asiento no existe antes de cancelar.' using errcode = '23514';
    end if;
    update public.expense_accounting_exports e
    set status = 'CANCELLED', lease_token = null, lease_expires_at = null,
        external_reference = null, exported_at = null,
        last_error_code = 'MANUAL_CANCELLED',
        last_error_summary = btrim(p_reason)
    where e.id = v_job.id;
    v_next_status := 'CANCELLED';
    v_event_type := 'CANCELLED';
  end if;

  insert into public.expense_accounting_export_events (
    company_id, export_id, actor_id, event_type, metadata
  ) values (
    v_job.company_id, v_job.id, v_actor_id, v_event_type,
    jsonb_strip_nulls(jsonb_build_object(
      'resolution', p_resolution,
      'reason', btrim(p_reason),
      'external_reference', v_external_reference,
      'manual_replay_count', case when p_resolution = 'REQUEUE'
        then v_job.manual_replay_count + 1 else v_job.manual_replay_count end
    ))
  );
  insert into public.expense_audit_events (
    company_id, report_id, actor_id, event_type, metadata
  ) values (
    v_job.company_id, v_job.report_id, v_actor_id,
    case p_resolution
      when 'REQUEUE' then 'ACCOUNTING_EXPORT_REQUEUED'
      when 'CONFIRM_SUCCEEDED' then 'ACCOUNTING_EXPORT_MANUALLY_CONFIRMED'
      else 'ACCOUNTING_EXPORT_CANCELLED' end,
    jsonb_build_object('export_id', v_job.id, 'reason', btrim(p_reason))
  );

  return v_next_status;
end;
$$;

revoke all on function public.get_expense_accounting_company_health(uuid)
  from public, anon;
grant execute on function public.get_expense_accounting_company_health(uuid)
  to authenticated;
revoke all on function public.resolve_expense_accounting_export(
  uuid, uuid, text, text, text, boolean
) from public, anon;
grant execute on function public.resolve_expense_accounting_export(
  uuid, uuid, text, text, text, boolean
) to authenticated;

comment on function public.get_expense_accounting_company_health(uuid) is
  'Salud tenant-aware de la cola contable; exige conciliación o gestión y no expone payloads.';
comment on function public.resolve_expense_accounting_export(uuid, uuid, text, text, text, boolean) is
  'Resolución maker-checker de la DLQ: reencola tras confirmar ausencia, confirma referencia externa o cancela.';
