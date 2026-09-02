-- GESTORA Rendiciones EX-4: cierre del caso borde donde un worker pierde su
-- lease después de que el comprobante fue reemplazado. Los jobs vigentes se
-- reencolan; los superseded terminan cancelados y nunca quedan RUNNING.

create or replace function public.reclaim_stale_expense_ocr_jobs(p_stale_after_seconds integer default 300)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cancelled integer := 0;
  v_requeued integer := 0;
begin
  if p_stale_after_seconds < 60 or p_stale_after_seconds > 3600 then
    raise exception 'stale_after_seconds debe estar entre 60 y 3600.' using errcode = '22023';
  end if;

  update public.expense_ocr_jobs j
  set status = 'CANCELLED', locked_at = null, locked_by = null,
      finished_at = pg_catalog.clock_timestamp(), error_category = 'SUPERSEDED',
      error_summary = 'Lease expirado y comprobante reemplazado; trabajo cancelado.'
  where j.status = 'RUNNING'
    and j.locked_at < pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_stale_after_seconds)
    and not exists (
      select 1 from public.expense_receipts r
      where r.company_id = j.company_id and r.id = j.receipt_id and r.is_current
    );
  get diagnostics v_cancelled = row_count;

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
  get diagnostics v_requeued = row_count;

  return v_cancelled + v_requeued;
end;
$$;

revoke all on function public.reclaim_stale_expense_ocr_jobs(integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_expense_ocr_jobs(integer) to service_role;

comment on function public.reclaim_stale_expense_ocr_jobs(integer) is
  'Recupera leases OCR vigentes y cancela leases huérfanos de comprobantes reemplazados.';

-- PostgreSQL resuelve los CASE con literales como text dentro de PL/pgSQL.
-- Los casts explícitos evitan fallos runtime al escribir columnas enum.
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
  set status = case when v_current
        then 'SUCCEEDED'::public.expense_ocr_job_status
        else 'CANCELLED'::public.expense_ocr_job_status end,
      locked_at = null, locked_by = null, finished_at = pg_catalog.clock_timestamp(),
      error_category = case when v_current then null else 'SUPERSEDED' end,
      error_summary = case when v_current then null else 'Resultado descartado: el comprobante fue reemplazado.' end
  where j.id = p_job_id;

  if v_current then
    update public.expense_receipts r
    set status = 'PROCESSED'::public.expense_receipt_status, extraction = p_extraction
    where r.company_id = v_company_id and r.id = v_receipt_id;
    update public.expense_items ei
    set receipt_status = 'PROCESSED'::public.expense_receipt_status, extraction = p_extraction
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
    insert into public.expense_ocr_jobs (company_id, receipt_id, attempt, provider, available_at)
    values (v_company_id, v_receipt_id, v_attempt + 1, v_provider,
      pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_delay_seconds));
    v_retried := true;
  end if;

  if v_current then
    update public.expense_receipts r
    set status = case when v_retried
        then 'PROCESSING'::public.expense_receipt_status
        else 'FAILED'::public.expense_receipt_status end
    where r.company_id = v_company_id and r.id = v_receipt_id;
    update public.expense_items ei
    set receipt_status = case when v_retried
        then 'PROCESSING'::public.expense_receipt_status
        else 'FAILED'::public.expense_receipt_status end
    where ei.company_id = v_company_id and ei.id = v_item_id;
  end if;
  return v_retried;
end;
$$;

revoke all on function public.complete_expense_ocr_job(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_expense_ocr_job(uuid, uuid, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_expense_ocr_job(uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_expense_ocr_job(uuid, uuid, text, text, boolean, integer) to service_role;
