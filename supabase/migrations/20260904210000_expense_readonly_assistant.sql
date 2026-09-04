-- GESTORA Rendiciones Fase 6: asistente operativo reproducible y de solo
-- lectura. No recibe texto libre, no llama a un LLM y no puede aprobar,
-- conciliar, pagar ni modificar rendiciones. Cada respuesta se deriva de
-- consultas tenant-aware y conserva únicamente evidencia mínima.

create type public.expense_assistant_intent as enum (
  'ACTION_REQUIRED', 'SPEND_SUMMARY', 'PAYMENT_STATUS'
);

create table public.expense_assistant_queries (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  actor_id           uuid not null references public.profiles(id) on delete cascade,
  intent             public.expense_assistant_intent not null,
  window_days        smallint not null check (window_days in (7, 30, 90)),
  result             jsonb not null check (
    jsonb_typeof(result) = 'object'
    and result ?& array['schemaVersion','intent','windowDays','generatedAt','summary','citations']
    and jsonb_typeof(result -> 'summary') = 'object'
    and jsonb_typeof(result -> 'citations') = 'array'
    and jsonb_array_length(result -> 'citations') <= 12
    and pg_column_size(result) <= 65536
  ),
  result_sha256      text not null check (result_sha256 ~ '^[a-f0-9]{64}$'),
  citation_count     smallint not null check (citation_count between 0 and 12),
  created_at         timestamptz not null default now(),
  unique (company_id, id)
);

create index expense_assistant_queries_actor_idx
  on public.expense_assistant_queries(company_id, actor_id, created_at desc);

alter table public.expense_assistant_queries enable row level security;

create policy expense_assistant_queries_read_own
  on public.expense_assistant_queries for select to authenticated
  using (
    actor_id = auth.uid()
    and coalesce(public.company_has_module(company_id, 'expenses'), false)
    and coalesce(public.is_active_company_member(company_id), false)
    and (
      (
        intent = 'PAYMENT_STATUS'
        and (
          coalesce(public.has_company_permission(company_id, 'expenses.reconcile'), false)
          or coalesce(public.has_company_permission(company_id, 'expenses.manage'), false)
        )
      )
      or (
        intent in ('ACTION_REQUIRED', 'SPEND_SUMMARY')
        and (
          coalesce(public.has_company_permission(company_id, 'expenses.read'), false)
          or coalesce(public.has_company_permission(company_id, 'expenses.approve'), false)
          or coalesce(public.has_company_permission(company_id, 'expenses.manage'), false)
        )
      )
    )
  );

