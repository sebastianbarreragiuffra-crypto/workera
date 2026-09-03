-- Fase 2 / bloque 2: bandeja personal de comprobantes.
-- Permite capturar primero desde web/cámara y asociar después a un gasto.
-- EMAIL y WHATSAPP quedan reservados como fuentes del mismo pipeline futuro.

create table public.expense_receipt_captures (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  uploaded_by           uuid not null references public.profiles(id),
  source                text not null check (source in ('WEB_UPLOAD', 'WEB_CAMERA', 'EMAIL', 'WHATSAPP')),
  status                text not null default 'PENDING' check (status in ('PENDING', 'ATTACHED', 'DISCARDED')),
  storage_path          text not null unique,
  original_filename     text not null check (char_length(btrim(original_filename)) between 1 and 240),
  mime_type             text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_size             integer not null check (file_size > 0 and file_size <= 10485760),
  checksum_sha256       text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  external_message_id   text check (external_message_id is null or char_length(external_message_id) between 1 and 240),
  attached_receipt_id   uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  attached_at           timestamptz,
  discarded_at          timestamptz,
  unique (company_id, id),
  foreign key (company_id, attached_receipt_id)
    references public.expense_receipts(company_id, id) on delete set null,
  constraint expense_receipt_captures_resolution_check check (
    (status = 'PENDING' and attached_receipt_id is null and attached_at is null and discarded_at is null)
    or (status = 'ATTACHED' and attached_receipt_id is not null and attached_at is not null and discarded_at is null)
    or (status = 'DISCARDED' and attached_receipt_id is null and attached_at is null and discarded_at is not null)
  )
);

create index expense_receipt_captures_inbox_idx
  on public.expense_receipt_captures(company_id, uploaded_by, created_at desc)
  where status = 'PENDING';
create index expense_receipt_captures_checksum_idx
  on public.expense_receipt_captures(company_id, checksum_sha256)
  where status = 'PENDING';
create unique index expense_receipt_captures_external_message_idx
  on public.expense_receipt_captures(company_id, source, external_message_id)
  where external_message_id is not null;

create trigger expense_receipt_captures_set_updated_at
  before update on public.expense_receipt_captures
  for each row execute function public.set_updated_at();

-- Si el usuario elimina un gasto todavía en borrador, su archivo vuelve a
-- la bandeja siempre que haya cupo. La misma advisory lock usada al registrar
-- capturas impide que un borrado y una carga simultáneos excedan el máximo.
-- Con la bandeja llena se bloquea el borrado: no se pierde evidencia ni se
-- deja un objeto de Storage huérfano que este trigger no podría retirar.
create or replace function public.restore_expense_capture_on_receipt_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capture_id uuid;
  v_company_id uuid;
  v_uploaded_by uuid;
  v_pending_count integer;
begin
  -- Lee primero el ámbito sin retener la fila. Todas las operaciones que
  -- cambian el cupo toman después la advisory lock en el mismo orden; recién
  -- entonces se bloquea y revalida la captura concreta.
  select c.company_id, c.uploaded_by
    into v_company_id, v_uploaded_by
  from public.expense_receipt_captures c
  where c.company_id = old.company_id
    and c.attached_receipt_id = old.id
    and c.status = 'ATTACHED';

  if not found then return old; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_company_id::text || ':' || v_uploaded_by::text, 0)
  );

  select c.id into v_capture_id
  from public.expense_receipt_captures c
  where c.company_id = v_company_id
    and c.uploaded_by = v_uploaded_by
    and c.attached_receipt_id = old.id
    and c.status = 'ATTACHED'
  for update;
  if not found then return old; end if;

  select count(*) into v_pending_count
  from public.expense_receipt_captures c
  where c.company_id = v_company_id
    and c.uploaded_by = v_uploaded_by
    and c.status = 'PENDING';

  if v_pending_count >= 50 then
    raise exception 'Libera un espacio en tu bandeja de comprobantes antes de borrar este gasto.' using errcode = '54000';
  end if;

  update public.expense_receipt_captures c
  set status = 'PENDING', attached_receipt_id = null, attached_at = null
  where c.id = v_capture_id;
  return old;
end;
$$;

create trigger expense_receipts_restore_capture_before_delete
  before delete on public.expense_receipts
  for each row execute function public.restore_expense_capture_on_receipt_delete();

