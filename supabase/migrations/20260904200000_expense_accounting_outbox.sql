-- GESTORA Rendiciones Fase 4: outbox contable multiempresa, idempotente y
-- recuperable. No contiene credenciales ni llama proveedores externos desde
-- PostgreSQL; solo fija el snapshot financiero que un adapter server-side
-- podrá entregar a Defontana/Nubox/SAP/CSV sin reabrir la rendición pagada.

create type public.expense_accounting_export_status as enum (
  'QUEUED', 'PROCESSING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);

create table public.expense_accounting_exports (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  report_id             uuid not null,
  provider_code         text not null default 'LEDGER_CSV_V1'
    check (provider_code = 'LEDGER_CSV_V1'),
  idempotency_key       text not null check (idempotency_key ~ '^[a-f0-9]{64}$'),
  payload_sha256        text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload               jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and payload ?& array['schemaVersion','provider','company','report','lines']
    and pg_column_size(payload) <= 262144
  ),
  status                public.expense_accounting_export_status not null default 'QUEUED',
  attempt_count         integer not null default 0 check (attempt_count between 0 and 5),
  max_attempts          integer not null default 5 check (max_attempts between 1 and 5),
  available_at          timestamptz not null default now(),
  lease_token           uuid,
  lease_expires_at      timestamptz,
  external_reference    text,
  last_error_code       text,
  last_error_summary    text,
  requested_by          uuid not null references public.profiles(id),
  requested_at          timestamptz not null default now(),
  exported_at           timestamptz,
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, report_id, provider_code),
  unique (company_id, idempotency_key),
  foreign key (company_id, report_id)
    references public.expense_reports(company_id, id) on delete cascade,
  constraint expense_accounting_exports_state_chk check (
    (status in ('QUEUED','RETRY') and lease_token is null and lease_expires_at is null and exported_at is null)
    or (status = 'PROCESSING' and lease_token is not null and lease_expires_at is not null and exported_at is null)
    or (status = 'SUCCEEDED' and lease_token is null and lease_expires_at is null and exported_at is not null and external_reference is not null)
    or (status in ('FAILED','CANCELLED') and lease_token is null and lease_expires_at is null and exported_at is null)
  ),
  constraint expense_accounting_exports_text_chk check (
    char_length(coalesce(external_reference, '')) <= 160
    and char_length(coalesce(last_error_code, '')) <= 80
    and char_length(coalesce(last_error_summary, '')) <= 240
  )
);

create index expense_accounting_exports_ready_idx
  on public.expense_accounting_exports(status, available_at, requested_at)
  where status in ('QUEUED','RETRY');
create index expense_accounting_exports_company_idx
  on public.expense_accounting_exports(company_id, requested_at desc);
create index expense_accounting_exports_lease_idx
  on public.expense_accounting_exports(lease_expires_at)
  where status = 'PROCESSING';

create trigger expense_accounting_exports_set_updated_at
  before update on public.expense_accounting_exports
  for each row execute function public.set_updated_at();

create table public.expense_accounting_export_events (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  export_id   uuid not null,
  actor_id    uuid references public.profiles(id),
  event_type  text not null check (event_type in (
    'QUEUED','CLAIMED','LEASE_EXPIRED','SUCCEEDED','RETRY_SCHEDULED','FAILED','CANCELLED'
  )),
  metadata    jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8192
  ),
  occurred_at timestamptz not null default now(),
  foreign key (company_id, export_id)
    references public.expense_accounting_exports(company_id, id) on delete cascade
);

create index expense_accounting_export_events_idx
  on public.expense_accounting_export_events(company_id, export_id, occurred_at desc);

alter table public.expense_accounting_exports enable row level security;
alter table public.expense_accounting_export_events enable row level security;

create policy expense_accounting_exports_select on public.expense_accounting_exports
  for select to authenticated
  using (
    public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (
      public.has_company_permission(company_id, 'expenses.reconcile')
      or public.has_company_permission(company_id, 'expenses.manage')
    )
  );

create policy expense_accounting_export_events_select on public.expense_accounting_export_events
  for select to authenticated
  using (
    public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (
      public.has_company_permission(company_id, 'expenses.reconcile')
      or public.has_company_permission(company_id, 'expenses.manage')
    )
  );

