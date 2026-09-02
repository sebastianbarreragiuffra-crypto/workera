-- GESTORA Rendiciones EX-4: pipeline OCR asíncrono, multiempresa e
-- idempotente. El proveedor nunca escribe directamente en tablas de negocio.

create type public.expense_ocr_job_status as enum (
  'QUEUED', 'RUNNING', 'WAITING_PROVIDER', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
create type public.expense_ocr_review_decision as enum ('ACCEPTED', 'REJECTED');

create table public.expense_ocr_jobs (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies(id) on delete cascade,
  receipt_id             uuid not null,
  attempt                integer not null check (attempt between 1 and 3),
  status                 public.expense_ocr_job_status not null default 'QUEUED',
  provider               text not null default 'azure-document-intelligence'
                           check (provider = 'azure-document-intelligence'),
  provider_operation_url text,
  available_at           timestamptz not null default now(),
  locked_at              timestamptz,
  locked_by              uuid,
  started_at             timestamptz,
  finished_at            timestamptz,
  error_category         text,
  error_summary          text check (error_summary is null or char_length(error_summary) <= 500),
  created_at             timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, receipt_id, attempt),
  foreign key (company_id, receipt_id)
    references public.expense_receipts(company_id, id) on delete cascade,
  constraint expense_ocr_jobs_state_chk check (
    (status = 'QUEUED' and locked_at is null and locked_by is null and finished_at is null)
    or (status = 'RUNNING' and locked_at is not null and locked_by is not null and finished_at is null)
    or (status = 'WAITING_PROVIDER' and provider_operation_url is not null and locked_at is null and locked_by is null and finished_at is null)
    or (status in ('SUCCEEDED', 'FAILED', 'CANCELLED') and locked_at is null and locked_by is null and finished_at is not null)
  )
);

create unique index expense_ocr_jobs_one_active_idx
  on public.expense_ocr_jobs(company_id, receipt_id)
  where status in ('QUEUED', 'RUNNING', 'WAITING_PROVIDER');
create index expense_ocr_jobs_claim_idx
  on public.expense_ocr_jobs(status, available_at, created_at)
  where status in ('QUEUED', 'WAITING_PROVIDER');

create table public.expense_ocr_reviews (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  receipt_id  uuid not null,
  reviewed_by uuid not null references public.profiles(id),
  decision    public.expense_ocr_review_decision not null,
  comment     text check (comment is null or char_length(comment) <= 1000),
  reviewed_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, receipt_id)
    references public.expense_receipts(company_id, id) on delete cascade
);

create index expense_ocr_reviews_receipt_idx
  on public.expense_ocr_reviews(company_id, receipt_id, reviewed_at desc);

alter table public.expense_ocr_jobs enable row level security;
alter table public.expense_ocr_reviews enable row level security;

create policy expense_ocr_reviews_read on public.expense_ocr_reviews for select to authenticated
  using (exists (
    select 1
    from public.expense_receipts r
    join public.expense_reports er on er.company_id = r.company_id and er.id = r.report_id
    where r.company_id = expense_ocr_reviews.company_id
      and r.id = expense_ocr_reviews.receipt_id
  ));

revoke all on public.expense_ocr_jobs, public.expense_ocr_reviews
  from public, anon, authenticated, service_role;
grant select on public.expense_ocr_reviews to authenticated;
grant select on public.expense_ocr_reviews to service_role;
grant select, insert, update on public.expense_ocr_jobs to service_role;

-- Cada versión de comprobante genera exactamente un primer intento. El
-- reemplazo cancela cualquier trabajo activo de la versión anterior.
create or replace function public.enqueue_expense_receipt_ocr()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_ocr_jobs (company_id, receipt_id, attempt)
  values (new.company_id, new.id, 1)
  on conflict (company_id, receipt_id, attempt) do nothing;
  return new;
end;
$$;

