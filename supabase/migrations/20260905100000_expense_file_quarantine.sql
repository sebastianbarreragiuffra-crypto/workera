-- GESTORA Rendiciones P0-A: cuarentena durable para archivos externos.
--
-- Los archivos recibidos por EMAIL/WHATSAPP quedan privados e inutilizables
-- hasta que un worker service_role entregue un veredicto CLEAN. La validación
-- de magic bytes de WEB_UPLOAD/WEB_CAMERA se conserva como VALIDATED_INTERNAL;
-- no se presenta como un escaneo antimalware y sigue siendo riesgo de piloto.

create type public.expense_file_security_status as enum (
  'VALIDATED_INTERNAL',
  'PENDING_SCAN',
  'SCANNING',
  'CLEAN',
  'REJECTED',
  'SCAN_FAILED'
);

alter table public.expense_receipt_captures
  add column security_status public.expense_file_security_status not null default 'VALIDATED_INTERNAL',
  add column scan_attempt integer not null default 0,
  add column scan_available_at timestamptz not null default now(),
  add column scan_locked_at timestamptz,
  add column scan_locked_by uuid,
  add column security_scanned_at timestamptz,
  add column security_scanner text,
  add column security_result_code text;

update public.expense_receipt_captures
set security_status = 'PENDING_SCAN', scan_available_at = now()
where source in ('EMAIL', 'WHATSAPP');

alter table public.expense_receipt_captures
  add constraint expense_receipt_captures_scan_attempt_chk
    check (scan_attempt between 0 and 3),
  add constraint expense_receipt_captures_scan_metadata_chk
    check (
      (security_status = 'VALIDATED_INTERNAL'
        and source in ('WEB_UPLOAD', 'WEB_CAMERA')
        and scan_attempt = 0 and scan_locked_at is null and scan_locked_by is null
        and security_scanned_at is null and security_scanner is null and security_result_code is null)
      or
      (security_status = 'PENDING_SCAN'
        and source in ('EMAIL', 'WHATSAPP')
        and scan_locked_at is null and scan_locked_by is null and security_scanned_at is null)
      or
      (security_status = 'SCANNING'
        and source in ('EMAIL', 'WHATSAPP')
        and scan_attempt between 1 and 3 and scan_locked_at is not null and scan_locked_by is not null
        and security_scanned_at is null)
      or
      (security_status in ('CLEAN', 'REJECTED', 'SCAN_FAILED')
        and source in ('EMAIL', 'WHATSAPP')
        and scan_attempt between 1 and 3 and scan_locked_at is null and scan_locked_by is null
        and security_scanned_at is not null and security_scanner is not null and security_result_code is not null)
    ),
  add constraint expense_receipt_captures_scan_text_chk
    check (
      (security_scanner is null or char_length(security_scanner) between 1 and 80)
      and (security_result_code is null or char_length(security_result_code) between 1 and 80)
    );

create index expense_receipt_captures_scan_claim_idx
  on public.expense_receipt_captures(scan_available_at, created_at, id)
  where security_status = 'PENDING_SCAN';

create or replace function public.initialize_expense_capture_security()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.source <> old.source then
      raise exception 'El origen de una captura es inmutable.' using errcode = '23514';
    end if;
    return new;
  end if;

  new.scan_attempt := 0;
  new.scan_available_at := pg_catalog.clock_timestamp();
  new.scan_locked_at := null;
  new.scan_locked_by := null;
  new.security_scanned_at := null;
  new.security_scanner := null;
  new.security_result_code := null;
  new.security_status := case
    when new.source in ('EMAIL', 'WHATSAPP') then 'PENDING_SCAN'::public.expense_file_security_status
    else 'VALIDATED_INTERNAL'::public.expense_file_security_status
  end;
  return new;
end;
$$;

create trigger expense_receipt_captures_initialize_security
  before insert or update of source on public.expense_receipt_captures
  for each row execute function public.initialize_expense_capture_security();