-- Cierra la carrera entre adjuntar y enviar. register_expense_receipt() y
-- attach_expense_receipt_capture() validan DRAFT antes, pero el estado puede
-- cambiar entre esa lectura y el INSERT. Este trigger bloquea la rendición
-- justo antes de insertar y vuelve a validar dentro de la misma transacción.
create or replace function public.require_draft_report_for_expense_receipt()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status public.expense_report_status;
begin
  select er.status into v_status
  from public.expense_reports er
  where er.company_id = new.company_id and er.id = new.report_id
  for update;
  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if v_status <> 'DRAFT' then
    raise exception 'Solo se adjuntan comprobantes en borradores.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger expense_receipts_require_draft_before_insert
  before insert on public.expense_receipts
  for each row execute function public.require_draft_report_for_expense_receipt();

revoke all on function public.restore_expense_capture_on_receipt_delete() from public, anon, authenticated;
revoke all on function public.require_draft_report_for_expense_receipt() from public, anon, authenticated;

-- Variante explícita para operaciones service_role. No usa auth.uid(): el
-- backend entrega el actor autenticado y la base vuelve a verificar que esa
-- persona sigue activa y tiene el permiso solicitado.
create or replace function public.expense_actor_has_permission(
  p_actor_id uuid,
  p_company_id uuid,
  p_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    join public.companies c on c.id = cm.company_id
    join public.profiles p on p.id = cm.user_id
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id and cr.id = cmr.role_id and cr.active
    join public.company_role_permissions crp
      on crp.company_id = cr.company_id and crp.role_id = cr.id
    where cm.company_id = p_company_id
      and cm.user_id = p_actor_id
      and cm.active and c.active and c.status in ('ACTIVE', 'ONBOARDING') and p.active
      and crp.permission_code = p_permission_code
  );
$$;

revoke all on function public.expense_actor_has_permission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.expense_actor_has_permission(uuid, uuid, text) to service_role;

alter table public.expense_receipt_captures enable row level security;

create policy expense_receipt_captures_read_own
  on public.expense_receipt_captures for select to authenticated
  using (
    uploaded_by = auth.uid()
    and public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (public.has_company_permission(company_id, 'expenses.submit')
      or public.has_company_permission(company_id, 'expenses.manage'))
  );

revoke all on public.expense_receipt_captures from public, anon, authenticated, service_role;
grant select on public.expense_receipt_captures to authenticated;
grant select, insert, update on public.expense_receipt_captures to service_role;

-- Ruta de captura: {company}/{user}/inbox/{uuid}.{pdf|jpg|jpeg|png}
create or replace function public.can_upload_expense_capture_path(p_name text)
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
begin
  if v_actor_id is null or pg_catalog.array_length(v_parts, 1) <> 4 then return false; end if;
  if v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] <> v_actor_id::text
     or v_parts[3] <> 'inbox'
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
  then return false; end if;

  v_company_id := v_parts[1]::uuid;
  return public.company_has_module(v_company_id, 'expenses')
    and public.is_active_company_member(v_company_id)
    and (public.has_company_permission(v_company_id, 'expenses.submit')
      or public.has_company_permission(v_company_id, 'expenses.manage'));
exception when others then
  return false;
end;
$$;

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
      and public.company_has_module(c.company_id, 'expenses')
      and public.is_active_company_member(c.company_id)
      and (public.has_company_permission(c.company_id, 'expenses.submit')
        or public.has_company_permission(c.company_id, 'expenses.manage'))
  );
$$;

revoke all on function public.can_upload_expense_capture_path(text) from public, anon;
revoke all on function public.can_read_expense_capture_path(text) from public, anon;
grant execute on function public.can_upload_expense_capture_path(text) to authenticated;
grant execute on function public.can_read_expense_capture_path(text) to authenticated;

-- Desde este bloque ningún navegador escribe archivos directamente. Las dos
-- cargas (a gasto y a bandeja) pasan por el servicio server-only, que calcula
-- el hash sobre los bytes y usa service_role. Esto evita hashes inventados y
-- objetos huérfanos ilimitados subidos por fuera de la aplicación.
drop policy if exists "expense_receipts_storage_insert" on storage.objects;
drop policy if exists "expense_receipts_storage_delete_orphan" on storage.objects;

drop policy "expense_receipts_storage_select" on storage.objects;
create policy "expense_receipts_storage_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'expense-receipts'
    and (
      public.can_read_expense_receipt_path(name)
      or public.can_read_expense_capture_path(name)
    )
  );