create or replace function public.cancel_superseded_expense_receipt_ocr()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_current and not new.is_current then
    update public.expense_ocr_jobs j
    set status = 'CANCELLED', locked_at = null, locked_by = null,
        finished_at = pg_catalog.clock_timestamp(),
        error_category = 'SUPERSEDED', error_summary = 'Comprobante reemplazado por una versión posterior.'
    where j.company_id = new.company_id and j.receipt_id = new.id
      and j.status in ('QUEUED', 'RUNNING', 'WAITING_PROVIDER');
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_expense_receipt_ocr() from public, anon, authenticated;
revoke all on function public.cancel_superseded_expense_receipt_ocr() from public, anon, authenticated;

create trigger expense_receipts_enqueue_ocr
  after insert on public.expense_receipts
  for each row execute function public.enqueue_expense_receipt_ocr();
create trigger expense_receipts_cancel_superseded_ocr
  after update of is_current on public.expense_receipts
  for each row execute function public.cancel_superseded_expense_receipt_ocr();

-- Recupera leases huérfanos sin crear un intento nuevo: si el worker cayó
-- antes de hablar con el proveedor, repetir el claim es seguro. Una respuesta
-- explícita del proveedor sí pasa por fail_expense_ocr_job y consume intento.
create or replace function public.reclaim_stale_expense_ocr_jobs(p_stale_after_seconds integer default 300)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_stale_after_seconds < 60 or p_stale_after_seconds > 3600 then
    raise exception 'stale_after_seconds debe estar entre 60 y 3600.' using errcode = '22023';
  end if;

  update public.expense_ocr_jobs j
  set status = 'QUEUED', available_at = pg_catalog.clock_timestamp(),
      locked_at = null, locked_by = null,
      error_category = 'LEASE_EXPIRED', error_summary = 'Lease del worker expirado; trabajo recuperado.'
  where j.status = 'RUNNING'
    and j.locked_at < pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_stale_after_seconds)
    and exists (
      select 1 from public.expense_receipts r
      where r.company_id = j.company_id and r.id = j.receipt_id and r.is_current
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_expense_ocr_jobs(
  p_worker_id uuid,
  p_limit integer default 3
)
returns table (
  job_id uuid,
  company_id uuid,
  receipt_id uuid,
  storage_path text,
  mime_type text,
  attempt integer,
  provider_operation_url text,
  expense_date date,
  merchant_name text,
  net_amount numeric,
  tax_amount numeric,
  total_amount numeric,
  currency_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or p_limit < 1 or p_limit > 10 then
    raise exception 'worker_id y limit válido son obligatorios.' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select j.id
    from public.expense_ocr_jobs j
    join public.expense_receipts r on r.company_id = j.company_id and r.id = j.receipt_id
    where j.status in ('QUEUED', 'WAITING_PROVIDER')
      and j.available_at <= pg_catalog.clock_timestamp()
      and r.is_current
    order by j.available_at, j.created_at, j.id
    for update of j skip locked
    limit p_limit
  ), claimed as (
    update public.expense_ocr_jobs j
    set status = 'RUNNING', locked_at = pg_catalog.clock_timestamp(), locked_by = p_worker_id,
        started_at = coalesce(j.started_at, pg_catalog.clock_timestamp()),
        error_category = null, error_summary = null
    from candidates c
    where j.id = c.id
    returning j.*
  ), marked as (
    update public.expense_receipts r
    set status = 'PROCESSING'
    from claimed c
    where r.company_id = c.company_id and r.id = c.receipt_id and r.is_current
    returning r.id
  )
  select c.id, c.company_id, c.receipt_id, r.storage_path, r.mime_type,
    c.attempt, c.provider_operation_url, ei.expense_date, ei.merchant_name,
    ei.net_amount, ei.tax_amount, ei.total_amount, ei.currency_code
  from claimed c
  join public.expense_receipts r on r.company_id = c.company_id and r.id = c.receipt_id
  join public.expense_items ei on ei.company_id = r.company_id and ei.id = r.item_id;
end;
$$;

create or replace function public.defer_expense_ocr_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_provider_operation_url text,
  p_delay_seconds integer default 5
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_provider_operation_url is null or char_length(p_provider_operation_url) > 2000
     or p_delay_seconds < 1 or p_delay_seconds > 300 then
    raise exception 'Operación o demora inválida.' using errcode = '22023';
  end if;

  update public.expense_ocr_jobs j
  set status = 'WAITING_PROVIDER', provider_operation_url = p_provider_operation_url,
      available_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_delay_seconds),
      locked_at = null, locked_by = null
  where j.id = p_job_id and j.status = 'RUNNING' and j.locked_by = p_worker_id;
  if not found then raise exception 'Lease OCR inexistente o vencido.' using errcode = '40001'; end if;