revoke all on function public.initialize_expense_capture_security() from public, anon, authenticated, service_role;

alter table public.expense_receipts
  add column security_status public.expense_file_security_status not null default 'VALIDATED_INTERNAL',
  add column security_scanned_at timestamptz,
  add column security_scanner text,
  add column security_result_code text;

update public.expense_receipts r
set security_status = 'PENDING_SCAN'
from public.expense_receipt_captures c
where c.company_id = r.company_id
  and c.attached_receipt_id = r.id
  and c.source in ('EMAIL', 'WHATSAPP');

alter table public.expense_receipts
  add constraint expense_receipts_security_metadata_chk
    check (
      (security_status in ('VALIDATED_INTERNAL', 'PENDING_SCAN')
        and security_scanned_at is null and security_scanner is null and security_result_code is null)
      or
      (security_status in ('CLEAN', 'REJECTED', 'SCAN_FAILED')
        and security_scanned_at is not null and security_scanner is not null and security_result_code is not null)
    ),
  add constraint expense_receipts_security_text_chk
    check (
      (security_scanner is null or char_length(security_scanner) between 1 and 80)
      and (security_result_code is null or char_length(security_result_code) between 1 and 80)
    );

create or replace function public.initialize_expense_receipt_security()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capture public.expense_receipt_captures%rowtype;
begin
  select c.* into v_capture
  from public.expense_receipt_captures c
  where c.company_id = new.company_id and c.storage_path = new.storage_path
  order by c.created_at desc
  limit 1;

  if found then
    if v_capture.security_status not in ('VALIDATED_INTERNAL', 'CLEAN') then
      raise exception 'El archivo permanece en cuarentena.' using errcode = '23514';
    end if;
    new.security_status := v_capture.security_status;
    new.security_scanned_at := v_capture.security_scanned_at;
    new.security_scanner := v_capture.security_scanner;
    new.security_result_code := v_capture.security_result_code;
  else
    new.security_status := 'VALIDATED_INTERNAL';
    new.security_scanned_at := null;
    new.security_scanner := null;
    new.security_result_code := null;
  end if;
  return new;
end;
$$;

create trigger expense_receipts_initialize_security
  before insert on public.expense_receipts
  for each row execute function public.initialize_expense_receipt_security();

revoke all on function public.initialize_expense_receipt_security() from public, anon, authenticated, service_role;

-- El bucket continúa privado. La metadata de una captura puede aparecer en la
-- bandeja para mostrar "en análisis", pero Storage no firma ni entrega bytes.
create or replace function public.can_read_expense_capture_path(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.expense_receipt_captures c
    where c.storage_path = p_name
      and c.uploaded_by = auth.uid()
      and c.status = 'PENDING'
      and c.security_status in ('VALIDATED_INTERNAL', 'CLEAN')
      and public.company_has_module(c.company_id, 'expenses')
      and public.is_active_company_member(c.company_id)
      and (public.has_company_permission(c.company_id, 'expenses.submit')
        or public.has_company_permission(c.company_id, 'expenses.manage'))
  );
$$;

create or replace function public.can_read_expense_receipt_path(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.expense_receipts r
    join public.expense_reports er on er.company_id = r.company_id and er.id = r.report_id
    where r.storage_path = p_name
      and r.security_status in ('VALIDATED_INTERNAL', 'CLEAN')
      and public.company_has_module(r.company_id, 'expenses')
      and public.is_active_company_member(r.company_id)
      and (
        er.submitted_by = auth.uid()
        or public.has_company_permission(r.company_id, 'expenses.read')
        or public.has_company_permission(r.company_id, 'expenses.approve')
        or public.has_company_permission(r.company_id, 'expenses.manage')
      )
  );
$$;

revoke all on function public.can_read_expense_capture_path(text) from public, anon;
revoke all on function public.can_read_expense_receipt_path(text) from public, anon;
grant execute on function public.can_read_expense_capture_path(text) to authenticated;
grant execute on function public.can_read_expense_receipt_path(text) to authenticated;