-- Un único RPC allowlisted calcula y registra la respuesta. El advisory lock
-- vuelve atómica la cuota por persona/empresa y la autorización se revalida
-- después de cualquier espera.
create or replace function public.run_expense_readonly_assistant(
  p_company_id uuid,
  p_intent public.expense_assistant_intent,
  p_window_days integer default 30
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_since timestamptz;
  v_result jsonb;
  v_query_id uuid;
  v_citation_count integer;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_company_id is null or p_intent is null then
    raise exception 'Empresa e intención son obligatorias.' using errcode = '22004';
  end if;
  if p_window_days is null or p_window_days not in (7, 30, 90) then
    raise exception 'La ventana debe ser 7, 30 o 90 días.' using errcode = '22023';
  end if;
  if not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false)
     or not (case
       when p_intent = 'PAYMENT_STATUS' then
         coalesce(public.has_company_permission(p_company_id, 'expenses.reconcile'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false)
       else
         coalesce(public.has_company_permission(p_company_id, 'expenses.read'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.approve'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false)
     end) then
    raise exception 'Tu rol no permite usar el asistente de esta empresa.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || v_actor_id::text || ':expense-assistant', 0
  ));

  if not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false)
     or not (case
       when p_intent = 'PAYMENT_STATUS' then
         coalesce(public.has_company_permission(p_company_id, 'expenses.reconcile'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false)
       else
         coalesce(public.has_company_permission(p_company_id, 'expenses.read'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.approve'), false)
         or coalesce(public.has_company_permission(p_company_id, 'expenses.manage'), false)
     end) then
    raise exception 'Tu rol no permite usar el asistente de esta empresa.' using errcode = '42501';
  end if;

  delete from public.expense_assistant_queries q
  where q.company_id = p_company_id and q.actor_id = v_actor_id
    and q.created_at < clock_timestamp() - interval '90 days';

  if (select count(*) from public.expense_assistant_queries q
      where q.company_id = p_company_id and q.actor_id = v_actor_id
        and q.created_at >= clock_timestamp() - interval '1 hour') >= 30 then
    raise exception 'Superaste el máximo de consultas del asistente por hora.' using errcode = '54000';
  end if;

  v_since := statement_timestamp() - make_interval(days => p_window_days);

  if p_intent = 'ACTION_REQUIRED' then
    with
    window_reports as (
      select er.id, er.reference_number, er.status, er.policy_id,
             er.created_at, er.submitted_at
      from public.expense_reports er
      where er.company_id = p_company_id
        and er.status <> 'CANCELLED'
        and coalesce(er.submitted_at, er.created_at) >= v_since
    ),
    missing_receipts as (
      select ei.report_id, ei.id as item_id
      from public.expense_items ei
      join window_reports wr on wr.id = ei.report_id
      join public.expense_categories ec
        on ec.company_id = p_company_id and ec.id = ei.category_id
      where ei.company_id = p_company_id
        and wr.status in ('DRAFT', 'SUBMITTED', 'IN_REVIEW')
        and ec.requires_receipt
        and not exists (
          select 1 from public.expense_receipts r
          where r.company_id = p_company_id and r.item_id = ei.id and r.is_current
        )
    ),
    receipt_signals as (
      select r.report_id, r.id as receipt_id, 'DUPLICATE_RECEIPT'::text as reason_code
      from public.expense_receipts r
      join window_reports wr on wr.id = r.report_id
      where r.company_id = p_company_id and r.is_current
        and r.duplicate_of_receipt_id is not null
      union all
      select r.report_id, r.id, 'OCR_FAILED'
      from public.expense_receipts r
      join window_reports wr on wr.id = r.report_id
      where r.company_id = p_company_id and r.is_current and r.status = 'FAILED'
      union all
      select r.report_id, r.id, 'OCR_REVIEW_PENDING'
      from public.expense_receipts r
      join window_reports wr on wr.id = r.report_id
      where r.company_id = p_company_id and r.is_current
        and r.status = 'PROCESSED'
        and r.extraction ->> 'requiresHumanReview' = 'true'
        and coalesce(r.extraction -> 'humanReview' ->> 'decision', '') = ''
    ),
    policy_exceeded as (
      select ei.report_id, ei.id as item_id
      from public.expense_items ei
      join window_reports wr on wr.id = ei.report_id
      join public.expense_policies ep
        on ep.company_id = p_company_id and ep.id = wr.policy_id
      cross join lateral (
        select ep.rules -> 'categoryLimits' ->> ei.category_id::text as raw_limit
      ) configured_limit
      where ei.company_id = p_company_id
        and wr.status in ('DRAFT', 'SUBMITTED', 'IN_REVIEW')
        and ei.category_id is not null
        and ei.total_amount > case
          when length(configured_limit.raw_limit) <= 18
            and configured_limit.raw_limit ~ '^[0-9]{1,14}([.][0-9]{1,2})?$'
          then configured_limit.raw_limit::numeric
          else null
        end
    ),
    report_reasons as (
      select wr.id as report_id, 'PENDING_APPROVAL'::text as reason_code
      from window_reports wr where wr.status in ('SUBMITTED', 'IN_REVIEW')
      union all
      select mr.report_id, 'MISSING_RECEIPT' from missing_receipts mr
      union all
      select rs.report_id, rs.reason_code from receipt_signals rs
      union all
      select pe.report_id, 'POLICY_LIMIT_EXCEEDED' from policy_exceeded pe
    ),
    grouped_reasons as (
      select rr.report_id, array_agg(distinct rr.reason_code order by rr.reason_code) as reason_codes
      from report_reasons rr
      where rr.reason_code is not null
      group by rr.report_id
    ),
    cited as (
      select wr.id, wr.reference_number, wr.status, gr.reason_codes,
             coalesce(wr.submitted_at, wr.created_at) as event_at
      from grouped_reasons gr
      join window_reports wr on wr.id = gr.report_id
      order by coalesce(wr.submitted_at, wr.created_at), wr.id
      limit 12
    )
    select jsonb_build_object(
      'summary', jsonb_build_object(
        'pendingApprovalReports', (select count(*)::integer from window_reports where status in ('SUBMITTED', 'IN_REVIEW')),
        'missingRequiredReceiptItems', (select count(*)::integer from missing_receipts),
        'duplicateReceipts', (select count(*)::integer from receipt_signals where reason_code = 'DUPLICATE_RECEIPT'),
        'ocrReviewPending', (select count(*)::integer from receipt_signals where reason_code = 'OCR_REVIEW_PENDING'),
        'ocrFailures', (select count(*)::integer from receipt_signals where reason_code = 'OCR_FAILED'),
        'policyLimitExceededItems', (select count(*)::integer from policy_exceeded)
      ),
      'citations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'reportId', c.id,
          'referenceNumber', c.reference_number,
          'status', c.status,
          'reasonCodes', to_jsonb(c.reason_codes)
        ) order by c.event_at, c.id)
        from cited c
      ), '[]'::jsonb)
    ) into v_result;

  elsif p_intent = 'SPEND_SUMMARY' then
    with
    resolved_reports as (
      select er.id, er.reference_number, er.status, er.currency_code,
             er.total_amount, coalesce(er.paid_at, er.resolved_at) as event_at
      from public.expense_reports er
      where er.company_id = p_company_id
        and er.status in ('APPROVED', 'PAID')
        and coalesce(er.paid_at, er.resolved_at) >= v_since
    ),
    totals as (
      select rr.currency_code, sum(rr.total_amount) as total_amount,
             count(*)::integer as report_count
      from resolved_reports rr group by rr.currency_code
    ),
    cited as (
      select * from resolved_reports order by event_at desc, id limit 12
    )
    select jsonb_build_object(
      'summary', jsonb_build_object(
        'reportCount', (select count(*)::integer from resolved_reports),
        'approvedReports', (select count(*)::integer from resolved_reports where status = 'APPROVED'),
        'paidReports', (select count(*)::integer from resolved_reports where status = 'PAID'),
        'totals', coalesce((select jsonb_agg(jsonb_build_object(
          'currencyCode', t.currency_code,
          'totalAmount', t.total_amount,
          'reportCount', t.report_count
        ) order by t.currency_code) from totals t), '[]'::jsonb)
      ),
      'citations', coalesce((select jsonb_agg(jsonb_build_object(
        'reportId', c.id,
        'referenceNumber', c.reference_number,
        'status', c.status,
        'reasonCodes', jsonb_build_array(case when c.status = 'PAID' then 'PAID_IN_WINDOW' else 'APPROVED_IN_WINDOW' end)
      ) order by c.event_at desc, c.id) from cited c), '[]'::jsonb)
    ) into v_result;

  elsif p_intent = 'PAYMENT_STATUS' then
    with
    approved_waiting as (
      select er.id, er.reference_number, er.status, er.currency_code,
             er.total_amount, er.resolved_at as event_at
      from public.expense_reports er
      where er.company_id = p_company_id and er.status = 'APPROVED'
        and er.resolved_at >= v_since
    ),
    paid_window as (
      select er.id, er.reference_number, er.status, er.currency_code,
             er.total_amount, er.paid_at as event_at
      from public.expense_reports er
      where er.company_id = p_company_id and er.status = 'PAID'
        and er.paid_at >= v_since
    ),
    paid_without_export as (
      select pw.* from paid_window pw
      where not exists (
        select 1 from public.expense_accounting_exports e
        where e.company_id = p_company_id and e.report_id = pw.id
      )
    ),
    accounting_signals as (
      select e.report_id,
        case when e.status = 'FAILED' then 'ACCOUNTING_FAILED' else 'ACCOUNTING_PENDING' end as reason_code,
        e.updated_at as event_at
      from public.expense_accounting_exports e
      where e.company_id = p_company_id
        and e.status in ('QUEUED', 'PROCESSING', 'RETRY', 'FAILED')
        and e.updated_at >= v_since
    ),
    awaiting_totals as (
      select aw.currency_code, sum(aw.total_amount) as total_amount,
             count(*)::integer as report_count
      from approved_waiting aw group by aw.currency_code
    ),
    paid_totals as (
      select pw.currency_code, sum(pw.total_amount) as total_amount,
             count(*)::integer as report_count
      from paid_window pw group by pw.currency_code
    ),
    report_reasons as (
      select aw.id as report_id, 'AWAITING_PAYMENT'::text as reason_code, aw.event_at from approved_waiting aw
      union all
      select pwe.id, 'ACCOUNTING_NOT_QUEUED', pwe.event_at from paid_without_export pwe
      union all
      select a.report_id, a.reason_code, a.event_at from accounting_signals a
    ),
    grouped_reasons as (
      select rr.report_id, array_agg(distinct rr.reason_code order by rr.reason_code) as reason_codes,
             max(rr.event_at) as event_at
      from report_reasons rr group by rr.report_id
    ),
    cited as (
      select er.id, er.reference_number, er.status, gr.reason_codes, gr.event_at
      from grouped_reasons gr
      join public.expense_reports er
        on er.company_id = p_company_id and er.id = gr.report_id
      order by gr.event_at desc nulls last, er.id
      limit 12
    )
    select jsonb_build_object(
      'summary', jsonb_build_object(
        'approvedAwaitingPayment', (select count(*)::integer from approved_waiting),
        'paidInWindow', (select count(*)::integer from paid_window),
        'unmatchedBankTransactions', (
          select count(*)::integer from public.expense_bank_transactions t
          where t.company_id = p_company_id and t.status = 'UNMATCHED'
            and t.transaction_date >= timezone('America/Santiago', statement_timestamp())::date - p_window_days
        ),
        'paidWithoutAccountingExport', (select count(*)::integer from paid_without_export),
        'accountingInProgress', (select count(*)::integer from accounting_signals where reason_code = 'ACCOUNTING_PENDING'),
        'accountingFailed', (select count(*)::integer from accounting_signals where reason_code = 'ACCOUNTING_FAILED'),
        'awaitingPaymentTotals', coalesce((select jsonb_agg(jsonb_build_object(
          'currencyCode', t.currency_code,
          'totalAmount', t.total_amount,
          'reportCount', t.report_count
        ) order by t.currency_code) from awaiting_totals t), '[]'::jsonb),
        'paidTotals', coalesce((select jsonb_agg(jsonb_build_object(
          'currencyCode', t.currency_code,
          'totalAmount', t.total_amount,
          'reportCount', t.report_count
        ) order by t.currency_code) from paid_totals t), '[]'::jsonb)
      ),
      'citations', coalesce((select jsonb_agg(jsonb_build_object(
        'reportId', c.id,
        'referenceNumber', c.reference_number,
        'status', c.status,
        'reasonCodes', to_jsonb(c.reason_codes)
      ) order by c.event_at desc nulls last, c.id) from cited c), '[]'::jsonb)
    ) into v_result;
  end if;

  v_result := jsonb_build_object(
    'schemaVersion', 1,
    'intent', p_intent,
    'windowDays', p_window_days,
    'generatedAt', statement_timestamp()
  ) || v_result;

  if pg_column_size(v_result) > 65536 then
    raise exception 'La respuesta del asistente supera el límite operativo.' using errcode = '54000';
  end if;
  v_citation_count := jsonb_array_length(v_result -> 'citations');

  insert into public.expense_assistant_queries (
    company_id, actor_id, intent, window_days, result,
    result_sha256, citation_count
  ) values (
    p_company_id, v_actor_id, p_intent, p_window_days, v_result,
    encode(extensions.digest(v_result::text::bytea, 'sha256'), 'hex'),
    v_citation_count
  ) returning id into v_query_id;

  return v_query_id;