end;
$$;

create or replace function public.complete_expense_ocr_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_extraction jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_receipt_id uuid;
  v_item_id uuid;
  v_current boolean;
begin
  if p_extraction is null or jsonb_typeof(p_extraction) <> 'object' then
    raise exception 'La extracción debe ser un objeto JSON.' using errcode = '22023';
  end if;

  select j.company_id, j.receipt_id, r.item_id, r.is_current
    into v_company_id, v_receipt_id, v_item_id, v_current
  from public.expense_ocr_jobs j
  join public.expense_receipts r on r.company_id = j.company_id and r.id = j.receipt_id
  where j.id = p_job_id and j.status = 'RUNNING' and j.locked_by = p_worker_id
  for update of j, r;
  if not found then raise exception 'Lease OCR inexistente o vencido.' using errcode = '40001'; end if;

  update public.expense_ocr_jobs j
  set status = case when v_current then 'SUCCEEDED' else 'CANCELLED' end,
      locked_at = null, locked_by = null, finished_at = pg_catalog.clock_timestamp(),
      error_category = case when v_current then null else 'SUPERSEDED' end,
      error_summary = case when v_current then null else 'Resultado descartado: el comprobante fue reemplazado.' end
  where j.id = p_job_id;

  if v_current then
    update public.expense_receipts r
    set status = 'PROCESSED', extraction = p_extraction
    where r.company_id = v_company_id and r.id = v_receipt_id;
    update public.expense_items ei
    set receipt_status = 'PROCESSED', extraction = p_extraction
    where ei.company_id = v_company_id and ei.id = v_item_id;
  end if;
end;
$$;

create or replace function public.fail_expense_ocr_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_category text,
  p_error_summary text,
  p_retryable boolean,
  p_retry_delay_seconds integer default 30
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_receipt_id uuid;
  v_attempt integer;
  v_provider text;
  v_item_id uuid;
  v_current boolean;
  v_retried boolean := false;
begin
  if p_error_category is null or char_length(p_error_category) > 80
     or p_error_summary is null or p_retry_delay_seconds < 1 or p_retry_delay_seconds > 3600 then
    raise exception 'Detalle de error OCR inválido.' using errcode = '22023';
  end if;

  select j.company_id, j.receipt_id, j.attempt, j.provider, r.item_id, r.is_current
    into v_company_id, v_receipt_id, v_attempt, v_provider, v_item_id, v_current
  from public.expense_ocr_jobs j
  join public.expense_receipts r on r.company_id = j.company_id and r.id = j.receipt_id
  where j.id = p_job_id and j.status = 'RUNNING' and j.locked_by = p_worker_id
  for update of j, r;
  if not found then raise exception 'Lease OCR inexistente o vencido.' using errcode = '40001'; end if;

  update public.expense_ocr_jobs j
  set status = 'FAILED', locked_at = null, locked_by = null,
      finished_at = pg_catalog.clock_timestamp(), error_category = left(p_error_category, 80),
      error_summary = left(p_error_summary, 500)
  where j.id = p_job_id;

  if p_retryable and v_current and v_attempt < 3 then
    insert into public.expense_ocr_jobs (
      company_id, receipt_id, attempt, provider, available_at
    ) values (
      v_company_id, v_receipt_id, v_attempt + 1, v_provider,
      pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_delay_seconds)
    );
    v_retried := true;
  end if;

  if v_current then
    update public.expense_receipts r
    set status = case when v_retried then 'PROCESSING' else 'FAILED' end
    where r.company_id = v_company_id and r.id = v_receipt_id;
    update public.expense_items ei
    set receipt_status = case when v_retried then 'PROCESSING' else 'FAILED' end
    where ei.company_id = v_company_id and ei.id = v_item_id;
  end if;
  return v_retried;