-- Crea una sola salida por rendición pagada y guarda un snapshot mínimo:
-- nunca comprobantes, rutas de Storage, OCR, cuentas bancarias ni secretos.
create or replace function public.queue_expense_accounting_export(
  p_company_id uuid,
  p_report_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_report record;
  v_lines jsonb;
  v_payload jsonb;
  v_idempotency_key text;
  v_payload_sha256 text;
  v_export_id uuid;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.reconcile')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite preparar salidas contables.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_report_id::text || ':accounting', 0));

  -- La llamada puede haber esperado por otra transacción. Revalida después
  -- del lock para que una baja de membresía, módulo o permiso ocurrida durante
  -- la espera corte el flujo antes de capturar el snapshot financiero.
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.reconcile')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite preparar salidas contables.' using errcode = '42501';
  end if;

  select er.id, er.reference_number, er.title, er.currency_code, er.total_amount,
         er.paid_at, er.payment_reference, er.submitted_by,
         p.display_name as submitter_name,
         c.name as company_name,
         ou.code as cost_center_code, ou.name as cost_center_name
    into v_report
  from public.expense_reports er
  join public.profiles p on p.id = er.submitted_by
  join public.companies c on c.id = er.company_id
  left join public.organization_units ou
    on ou.company_id = er.company_id and ou.id = er.organization_unit_id
  where er.company_id = p_company_id and er.id = p_report_id and er.status = 'PAID';
  if not found then
    raise exception 'Solo una rendición pagada puede enviarse a contabilidad.' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', ei.id,
    'expenseDate', ei.expense_date,
    'categoryCode', coalesce(ec.code, 'SIN_CATEGORIA'),
    'categoryName', coalesce(ec.name, 'Sin categoría'),
    'merchant', ei.merchant_name,
    'description', ei.description,
    'netAmount', ei.net_amount,
    'taxAmount', ei.tax_amount,
    'totalAmount', ei.total_amount,
    'currency', ei.currency_code
  ) order by ei.expense_date, ei.id), '[]'::jsonb)
    into v_lines
  from public.expense_items ei
  left join public.expense_categories ec
    on ec.company_id = ei.company_id and ec.id = ei.category_id
  where ei.company_id = p_company_id and ei.report_id = p_report_id;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'La rendición pagada no contiene líneas contables.' using errcode = '23514';
  end if;

  v_payload := jsonb_build_object(
    'schemaVersion', 1,
    'provider', 'LEDGER_CSV_V1',
    'company', jsonb_build_object('id', p_company_id, 'name', v_report.company_name),
    'report', jsonb_build_object(
      'id', v_report.id,
      'referenceNumber', v_report.reference_number,
      'title', v_report.title,
      'currency', v_report.currency_code,
      'totalAmount', v_report.total_amount,
      'paidAt', v_report.paid_at,
      'paymentReference', v_report.payment_reference,
      'submitterId', v_report.submitted_by,
      'submitterName', v_report.submitter_name,
      'costCenterCode', v_report.cost_center_code,
      'costCenterName', v_report.cost_center_name
    ),
    'lines', v_lines
  );
  if pg_column_size(v_payload) > 262144 then
    raise exception 'La salida contable supera el límite operativo.' using errcode = '54000';
  end if;

  v_idempotency_key := encode(extensions.digest(
    (p_company_id::text || ':' || p_report_id::text || ':LEDGER_CSV_V1:1')::bytea,
    'sha256'
  ), 'hex');
  v_payload_sha256 := encode(extensions.digest(v_payload::text::bytea, 'sha256'), 'hex');

  select e.id into v_export_id
  from public.expense_accounting_exports e
  where e.company_id = p_company_id and e.idempotency_key = v_idempotency_key;
  if v_export_id is not null then return v_export_id; end if;

  insert into public.expense_accounting_exports (
    company_id, report_id, provider_code, idempotency_key, payload_sha256,
    payload, requested_by
  ) values (
    p_company_id, p_report_id, 'LEDGER_CSV_V1', v_idempotency_key,
    v_payload_sha256, v_payload, v_actor_id
  ) returning id into v_export_id;

  insert into public.expense_accounting_export_events (
    company_id, export_id, actor_id, event_type, metadata
  ) values (
    p_company_id, v_export_id, v_actor_id, 'QUEUED',
    jsonb_build_object('provider', 'LEDGER_CSV_V1', 'payload_sha256', v_payload_sha256)
  );
  insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
  values (p_company_id, p_report_id, v_actor_id, 'ACCOUNTING_EXPORT_QUEUED', jsonb_build_object('export_id', v_export_id));

  return v_export_id;
end;
$$;