create or replace function public.register_expense_receipt_capture(
  p_actor_id uuid,
  p_company_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size integer,
  p_checksum_sha256 text,
  p_source text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capture_id uuid := gen_random_uuid();
begin
  if p_actor_id is null or p_company_id is null then raise exception 'Actor y empresa son obligatorios.' using errcode = '22004'; end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes capturar comprobantes en esta empresa.' using errcode = '42501';
  end if;
  if p_storage_path !~ ('^' || p_company_id::text || '/' || p_actor_id::text || '/inbox/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$') then
    raise exception 'La ruta de captura no corresponde a la empresa y usuario.' using errcode = '42501';
  end if;
  if p_source not in ('WEB_UPLOAD', 'WEB_CAMERA')
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     or p_file_size <= 0 or p_file_size > 10485760
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(btrim(p_original_filename)) not between 1 and 240 then
    raise exception 'Captura inválida.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'expense-receipts' and so.name = p_storage_path
  ) then
    raise exception 'El archivo no existe en el almacenamiento privado.' using errcode = '23503';
  end if;

  -- Serializa el cupo por empresa/persona: dos cargas simultáneas en el
  -- pendiente 49 no pueden atravesar juntas el límite de 50.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );
  if (
    select count(*)
    from public.expense_receipt_captures c
    where c.company_id = p_company_id and c.uploaded_by = p_actor_id and c.status = 'PENDING'
  ) >= 50 then
    raise exception 'Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.' using errcode = '54000';
  end if;

  insert into public.expense_receipt_captures (
    id, company_id, uploaded_by, source, storage_path, original_filename,
    mime_type, file_size, checksum_sha256
  ) values (
    v_capture_id, p_company_id, p_actor_id, p_source, p_storage_path,
    btrim(p_original_filename), p_mime_type, p_file_size, p_checksum_sha256
  );
  return v_capture_id;
end;
$$;

