-- GESTORA Rendiciones EX-3: comprobantes privados, detección de duplicados
-- y circuito de aprobación. Todo acceso sigue acotado por empresa.

alter table public.expense_reports
  add column review_round integer not null default 0 check (review_round >= 0);

alter table public.expense_items
  add constraint expense_items_company_report_item_key unique (company_id, report_id, id);

create table public.expense_receipts (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  report_id             uuid not null,
  item_id               uuid not null,
  version               integer not null check (version > 0),
  is_current            boolean not null default true,
  storage_path          text not null unique,
  original_filename     text not null check (char_length(btrim(original_filename)) between 1 and 240),
  mime_type             text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_size             integer not null check (file_size > 0 and file_size <= 10485760),
  checksum_sha256       text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by           uuid not null references public.profiles(id),
  status                public.expense_receipt_status not null default 'UPLOADED'
                          check (status <> 'NOT_PROVIDED'),
  extraction            jsonb not null default '{}'::jsonb check (jsonb_typeof(extraction) = 'object'),
  duplicate_of_receipt_id uuid,
  created_at            timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, item_id, version),
  foreign key (company_id, report_id, item_id)
    references public.expense_items(company_id, report_id, id) on delete cascade,
  foreign key (company_id, duplicate_of_receipt_id)
    references public.expense_receipts(company_id, id)
);

create unique index expense_receipts_one_current_per_item_idx
  on public.expense_receipts(company_id, item_id) where is_current;
create index expense_receipts_report_idx
  on public.expense_receipts(company_id, report_id, created_at desc);
create index expense_receipts_checksum_idx
  on public.expense_receipts(company_id, checksum_sha256);

alter table public.expense_receipts enable row level security;

-- El navegador podía modificar estos campos derivados en EX-1. Desde EX-3
-- solo register_expense_receipt y futuros workers controlados los cambian.
revoke update (receipt_status, receipt_storage_path, extraction, duplicate_fingerprint)
  on public.expense_items from authenticated;

create policy expense_receipts_read on public.expense_receipts for select to authenticated
  using (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_receipts.company_id
      and er.id = expense_receipts.report_id
  ));

revoke all on public.expense_receipts from public, anon, authenticated, service_role;
grant select on public.expense_receipts to authenticated;
grant select on public.expense_receipts to service_role;
grant update (status, extraction) on public.expense_receipts to service_role;

-- Storage usa una ruta verificable y no confía en IDs enviados como metadata:
-- {company}/{user}/{report}/{item}/{uuid}.{pdf|jpg|jpeg|png}
create or replace function public.can_upload_expense_receipt_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := pg_catalog.string_to_array(p_name, '/');
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_report_id uuid;
  v_item_id uuid;
begin
  if v_actor_id is null or pg_catalog.array_length(v_parts, 1) <> 5 then return false; end if;
  if v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] <> v_actor_id::text
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[5] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
  then return false; end if;

  v_company_id := v_parts[1]::uuid;
  v_report_id := v_parts[3]::uuid;
  v_item_id := v_parts[4]::uuid;

  return public.company_has_module(v_company_id, 'expenses')
    and public.is_active_company_member(v_company_id)
    and (public.has_company_permission(v_company_id, 'expenses.submit')
      or public.has_company_permission(v_company_id, 'expenses.manage'))
    and exists (
      select 1
      from public.expense_items ei
      join public.expense_reports er
        on er.company_id = ei.company_id and er.id = ei.report_id
      where ei.company_id = v_company_id and ei.report_id = v_report_id and ei.id = v_item_id
        and er.status = 'DRAFT'
        and (er.submitted_by = v_actor_id or public.has_company_permission(v_company_id, 'expenses.manage'))
    );
exception when others then
  return false;
end;
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

revoke all on function public.can_upload_expense_receipt_path(text) from public, anon;
revoke all on function public.can_read_expense_receipt_path(text) from public, anon;
grant execute on function public.can_upload_expense_receipt_path(text) to authenticated;
grant execute on function public.can_read_expense_receipt_path(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-receipts', 'expense-receipts', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "expense_receipts_storage_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'expense-receipts'
    and public.can_upload_expense_receipt_path(name)
  );