end;
$$;

-- La retención no depende de que una persona vuelva a iniciar sesión. Un job
-- diario autenticado con service_role ejecuta esta purga global fija.
create or replace function public.purge_expired_expense_assistant_queries()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.expense_assistant_queries q
  where q.created_at < statement_timestamp() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on table public.expense_assistant_queries from public, anon, authenticated, service_role;
grant select on table public.expense_assistant_queries to authenticated, service_role;
grant delete on table public.expense_assistant_queries to service_role;

revoke all on function public.run_expense_readonly_assistant(
  uuid, public.expense_assistant_intent, integer
) from public, anon;
grant execute on function public.run_expense_readonly_assistant(
  uuid, public.expense_assistant_intent, integer
) to authenticated;

revoke all on function public.purge_expired_expense_assistant_queries()
  from public, anon, authenticated;
grant execute on function public.purge_expired_expense_assistant_queries()
  to service_role;

comment on table public.expense_assistant_queries is
  'Consultas estructuradas del asistente de Rendiciones. No almacena prompts, conversaciones, comprobantes, OCR, nombres, RUT ni datos bancarios.';
comment on function public.run_expense_readonly_assistant(uuid, public.expense_assistant_intent, integer) is
  'Calcula una respuesta tenant-aware, allowlisted y referenciada. Solo escribe su bitácora; nunca modifica datos financieros.';
comment on function public.purge_expired_expense_assistant_queries() is
  'Purga global diaria de respuestas del asistente mayores a 90 días. Solo service_role.';
