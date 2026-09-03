-- GESTORA Rendiciones EX-13 (parte 2): indicadores operativos de riesgo y
-- cumplimiento. Estas señales priorizan revisión humana; no constituyen una
-- determinación de fraude ni una evaluación de cumplimiento legal.

create index if not exists expense_reports_company_resolved_idx
  on public.expense_reports(company_id, resolved_at desc)
  where status in ('APPROVED', 'REJECTED', 'PAID');

create index if not exists expense_reports_company_active_created_idx
  on public.expense_reports(company_id, created_at desc)
  where status <> 'CANCELLED';

create or replace function public.expense_policy_category_limits_valid(p_rules jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_limits jsonb := p_rules -> 'categoryLimits';
  v_value jsonb;
  v_text text;
begin
  if v_limits is null then
    return true;
  end if;
  if pg_catalog.jsonb_typeof(v_limits) <> 'object'
     or pg_catalog.octet_length(v_limits::text) > 65536 then
    return false;
  end if;

  for v_value in select value from pg_catalog.jsonb_each(v_limits)
  loop
    if pg_catalog.jsonb_typeof(v_value) <> 'number' then
      return false;
    end if;
    v_text := v_value #>> '{}';
    if pg_catalog.length(v_text) > 18
       or v_text !~ '^[0-9]{1,14}([.][0-9]{1,2})?$'
       or v_text::numeric <= 0
       or v_text::numeric > 99999999999999.99 then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

alter table public.expense_policies
  add constraint expense_policies_category_limits_valid
  check (public.expense_policy_category_limits_valid(rules));

revoke all on function public.expense_policy_category_limits_valid(jsonb) from public, anon;
grant execute on function public.expense_policy_category_limits_valid(jsonb) to authenticated, service_role;

create or replace function public.get_expense_indicators(
  p_company_id uuid,
  p_window_days integer default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_since timestamptz;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_company_id is null then
    raise exception 'company_id es obligatorio.' using errcode = '22004';
  end if;
  if p_window_days is null or p_window_days not between 1 and 365 then
    raise exception 'La ventana de indicadores debe estar entre 1 y 365 días.' using errcode = '22023';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or not (
       public.has_company_permission(p_company_id, 'expenses.read')
       or public.has_company_permission(p_company_id, 'expenses.approve')
       or public.has_company_permission(p_company_id, 'expenses.manage')
     ) then
    raise exception 'Tu rol no permite ver indicadores de esta empresa.' using errcode = '42501';
  end if;

  v_since := pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_window_days);

  with
  resolved_reports as (
    select er.id, er.status, er.submitted_at, er.resolved_at
    from public.expense_reports er
    where er.company_id = p_company_id
      and er.status in ('APPROVED', 'REJECTED', 'PAID')
      and er.resolved_at >= v_since
  ),
  window_reports as (
    select er.id, er.status, er.policy_id
    from public.expense_reports er
    where er.company_id = p_company_id
      and er.created_at >= v_since
      and er.status <> 'CANCELLED'
  ),
  category_totals as (
    select
      coalesce(ec.name, 'Sin categoría') as category_name,
      ei.currency_code,
      sum(ei.total_amount) as total_amount,
      count(*)::integer as item_count
    from public.expense_items ei
    join resolved_reports rr on rr.id = ei.report_id
    left join public.expense_categories ec
      on ec.company_id = ei.company_id and ec.id = ei.category_id
    where ei.company_id = p_company_id
      and rr.status in ('APPROVED', 'PAID')
    group by coalesce(ec.name, 'Sin categoría'), ei.currency_code
  ),
  window_items as (
    select
      ei.id,
      ei.category_id,
      ei.total_amount,
      wr.policy_id,
      wr.status as report_status,
      coalesce(ec.requires_receipt, false) as requires_receipt,
      exists (
        select 1
        from public.expense_receipts receipt
        where receipt.company_id = p_company_id
          and receipt.item_id = ei.id
          and receipt.is_current
      ) as has_current_receipt
    from public.expense_items ei
    join window_reports wr on wr.id = ei.report_id
    left join public.expense_categories ec
      on ec.company_id = ei.company_id and ec.id = ei.category_id
    where ei.company_id = p_company_id
  ),
  receipt_coverage as (
    select
      count(*) filter (where wi.requires_receipt)::integer as required_count,
      count(*) filter (where wi.requires_receipt and wi.has_current_receipt)::integer as covered_count
    from window_items wi
  ),
  receipt_signals as (
    select
      count(*) filter (where receipt.duplicate_of_receipt_id is not null)::integer as duplicate_count,
      count(*) filter (
        where receipt.status = 'PROCESSED'
          and receipt.extraction ->> 'requiresHumanReview' = 'true'
          and coalesce(receipt.extraction -> 'humanReview' ->> 'decision', '') = ''
      )::integer as review_pending_count,
      count(*) filter (where receipt.status = 'FAILED')::integer as failed_count
    from public.expense_receipts receipt
    join window_reports wr on wr.id = receipt.report_id
    where receipt.company_id = p_company_id
      and receipt.is_current
  ),
  policy_signals as (
    select count(*)::integer as exceeded_count
    from window_items wi
    join public.expense_policies ep
      on ep.company_id = p_company_id and ep.id = wi.policy_id
    cross join lateral (
      select ep.rules -> 'categoryLimits' ->> wi.category_id::text as raw_limit
    ) configured_limit
    where wi.category_id is not null
      and wi.report_status in ('DRAFT', 'SUBMITTED', 'IN_REVIEW')
      and wi.total_amount > case
        when pg_catalog.length(configured_limit.raw_limit) <= 18
          and configured_limit.raw_limit ~ '^[0-9]{1,14}([.][0-9]{1,2})?$'
        then configured_limit.raw_limit::numeric
        else null
      end
  )
  select pg_catalog.jsonb_build_object(
    'windowDays', p_window_days,
    'resolvedCount', (select count(*)::integer from resolved_reports),
    'approvedCount', (
      select count(*)::integer from resolved_reports where status in ('APPROVED', 'PAID')
    ),
    'rejectedCount', (
      select count(*)::integer from resolved_reports where status = 'REJECTED'
    ),
    'avgApprovalHours', (
      select avg(extract(epoch from (resolved_at - submitted_at)) / 3600.0)
      from resolved_reports
      where submitted_at is not null and resolved_at is not null
    ),
    'categoryBreakdown', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'categoryName', ct.category_name,
          'currencyCode', ct.currency_code,
          'totalAmount', ct.total_amount,
          'itemCount', ct.item_count
        ) order by ct.total_amount desc, ct.category_name, ct.currency_code
      )
      from category_totals ct
    ), '[]'::jsonb),
    'riskSignals', pg_catalog.jsonb_build_object(
      'duplicateReceipts', coalesce((select duplicate_count from receipt_signals), 0),
      'missingRequiredReceipts', (
        select count(*)::integer
        from window_items wi
        where wi.requires_receipt and not wi.has_current_receipt
      ),
      'ocrReviewPending', coalesce((select review_pending_count from receipt_signals), 0),
      'ocrFailures', coalesce((select failed_count from receipt_signals), 0),
      'policyLimitExceededItems', coalesce((select exceeded_count from policy_signals), 0),
      'receiptCoveragePercent', (
        select case
          when rc.required_count = 0 then null
          else pg_catalog.round(100.0 * rc.covered_count / rc.required_count)
        end
        from receipt_coverage rc
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_expense_indicators(uuid, integer) is
  'Entrega agregados tenant-aware de Rendiciones y señales operativas para revisión humana. No determina fraude ni cumplimiento legal.';

revoke all on function public.get_expense_indicators(uuid, integer) from public, anon;
grant execute on function public.get_expense_indicators(uuid, integer) to authenticated;