-- OCR solo se encola después de una liberación explícita. Esto también cubre
-- inserts directos con service_role y no depende de que el worker "recuerde"
-- comprobar la cuarentena.
create or replace function public.enqueue_expense_receipt_ocr()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.security_status in ('VALIDATED_INTERNAL', 'CLEAN') then
    insert into public.expense_ocr_jobs (company_id, receipt_id, attempt)
    values (new.company_id, new.id, 1)
    on conflict (company_id, receipt_id, attempt) do nothing;
  end if;
  return new;
end;
$$;

-- Cualquier trabajo histórico de un archivo externo no escaneado queda
-- cancelado. Un veredicto CLEAN podrá crear un intento nuevo conservando el
-- historial; nunca se reutiliza una extracción obtenida antes del escaneo.
update public.expense_ocr_jobs j
set status = 'CANCELLED', locked_at = null, locked_by = null,
    finished_at = pg_catalog.clock_timestamp(),
    error_category = 'FILE_QUARANTINED',
    error_summary = 'Trabajo cancelado: el archivo requiere veredicto de seguridad.'
from public.expense_receipts r
where r.company_id = j.company_id and r.id = j.receipt_id
  and r.security_status = 'PENDING_SCAN'
  and j.status in ('QUEUED', 'RUNNING', 'WAITING_PROVIDER');

update public.expense_receipts
set status = 'UPLOADED', extraction = '{}'::jsonb
where security_status = 'PENDING_SCAN';

update public.expense_items ei
set receipt_status = 'UPLOADED', extraction = '{}'::jsonb
where exists (
  select 1 from public.expense_receipts r
  where r.company_id = ei.company_id and r.item_id = ei.id and r.is_current
    and r.security_status = 'PENDING_SCAN'
);

create or replace function public.require_released_expense_receipts_on_submit()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status = 'SUBMITTED' and old.status is distinct from new.status and exists (
    select 1
    from public.expense_items ei
    join public.expense_categories ec
      on ec.company_id = ei.company_id and ec.id = ei.category_id
    where ei.company_id = new.company_id and ei.report_id = new.id
      and ec.requires_receipt
      and not exists (
        select 1 from public.expense_receipts r
        where r.company_id = ei.company_id and r.item_id = ei.id and r.is_current
          and r.security_status in ('VALIDATED_INTERNAL', 'CLEAN')
      )
  ) then
    raise exception 'Un comprobante obligatorio permanece en cuarentena.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger expense_reports_require_released_receipts
  before update of status on public.expense_reports
  for each row execute function public.require_released_expense_receipts_on_submit();

revoke all on function public.require_released_expense_receipts_on_submit() from public, anon, authenticated, service_role;

create or replace function public.reclaim_stale_expense_file_scans(p_stale_after_seconds integer default 300)
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
  update public.expense_receipt_captures c
  set security_status = case
        when c.scan_attempt < 3 then 'PENDING_SCAN'::public.expense_file_security_status
        else 'SCAN_FAILED'::public.expense_file_security_status end,
      scan_available_at = pg_catalog.clock_timestamp(),
      scan_locked_at = null, scan_locked_by = null,
      security_scanned_at = case when c.scan_attempt < 3 then null else pg_catalog.clock_timestamp() end,
      security_scanner = case when c.scan_attempt < 3 then null else 'lease-recovery' end,
      security_result_code = case when c.scan_attempt < 3 then null else 'LEASE_EXHAUSTED' end
  where c.security_status = 'SCANNING'
    and c.scan_locked_at < pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => p_stale_after_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_expense_file_scans(p_worker_id uuid, p_limit integer default 3)