end;
$$;

revoke all on function public.reclaim_stale_expense_ocr_jobs(integer) from public, anon, authenticated;
revoke all on function public.claim_expense_ocr_jobs(uuid, integer) from public, anon, authenticated;
revoke all on function public.defer_expense_ocr_job(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_expense_ocr_job(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_expense_ocr_job(uuid, uuid, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_expense_ocr_jobs(integer) to service_role;
grant execute on function public.claim_expense_ocr_jobs(uuid, integer) to service_role;
grant execute on function public.defer_expense_ocr_job(uuid, uuid, text, integer) to service_role;
grant execute on function public.complete_expense_ocr_job(uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_expense_ocr_job(uuid, uuid, text, text, boolean, integer) to service_role;

create or replace function public.review_expense_receipt_extraction(
  p_receipt_id uuid,
  p_decision public.expense_ocr_review_decision,
  p_comment text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitter_id uuid;
  v_report_status public.expense_report_status;
  v_receipt_status public.expense_receipt_status;
  v_comment text := nullif(btrim(p_comment), '');
  v_review_id uuid := gen_random_uuid();
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_receipt_id is null or p_decision is null then raise exception 'receipt_id y decision son obligatorios.' using errcode = '22004'; end if;
  if p_decision = 'REJECTED' and v_comment is null then
    raise exception 'Debes explicar por qué rechazas la lectura automática.' using errcode = '23514';
  end if;

  select r.company_id, er.submitted_by, er.status, r.status
    into v_company_id, v_submitter_id, v_report_status, v_receipt_status
  from public.expense_receipts r
  join public.expense_reports er on er.company_id = r.company_id and er.id = r.report_id
  where r.id = p_receipt_id and r.is_current
  for update of r;
  if not found then raise exception 'Comprobante inexistente o reemplazado.' using errcode = '23503'; end if;
  if v_receipt_status <> 'PROCESSED' then
    raise exception 'La lectura automática todavía no está disponible.' using errcode = '23514';
  end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id) then
    raise exception 'No tienes acceso a este comprobante.' using errcode = '42501';
  end if;
  if not (
    (v_report_status = 'DRAFT' and v_submitter_id = v_actor_id
      and public.has_company_permission(v_company_id, 'expenses.submit'))
    or (v_report_status in ('SUBMITTED', 'IN_REVIEW')
      and (public.has_company_permission(v_company_id, 'expenses.approve')
        or public.has_company_permission(v_company_id, 'expenses.manage')))
    or public.has_company_permission(v_company_id, 'expenses.manage')
  ) then
    raise exception 'Tu rol no permite revisar esta extracción.' using errcode = '42501';
  end if;

  insert into public.expense_ocr_reviews (
    id, company_id, receipt_id, reviewed_by, decision, comment
  ) values (v_review_id, v_company_id, p_receipt_id, v_actor_id, p_decision, v_comment);

  update public.expense_receipts r
  set extraction = r.extraction || jsonb_build_object(
    'humanReview', jsonb_build_object(
      'decision', p_decision, 'reviewedAt', pg_catalog.clock_timestamp(),
      'reviewedBy', v_actor_id, 'comment', v_comment
    )
  )
  where r.company_id = v_company_id and r.id = p_receipt_id;

  return v_review_id;
end;
$$;

revoke all on function public.review_expense_receipt_extraction(uuid, public.expense_ocr_review_decision, text)
  from public, anon;
grant execute on function public.review_expense_receipt_extraction(uuid, public.expense_ocr_review_decision, text)
  to authenticated;

comment on table public.expense_ocr_jobs is
  'Cola OCR interna con lease, polling diferido y máximo tres intentos; no es visible para usuarios finales.';
comment on function public.claim_expense_ocr_jobs(uuid, integer) is
  'Claim atómico SKIP LOCKED para workers OCR service_role; evita procesamiento concurrente del mismo comprobante.';