create or replace function public.register_expense_receipt_trusted(
  p_actor_id uuid,
  p_company_id uuid,
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
  v_report_id uuid;
  v_submitter_id uuid;
  v_status public.expense_report_status;
  v_version integer;
  v_receipt_id uuid := gen_random_uuid();
  v_duplicate_id uuid;
begin
  if p_actor_id is null or p_company_id is null or p_item_id is null then
    raise exception 'Actor, empresa y gasto son obligatorios.' using errcode = '22004';
  end if;
  if p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     or p_file_size <= 0 or p_file_size > 10485760
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(btrim(p_original_filename)) not between 1 and 240 then
    raise exception 'Comprobante inválido.' using errcode = '23514';
  end if;

  select ei.report_id, er.submitted_by, er.status
    into v_report_id, v_submitter_id, v_status
  from public.expense_items ei
  join public.expense_reports er on er.company_id = ei.company_id and er.id = ei.report_id
  where ei.company_id = p_company_id and ei.id = p_item_id
  for update of er, ei;
  if not found then raise exception 'Gasto inexistente.' using errcode = '23503'; end if;
  if v_status <> 'DRAFT' then raise exception 'Solo se adjuntan comprobantes en borradores.' using errcode = '23514'; end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage'))
     or (v_submitter_id <> p_actor_id
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes adjuntar comprobantes a este gasto.' using errcode = '42501';
  end if;
  if p_storage_path !~ ('^' || p_company_id::text || '/' || p_actor_id::text || '/'
      || v_report_id::text || '/' || p_item_id::text || '/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$') then
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
  where r.company_id = p_company_id and r.item_id = p_item_id;

  select r.id into v_duplicate_id
  from public.expense_receipts r
  where r.company_id = p_company_id
    and r.item_id <> p_item_id
    and r.checksum_sha256 = p_checksum_sha256
  order by r.created_at, r.id
  limit 1;

  update public.expense_receipts r
  set is_current = false
  where r.company_id = p_company_id and r.item_id = p_item_id and r.is_current;

  insert into public.expense_receipts (
    id, company_id, report_id, item_id, version, storage_path,
    original_filename, mime_type, file_size, checksum_sha256,
    uploaded_by, duplicate_of_receipt_id
  ) values (
    v_receipt_id, p_company_id, v_report_id, p_item_id, v_version, p_storage_path,
    btrim(p_original_filename), p_mime_type, p_file_size, p_checksum_sha256,
    p_actor_id, v_duplicate_id
  );

  update public.expense_items ei
  set receipt_status = 'UPLOADED', receipt_storage_path = p_storage_path,
      extraction = '{}'::jsonb, duplicate_fingerprint = p_checksum_sha256
  where ei.company_id = p_company_id and ei.id = p_item_id;

  return v_receipt_id;
end;
$$;

create or replace function public.attach_expense_receipt_capture(
  p_capture_id uuid,
  p_item_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_capture public.expense_receipt_captures%rowtype;
  v_company_id uuid;
  v_report_id uuid;
  v_submitter_id uuid;
  v_report_status public.expense_report_status;
  v_version integer;
  v_receipt_id uuid := gen_random_uuid();
  v_duplicate_id uuid;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_capture_id is null or p_item_id is null then raise exception 'captura y gasto son obligatorios.' using errcode = '22004'; end if;

  select * into v_capture
  from public.expense_receipt_captures c
  where c.id = p_capture_id
  for update;
  if not found then raise exception 'Captura inexistente.' using errcode = '23503'; end if;
  if v_capture.status <> 'PENDING' then raise exception 'La captura ya fue resuelta.' using errcode = '23514'; end if;
  if v_capture.uploaded_by <> v_actor_id then raise exception 'La captura pertenece a otra persona.' using errcode = '42501'; end if;

  select ei.company_id, ei.report_id, er.submitted_by, er.status
    into v_company_id, v_report_id, v_submitter_id, v_report_status
  from public.expense_items ei
  join public.expense_reports er on er.company_id = ei.company_id and er.id = ei.report_id
  where ei.id = p_item_id
  for update of er, ei;
  if not found then raise exception 'Gasto inexistente.' using errcode = '23503'; end if;
  if v_company_id <> v_capture.company_id then raise exception 'La captura y el gasto pertenecen a empresas distintas.' using errcode = '42501'; end if;
  if v_report_status <> 'DRAFT' then raise exception 'Solo se adjuntan comprobantes en borradores.' using errcode = '23514'; end if;
  if not public.company_has_module(v_company_id, 'expenses')
     or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.submit')
       and not public.has_company_permission(v_company_id, 'expenses.manage'))
     or (v_submitter_id <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'No puedes adjuntar esta captura al gasto.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'expense-receipts' and so.name = v_capture.storage_path
  ) then
    raise exception 'El archivo capturado ya no está disponible.' using errcode = '23503';
  end if;

  select coalesce(max(r.version), 0) + 1 into v_version
  from public.expense_receipts r
  where r.company_id = v_company_id and r.item_id = p_item_id;

  select r.id into v_duplicate_id
  from public.expense_receipts r
  where r.company_id = v_company_id
    and r.item_id <> p_item_id
    and r.checksum_sha256 = v_capture.checksum_sha256
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
    v_receipt_id, v_company_id, v_report_id, p_item_id, v_version, v_capture.storage_path,
    v_capture.original_filename, v_capture.mime_type, v_capture.file_size, v_capture.checksum_sha256,
    v_actor_id, v_duplicate_id
  );

  update public.expense_items ei
  set receipt_status = 'UPLOADED', receipt_storage_path = v_capture.storage_path,
      extraction = '{}'::jsonb, duplicate_fingerprint = v_capture.checksum_sha256
  where ei.company_id = v_company_id and ei.id = p_item_id;

  update public.expense_receipt_captures c
  set status = 'ATTACHED', attached_receipt_id = v_receipt_id, attached_at = now()
  where c.company_id = v_company_id and c.id = p_capture_id;

  return v_receipt_id;
end;
$$;

create or replace function public.discard_expense_receipt_capture(
  p_actor_id uuid,
  p_company_id uuid,
  p_capture_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
begin
  if p_actor_id is null or p_company_id is null then raise exception 'Actor y empresa son obligatorios.' using errcode = '22004'; end if;
  update public.expense_receipt_captures c
  set status = 'DISCARDED', discarded_at = now()
  where c.company_id = p_company_id and c.id = p_capture_id
    and c.uploaded_by = p_actor_id and c.status = 'PENDING'
    and public.company_has_module(c.company_id, 'expenses')
    and (public.expense_actor_has_permission(p_actor_id, c.company_id, 'expenses.submit')
      or public.expense_actor_has_permission(p_actor_id, c.company_id, 'expenses.manage'))
  returning c.storage_path into v_storage_path;
  if not found then raise exception 'La captura no existe o ya fue resuelta.' using errcode = '23514'; end if;
  return v_storage_path;
end;
$$;

revoke execute on function public.register_expense_receipt(uuid, text, text, text, integer, text) from authenticated;
revoke all on function public.register_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.register_expense_receipt_trusted(uuid, uuid, uuid, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.attach_expense_receipt_capture(uuid, uuid) from public, anon;
revoke all on function public.discard_expense_receipt_capture(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text) to service_role;
grant execute on function public.register_expense_receipt_trusted(uuid, uuid, uuid, text, text, text, integer, text) to service_role;
grant execute on function public.attach_expense_receipt_capture(uuid, uuid) to authenticated;
grant execute on function public.discard_expense_receipt_capture(uuid, uuid, uuid) to service_role;

comment on table public.expense_receipt_captures is
  'Bandeja personal y tenant-aware de comprobantes capturados antes de asociarlos a una rendición.';
comment on column public.expense_receipt_captures.external_message_id is
  'Clave idempotente reservada para conectores futuros de correo y WhatsApp.';