returns table (
  capture_id uuid,
  company_id uuid,
  storage_path text,
  mime_type text,
  checksum_sha256 text,
  source text,
  attempt integer
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
    select c.id
    from public.expense_receipt_captures c
    join storage.objects so on so.bucket_id = 'expense-receipts' and so.name = c.storage_path
    where c.security_status = 'PENDING_SCAN'
      and c.source in ('EMAIL', 'WHATSAPP')
      and c.scan_attempt < 3
      and c.scan_available_at <= pg_catalog.clock_timestamp()
      and c.status <> 'DISCARDED'
    order by c.scan_available_at, c.created_at, c.id
    for update of c skip locked
    limit p_limit
  ), claimed as (
    update public.expense_receipt_captures c
    set security_status = 'SCANNING', scan_attempt = c.scan_attempt + 1,
        scan_locked_at = pg_catalog.clock_timestamp(), scan_locked_by = p_worker_id,
        security_scanner = null, security_result_code = null
    from candidates q
    where c.id = q.id and c.scan_attempt < 3
    returning c.*
  )
  select c.id, c.company_id, c.storage_path, c.mime_type,
         c.checksum_sha256, c.source, c.scan_attempt
  from claimed c;
end;
$$;

create or replace function public.complete_expense_file_scan(
  p_capture_id uuid,
  p_worker_id uuid,
  p_verdict text,
  p_scanner text,
  p_result_code text
)
returns public.expense_file_security_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capture public.expense_receipt_captures%rowtype;
  v_next_attempt integer;
begin
  if p_verdict not in ('CLEAN', 'REJECTED')
     or p_scanner !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
     or p_result_code !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$' then
    raise exception 'Veredicto de seguridad inválido.' using errcode = '22023';
  end if;

  update public.expense_receipt_captures c
  set security_status = p_verdict::public.expense_file_security_status,
      scan_locked_at = null, scan_locked_by = null,
      security_scanned_at = pg_catalog.clock_timestamp(),
      security_scanner = p_scanner, security_result_code = p_result_code
  where c.id = p_capture_id and c.security_status = 'SCANNING' and c.scan_locked_by = p_worker_id
  returning c.* into v_capture;
  if not found then raise exception 'Lease de escaneo inexistente o vencida.' using errcode = '40001'; end if;

  if v_capture.attached_receipt_id is not null then
    update public.expense_receipts r
    set security_status = p_verdict::public.expense_file_security_status,
        security_scanned_at = v_capture.security_scanned_at,
        security_scanner = p_scanner, security_result_code = p_result_code,
        status = case when p_verdict = 'CLEAN'
          then 'UPLOADED'::public.expense_receipt_status
          else 'FAILED'::public.expense_receipt_status end,
        extraction = '{}'::jsonb
    where r.company_id = v_capture.company_id and r.id = v_capture.attached_receipt_id;

    update public.expense_items ei
    set receipt_status = case when p_verdict = 'CLEAN'
          then 'UPLOADED'::public.expense_receipt_status
          else 'FAILED'::public.expense_receipt_status end,
        extraction = '{}'::jsonb
    where exists (
      select 1 from public.expense_receipts r
      where r.company_id = ei.company_id and r.item_id = ei.id
        and r.id = v_capture.attached_receipt_id and r.is_current
    );

    if p_verdict = 'CLEAN' then
      select coalesce(max(j.attempt), 0) + 1 into v_next_attempt
      from public.expense_ocr_jobs j
      where j.company_id = v_capture.company_id and j.receipt_id = v_capture.attached_receipt_id;
      if v_next_attempt <= 3 and not exists (
        select 1 from public.expense_ocr_jobs j
        where j.company_id = v_capture.company_id and j.receipt_id = v_capture.attached_receipt_id
          and j.status in ('QUEUED', 'RUNNING', 'WAITING_PROVIDER')
      ) then
        insert into public.expense_ocr_jobs (company_id, receipt_id, attempt)
        values (v_capture.company_id, v_capture.attached_receipt_id, v_next_attempt);
      end if;
    else
      update public.expense_ocr_jobs j
      set status = 'CANCELLED', locked_at = null, locked_by = null,
          finished_at = pg_catalog.clock_timestamp(), error_category = 'FILE_REJECTED',
          error_summary = 'Trabajo cancelado por el veredicto del escáner.'
      where j.company_id = v_capture.company_id and j.receipt_id = v_capture.attached_receipt_id
        and j.status in ('QUEUED', 'RUNNING', 'WAITING_PROVIDER');
    end if;
  end if;
  return p_verdict::public.expense_file_security_status;