-- Bandeja mínima para finanzas. Evita depender de la política de lectura
-- general de Rendiciones: un rol de conciliación puede preparar contabilidad
-- sin recibir acceso a comprobantes, OCR u otros detalles del informe.
create or replace function public.list_expense_accounting_ready_reports(
  p_company_id uuid
)
returns table (
  report_id uuid,
  reference_number text,
  title text,
  total_amount numeric,
  currency_code text,
  paid_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.reconcile')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite ver salidas contables.' using errcode = '42501';
  end if;

  return query
  select er.id, er.reference_number, er.title, er.total_amount,
         er.currency_code, er.paid_at
  from public.expense_reports er
  where er.company_id = p_company_id
    and er.status = 'PAID'
    and er.paid_at is not null
    and not exists (
      select 1
      from public.expense_accounting_exports e
      where e.company_id = er.company_id and e.report_id = er.id
    )
  order by er.paid_at desc, er.id
  limit 500;
end;
$$;

-- Reclama trabajos con SKIP LOCKED y token de fencing. Los leases vencidos
-- vuelven a RETRY o terminan FAILED según el máximo; nunca quedan atascados.
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
    select e.* from public.expense_accounting_exports e
    where e.status in ('QUEUED','RETRY') and e.available_at <= clock_timestamp()
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

  if p_error_code is null or char_length(btrim(p_error_code)) not between 1 and 80
     or p_error_summary is null or char_length(btrim(p_error_summary)) not between 1 and 240 then
    raise exception 'Error contable inválido.' using errcode = '23514';
  end if;
  v_next_status := case
    when p_retryable and v_job.attempt_count < v_job.max_attempts
      then 'RETRY'::public.expense_accounting_export_status
    else 'FAILED'::public.expense_accounting_export_status
  end;
  v_delay := least(3600, 30 * (2 ^ greatest(v_job.attempt_count - 1, 0))::integer);

  update public.expense_accounting_exports e
  set status = v_next_status, lease_token = null, lease_expires_at = null,
      available_at = case when v_next_status = 'RETRY' then clock_timestamp() + make_interval(secs => v_delay) else e.available_at end,
      last_error_code = btrim(p_error_code), last_error_summary = btrim(p_error_summary)
  where e.id = p_export_id;
  insert into public.expense_accounting_export_events (company_id, export_id, event_type, metadata)
  values (
    v_job.company_id, v_job.id,
    case when v_next_status = 'RETRY' then 'RETRY_SCHEDULED' else 'FAILED' end,
    jsonb_build_object('attempt', v_job.attempt_count, 'error_code', btrim(p_error_code), 'retry_delay_seconds', case when v_next_status = 'RETRY' then v_delay else null end)
  );
  return v_next_status;
end;
$$;

revoke all on table public.expense_accounting_exports from public, anon, authenticated;
revoke all on table public.expense_accounting_export_events from public, anon, authenticated;
grant select on table public.expense_accounting_exports to authenticated;
grant select on table public.expense_accounting_export_events to authenticated;
grant all on table public.expense_accounting_exports to service_role;
grant all on table public.expense_accounting_export_events to service_role;
grant usage, select on sequence public.expense_accounting_export_events_id_seq to service_role;

revoke all on function public.queue_expense_accounting_export(uuid, uuid) from public, anon;
grant execute on function public.queue_expense_accounting_export(uuid, uuid) to authenticated, service_role;
revoke all on function public.list_expense_accounting_ready_reports(uuid) from public, anon;
grant execute on function public.list_expense_accounting_ready_reports(uuid) to authenticated;
revoke all on function public.claim_expense_accounting_exports(integer) from public, anon, authenticated;
revoke all on function public.complete_expense_accounting_export(uuid, uuid, boolean, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_expense_accounting_exports(integer) to service_role;
grant execute on function public.complete_expense_accounting_export(uuid, uuid, boolean, text, text, text, boolean) to service_role;

comment on table public.expense_accounting_exports is
  'Outbox contable: snapshot inmutable, idempotencia, retries acotados y lease con fencing por empresa.';
comment on function public.queue_expense_accounting_export(uuid, uuid) is
  'Prepara una salida contable solo desde una rendición PAID y solo para finanzas de la misma empresa.';
comment on function public.list_expense_accounting_ready_reports(uuid) is
  'Lista mínima de rendiciones PAID aún no encoladas; no expone comprobantes, OCR ni datos bancarios.';
comment on function public.claim_expense_accounting_exports(integer) is
  'Service-role worker: recupera leases y reclama lotes con SKIP LOCKED.';