create policy "expense_receipts_storage_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'expense-receipts'
    and public.can_read_expense_receipt_path(name)
  );

-- Registra o reemplaza el comprobante solo después de verificar que el objeto
-- existe en el bucket privado. También mantiene el espejo de estado del ítem.
create or replace function public.register_expense_receipt(
  p_item_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size integer,
  p_checksum_sha256 text
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
  v_report_id uuid;
  v_submitter_id uuid;
  v_status public.expense_report_status;
  v_version integer;
  v_receipt_id uuid := gen_random_uuid();
  v_duplicate_id uuid;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_item_id is null or p_storage_path is null then raise exception 'item_id y storage_path son obligatorios.' using errcode = '22004'; end if;
  if p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     or p_file_size <= 0 or p_file_size > 10485760
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(btrim(p_original_filename)) not between 1 and 240 then
    raise exception 'Comprobante inválido.' using errcode = '23514';
  end if;

  select ei.company_id, ei.report_id, er.submitted_by, er.status
    into v_company_id, v_report_id, v_submitter_id, v_status
  from public.expense_items ei
  join public.expense_reports er on er.company_id = ei.company_id and er.id = ei.report_id
  where ei.id = p_item_id
  for update of ei;

  if not found then raise exception 'Gasto inexistente.' using errcode = '23503'; end if;
  if v_status <> 'DRAFT' then raise exception 'Solo se adjuntan comprobantes en borradores.' using errcode = '23514'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (v_submitter_id <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage'))
     or (not public.has_company_permission(v_company_id, 'expenses.submit') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'No puedes adjuntar comprobantes a este gasto.' using errcode = '42501';
  end if;
  if not public.can_upload_expense_receipt_path(p_storage_path) then
    raise exception 'La ruta del comprobante no corresponde al gasto y usuario.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'expense-receipts' and so.name = p_storage_path
  ) then
    raise exception 'El archivo no existe en el almacenamiento privado.' using errcode = '23503';
  end if;

  select coalesce(max(r.version), 0) + 1 into v_version
  from public.expense_receipts r
  where r.company_id = v_company_id and r.item_id = p_item_id;

  select r.id into v_duplicate_id
  from public.expense_receipts r
  where r.company_id = v_company_id
    and r.item_id <> p_item_id
    and r.checksum_sha256 = p_checksum_sha256
  order by r.created_at, r.id
  limit 1;

  update public.expense_receipts r
  set is_current = false
  where r.company_id = v_company_id and r.item_id = p_item_id and r.is_current;

  insert into public.expense_receipts (
    id, company_id, report_id, item_id, version, storage_path,
    original_filename, mime_type, file_size, checksum_sha256,
    uploaded_by, duplicate_of_receipt_id
  ) values (
    v_receipt_id, v_company_id, v_report_id, p_item_id, v_version, p_storage_path,
    btrim(p_original_filename), p_mime_type, p_file_size, p_checksum_sha256,
    v_actor_id, v_duplicate_id
  );

  update public.expense_items ei
  set receipt_status = 'UPLOADED', receipt_storage_path = p_storage_path,
      extraction = '{}'::jsonb, duplicate_fingerprint = p_checksum_sha256
  where ei.company_id = v_company_id and ei.id = p_item_id;

  return v_receipt_id;
end;
$$;

revoke all on function public.register_expense_receipt(uuid, text, text, text, integer, text) from public, anon;
grant execute on function public.register_expense_receipt(uuid, text, text, text, integer, text) to authenticated;

-- Cada envío abre una ronda nueva. Las categorías configuradas como
-- obligatorias no pueden enviarse sin un comprobante vigente.
create or replace function public.submit_expense_report(p_report_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitted_by uuid;
  v_status public.expense_report_status;
  v_total numeric(16,2);
  v_item_count integer;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status, er.total_amount
    into v_company_id, v_submitted_by, v_status, v_total
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id) then
    raise exception 'Rendiciones no está habilitado para esta membresía.' using errcode = '42501';
  end if;
  if v_submitted_by <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'No puedes enviar una rendición de otra persona.' using errcode = '42501';
  end if;
  if not public.has_company_permission(v_company_id, 'expenses.submit') and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'Tu rol no permite enviar rendiciones.' using errcode = '42501';
  end if;
  if v_status <> 'DRAFT' then raise exception 'Solo se puede enviar una rendición en borrador.' using errcode = '23514'; end if;

  select count(*)::integer into v_item_count from public.expense_items ei
  where ei.company_id = v_company_id and ei.report_id = p_report_id;
  if v_item_count = 0 or v_total <= 0 then
    raise exception 'Agrega al menos un gasto con monto mayor a cero antes de enviar.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.expense_items ei
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ei.currency_code <> (select er.currency_code from public.expense_reports er where er.id = p_report_id)
  ) then raise exception 'Todos los gastos deben usar la moneda de la rendición.' using errcode = '23514'; end if;
  if exists (
    select 1
    from public.expense_items ei
    join public.expense_categories ec on ec.company_id = ei.company_id and ec.id = ei.category_id
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ec.requires_receipt
      and not exists (
        select 1 from public.expense_receipts r
        where r.company_id = ei.company_id and r.item_id = ei.id and r.is_current
      )
  ) then raise exception 'Adjunta los comprobantes obligatorios antes de enviar.' using errcode = '23514'; end if;

  update public.expense_reports er
  set status = 'SUBMITTED', submitted_at = pg_catalog.clock_timestamp(),
      resolved_at = null, review_round = er.review_round + 1
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

create or replace function public.decide_expense_report(
  p_report_id uuid,
  p_decision public.expense_approval_decision,
  p_comment text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitted_by uuid;
  v_status public.expense_report_status;
  v_review_round integer;
  v_comment text := nullif(btrim(p_comment), '');
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null or p_decision is null then raise exception 'report_id y decision son obligatorios.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status, er.review_round
    into v_company_id, v_submitted_by, v_status, v_review_round
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.approve') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite decidir esta rendición.' using errcode = '42501';
  end if;
  if v_submitted_by = v_actor_id then
    raise exception 'No puedes aprobar ni rechazar tu propia rendición.' using errcode = '42501';
  end if;
  if v_status not in ('SUBMITTED', 'IN_REVIEW') then
    raise exception 'La rendición no está pendiente de revisión.' using errcode = '23514';
  end if;
  if p_decision in ('REJECTED', 'RETURNED') and v_comment is null then
    raise exception 'Debes explicar el rechazo o la devolución.' using errcode = '23514';
  end if;

  insert into public.expense_approval_decisions (
    company_id, report_id, step_number, decided_by, decision, comment
  ) values (v_company_id, p_report_id, v_review_round, v_actor_id, p_decision, v_comment);

  update public.expense_reports er
  set status = case p_decision
      when 'APPROVED' then 'APPROVED'::public.expense_report_status
      when 'REJECTED' then 'REJECTED'::public.expense_report_status
      else 'DRAFT'::public.expense_report_status end,
      submitted_at = case when p_decision = 'RETURNED' then null else er.submitted_at end,
      resolved_at = case when p_decision = 'RETURNED' then null else pg_catalog.clock_timestamp() end
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

drop policy if exists expense_approvals_create on public.expense_approval_decisions;
revoke insert on public.expense_approval_decisions from authenticated;
revoke all on function public.decide_expense_report(uuid, public.expense_approval_decision, text) from public, anon;
grant execute on function public.decide_expense_report(uuid, public.expense_approval_decision, text) to authenticated;

comment on table public.expense_receipts is
  'Versiones inmutables de comprobantes privados por empresa; is_current identifica el archivo vigente y duplicate_of_receipt_id alerta reutilizaciones.';
comment on function public.decide_expense_report(uuid, public.expense_approval_decision, text) is
  'Decisión atómica de una ronda de revisión; exige permiso, comentario al devolver/rechazar e impide autoaprobación.';