end;
$$;

create or replace function public.fail_expense_file_scan(
  p_capture_id uuid,
  p_worker_id uuid,
  p_scanner text,
  p_result_code text,
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
  v_capture public.expense_receipt_captures%rowtype;
  v_retried boolean;
begin
  if p_scanner !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
     or p_result_code !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
     or p_retry_delay_seconds < 1 or p_retry_delay_seconds > 3600 then
    raise exception 'Fallo de escaneo inválido.' using errcode = '22023';
  end if;

  select c.* into v_capture
  from public.expense_receipt_captures c
  where c.id = p_capture_id and c.security_status = 'SCANNING' and c.scan_locked_by = p_worker_id
  for update;
  if not found then raise exception 'Lease de escaneo inexistente o vencida.' using errcode = '40001'; end if;
  v_retried := p_retryable and v_capture.scan_attempt < 3;

  update public.expense_receipt_captures c
  set security_status = case when v_retried
        then 'PENDING_SCAN'::public.expense_file_security_status
        else 'SCAN_FAILED'::public.expense_file_security_status end,
      scan_available_at = case when v_retried
        then pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_delay_seconds)
        else c.scan_available_at end,
      scan_locked_at = null, scan_locked_by = null,
      security_scanned_at = case when v_retried then null else pg_catalog.clock_timestamp() end,
      security_scanner = case when v_retried then null else p_scanner end,
      security_result_code = case when v_retried then null else p_result_code end
  where c.id = p_capture_id;

  if not v_retried and v_capture.attached_receipt_id is not null then
    update public.expense_receipts r
    set security_status = 'SCAN_FAILED', security_scanned_at = pg_catalog.clock_timestamp(),
        security_scanner = p_scanner, security_result_code = p_result_code,
        status = 'FAILED', extraction = '{}'::jsonb
    where r.company_id = v_capture.company_id and r.id = v_capture.attached_receipt_id;
    update public.expense_items ei
    set receipt_status = 'FAILED', extraction = '{}'::jsonb
    where exists (
      select 1 from public.expense_receipts r
      where r.company_id = ei.company_id and r.item_id = ei.id
        and r.id = v_capture.attached_receipt_id and r.is_current
    );
  end if;
  return v_retried;
end;
$$;

revoke all on function public.reclaim_stale_expense_file_scans(integer) from public, anon, authenticated;
revoke all on function public.claim_expense_file_scans(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_expense_file_scan(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_expense_file_scan(uuid, uuid, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_expense_file_scans(integer) to service_role;
grant execute on function public.claim_expense_file_scans(uuid, integer) to service_role;
grant execute on function public.complete_expense_file_scan(uuid, uuid, text, text, text) to service_role;
grant execute on function public.fail_expense_file_scan(uuid, uuid, text, text, boolean, integer) to service_role;

comment on column public.expense_receipt_captures.security_status is
  'Frontera de cuarentena. EMAIL/WHATSAPP no se leen, adjuntan ni procesan antes de CLEAN.';
comment on column public.expense_receipts.security_status is
  'Procedencia de seguridad del archivo: VALIDATED_INTERNAL no equivale a antimalware; CLEAN sí requiere worker.';
comment on function public.claim_expense_file_scans(uuid, integer) is
  'Claim multiempresa SKIP LOCKED; solo service_role y con fencing por worker UUID.';
