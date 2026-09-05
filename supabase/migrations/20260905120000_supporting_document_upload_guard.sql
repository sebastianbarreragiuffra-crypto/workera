-- P0-A: documentos laborales privados.
--
-- El límite de 10 MiB vivía solo en Next.js y la policy de Storage permitía
-- que un usuario autenticado subiera objetos directamente, sin cuota ni una
-- intención registrada. Además, metadata y licencia médica se creaban en
-- tres requests independientes: un fallo intermedio podía dejar objetos o
-- registros clínicos huérfanos. Esta migración convierte el upload en un
-- protocolo reserve -> upload -> commit, con commit SQL atómico.

create table public.supporting_document_upload_limits (
  actor_id          uuid primary key references public.profiles(id),
  window_started_at timestamptz not null,
  request_count     integer not null check (request_count >= 0),
  byte_count        bigint not null check (byte_count >= 0),
  updated_at        timestamptz not null default now()
);

alter table public.supporting_document_upload_limits enable row level security;
revoke all on table public.supporting_document_upload_limits from public, anon, authenticated;

create table public.supporting_document_upload_intents (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references public.profiles(id),
  employee_id   uuid not null references public.employees(id),
  storage_path  text not null unique,
  mime_type     text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_size     integer not null check (file_size between 1 and 10485760),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint supporting_document_upload_intents_consumed_chk
    check (consumed_at is null or consumed_at >= created_at)
);

create index supporting_document_upload_intents_actor_created_idx
  on public.supporting_document_upload_intents (actor_id, created_at desc);
create index supporting_document_upload_intents_pending_idx
  on public.supporting_document_upload_intents (expires_at)
  where consumed_at is null;

alter table public.supporting_document_upload_intents enable row level security;
revoke all on table public.supporting_document_upload_intents from public, anon, authenticated;

-- El bucket impone el mismo límite incluso si alguien evita Next.js.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supporting-documents', 'supporting-documents', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.reserve_supporting_document_upload(
  p_employee_id uuid,
  p_mime_type text,
  p_extension text,
  p_file_size integer
)
returns table (intent_id uuid, storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_window timestamptz := date_trunc('hour', v_now);
  v_count integer;
  v_bytes bigint;
  v_intent_id uuid := gen_random_uuid();
  v_extension text;
  v_expected_mime text;
begin
  if v_actor_id is null then
    raise exception 'Debes iniciar sesión para adjuntar documentos.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if p_employee_id is null or not public.can_manage_employee(p_employee_id) then
    raise exception 'No puedes adjuntar documentos a este trabajador.' using errcode = '42501';
  end if;
  if p_file_size is null or p_file_size < 1 or p_file_size > 10485760 then
    raise exception 'El documento debe pesar entre 1 byte y 10 MiB.' using errcode = '22023';
  end if;

  v_extension := lower(trim(coalesce(p_extension, '')));
  v_expected_mime := case v_extension
    when 'pdf' then 'application/pdf'
    when 'jpg' then 'image/jpeg'
    when 'png' then 'image/png'
    else null
  end;
  if v_expected_mime is null or p_mime_type is distinct from v_expected_mime then
    raise exception 'El formato del documento no está permitido.' using errcode = '22023';
  end if;

  -- El lock por actor hace que la cuota sea correcta con múltiples instancias.
  perform pg_advisory_xact_lock(hashtextextended('supporting-document-upload|' || v_actor_id::text, 0));
  select l.request_count, l.byte_count into v_count, v_bytes
  from public.supporting_document_upload_limits l
  where l.actor_id = v_actor_id and l.window_started_at = v_window;
  v_count := coalesce(v_count, 0);
  v_bytes := coalesce(v_bytes, 0);
  if v_count >= 30 or v_bytes + p_file_size > 104857600 then
    raise exception 'Alcanzaste el límite horario de documentos. Intenta nuevamente más tarde.'
      using errcode = 'P0001';
  end if;

  insert into public.supporting_document_upload_limits
    (actor_id, window_started_at, request_count, byte_count, updated_at)
  values (v_actor_id, v_window, v_count + 1, v_bytes + p_file_size, v_now)
  on conflict (actor_id) do update set
    window_started_at = excluded.window_started_at,
    request_count = excluded.request_count,
    byte_count = excluded.byte_count,
    updated_at = excluded.updated_at;

  intent_id := v_intent_id;
  storage_path := p_employee_id::text || '/' || v_intent_id::text || '.' || v_extension;
  insert into public.supporting_document_upload_intents
    (id, actor_id, employee_id, storage_path, mime_type, file_size, expires_at)
  values
    (intent_id, v_actor_id, p_employee_id, storage_path, p_mime_type, p_file_size, v_now + interval '10 minutes');
  return next;
end;
$$;

comment on function public.reserve_supporting_document_upload(uuid, text, text, integer) is
  'Reserva por 10 minutos una ruta opaca de Storage para un documento laboral. '
  'Autoriza empleado, aplica MFA futuro y limita a 30 objetos/100 MiB por actor/hora.';

revoke all on function public.reserve_supporting_document_upload(uuid, text, text, integer) from public, anon;
grant execute on function public.reserve_supporting_document_upload(uuid, text, text, integer) to authenticated;

drop function if exists public.can_upload_supporting_document_path(text);
create or replace function public.can_upload_supporting_document_path(
  p_storage_path text,
  p_mime_type text,
  p_file_size text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_file_size is null or length(p_file_size) > 8 or p_file_size !~ '^[0-9]+$' then return false; end if;
  return auth.uid() is not null and exists (
    select 1
    from public.supporting_document_upload_intents i
    where i.storage_path = p_storage_path
      and i.actor_id = auth.uid()
      and i.consumed_at is null
      and i.expires_at > now()
      and i.mime_type = p_mime_type
      and i.file_size = p_file_size::integer
  );
end;
$$;

create or replace function public.can_delete_orphan_supporting_document_path(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.supporting_document_upload_intents i
      where i.storage_path = p_storage_path
        and i.actor_id = auth.uid()
        and i.consumed_at is null
    )
    and not exists (
      select 1 from public.supporting_documents d where d.storage_path = p_storage_path
    );
$$;

revoke all on function public.can_upload_supporting_document_path(text, text, text) from public, anon;
revoke all on function public.can_delete_orphan_supporting_document_path(text) from public, anon;
grant execute on function public.can_upload_supporting_document_path(text, text, text) to authenticated;
grant execute on function public.can_delete_orphan_supporting_document_path(text) to authenticated;

drop policy if exists supporting_documents_storage_insert on storage.objects;
create policy supporting_documents_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'supporting-documents'
    and public.can_upload_supporting_document_path(
      name,
      metadata ->> 'mimetype',
      metadata ->> 'size'
    )
  );

drop policy if exists supporting_documents_storage_delete_orphan on storage.objects;
create policy supporting_documents_storage_delete_orphan
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'supporting-documents'
    and public.can_delete_orphan_supporting_document_path(name)
  );

create or replace function public.register_supporting_document_upload(
  p_intent_id uuid,
  p_document_type text,
  p_original_filename text,
  p_absence_record_id uuid default null,
  p_late_arrival_decision_id uuid default null,
  p_early_departure_record_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_intent public.supporting_document_upload_intents%rowtype;
  v_document_id uuid := gen_random_uuid();
begin
  if v_actor_id is null then
    raise exception 'Debes iniciar sesión para registrar documentos.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  select * into v_intent
  from public.supporting_document_upload_intents i
  where i.id = p_intent_id and i.actor_id = v_actor_id
  for update;
  if not found or v_intent.consumed_at is not null or v_intent.expires_at <= clock_timestamp() then
    raise exception 'La reserva del documento no existe o venció.' using errcode = '42501';
  end if;
  if not public.can_manage_employee(v_intent.employee_id) then
    raise exception 'Ya no puedes adjuntar documentos a este trabajador.' using errcode = '42501';
  end if;
  if p_document_type not in ('MEDICAL_CERTIFICATE', 'TRANSPORT_PROOF', 'IDENTIFICATION', 'OTHER') then
    raise exception 'El tipo de documento no es válido.' using errcode = '22023';
  end if;
  if p_original_filename is null or length(trim(p_original_filename)) < 1 or length(p_original_filename) > 240 then
    raise exception 'El nombre original del documento no es válido.' using errcode = '22023';
  end if;
  if num_nonnulls(p_absence_record_id, p_late_arrival_decision_id, p_early_departure_record_id) > 1 then
    raise exception 'Un documento solo puede respaldar un caso.' using errcode = '23514';
  end if;
  if p_absence_record_id is not null and not exists (
    select 1 from public.absence_records ar
    where ar.id = p_absence_record_id and ar.employee_id = v_intent.employee_id
  ) then
    raise exception 'La ausencia no corresponde al trabajador.' using errcode = '23503';
  end if;
  if p_late_arrival_decision_id is not null and not exists (
    select 1
    from public.late_arrival_decisions d
    join public.late_arrival_records r on r.id = d.late_arrival_record_id
    where d.id = p_late_arrival_decision_id and r.employee_id = v_intent.employee_id
  ) then
    raise exception 'La decisión de atraso no corresponde al trabajador.' using errcode = '23503';
  end if;
  if p_early_departure_record_id is not null and not exists (
    select 1 from public.early_departure_records r
    where r.id = p_early_departure_record_id and r.employee_id = v_intent.employee_id
  ) then
    raise exception 'La salida anticipada no corresponde al trabajador.' using errcode = '23503';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'supporting-documents' and o.name = v_intent.storage_path
      and o.metadata ->> 'mimetype' = v_intent.mime_type
      and case
        when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
        else -1
      end = v_intent.file_size
  ) then
    raise exception 'El archivo reservado no existe o no coincide con la reserva.' using errcode = '23503';
  end if;

  insert into public.supporting_documents (
    id, employee_id, absence_record_id, late_arrival_decision_id,
    early_departure_record_id, document_type, storage_path, mime_type,
    original_filename, uploaded_by
  ) values (
    v_document_id, v_intent.employee_id, p_absence_record_id,
    p_late_arrival_decision_id, p_early_departure_record_id,
    p_document_type, v_intent.storage_path, v_intent.mime_type,
    trim(p_original_filename), v_actor_id
  );

  update public.supporting_document_upload_intents
  set consumed_at = clock_timestamp()
  where id = v_intent.id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_id, 'SUPPORTING_DOCUMENT_UPLOADED', 'supporting_documents',
    v_document_id, jsonb_build_object('document_type', p_document_type)
  );
  return v_document_id;
end;
$$;

comment on function public.register_supporting_document_upload(uuid, text, text, uuid, uuid, uuid) is
  'Consume una reserva solo si el objeto existe, valida que la relación pertenezca al '
  'mismo trabajador y registra metadata + auditoría en una transacción.';

revoke all on function public.register_supporting_document_upload(uuid, text, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.register_supporting_document_upload(uuid, text, text, uuid, uuid, uuid) to authenticated;

create or replace function public.create_pending_medical_license(
  p_intent_id uuid,
  p_original_filename text,
  p_proposed_start_date date,
  p_proposed_end_date date,
  p_extraction_status text
)
returns table (approval_id uuid, absence_record_id uuid, document_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_intent public.supporting_document_upload_intents%rowtype;
  v_absence_type_id uuid;
begin
  if v_actor_id is null then
    raise exception 'Debes iniciar sesión para subir una licencia.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if p_proposed_start_date is null or p_proposed_end_date is null
     or p_proposed_end_date < p_proposed_start_date
     or (p_proposed_end_date - p_proposed_start_date) + 1 > 366 then
    raise exception 'El rango propuesto de la licencia no es válido.' using errcode = '22023';
  end if;
  if p_extraction_status not in ('EXTRAIDO', 'REQUIERE_REVISION') then
    raise exception 'El estado de extracción no es válido.' using errcode = '22023';
  end if;

  select * into v_intent
  from public.supporting_document_upload_intents i
  where i.id = p_intent_id and i.actor_id = v_actor_id
  for update;
  if not found or v_intent.consumed_at is not null or v_intent.expires_at <= clock_timestamp() then
    raise exception 'La reserva del documento no existe o venció.' using errcode = '42501';
  end if;
  if not public.can_manage_employee(v_intent.employee_id) then
    raise exception 'No puedes subir licencias de este trabajador.' using errcode = '42501';
  end if;

  select id into v_absence_type_id from public.absence_types where code = 'MEDICAL_LEAVE';
  if v_absence_type_id is null then
    raise exception 'No existe el tipo de ausencia para licencia médica.' using errcode = '23503';
  end if;

  absence_record_id := gen_random_uuid();
  insert into public.absence_records (
    id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by
  ) values (
    absence_record_id, v_intent.employee_id, v_absence_type_id,
    p_proposed_start_date, p_proposed_end_date, 'manual',
    'manual-license-' || p_intent_id::text, v_actor_id
  );

  document_id := public.register_supporting_document_upload(
    p_intent_id => p_intent_id,
    p_document_type => 'MEDICAL_CERTIFICATE',
    p_original_filename => p_original_filename,
    p_absence_record_id => absence_record_id,
    p_late_arrival_decision_id => null,
    p_early_departure_record_id => null
  );

  approval_id := gen_random_uuid();
  insert into public.medical_license_approvals (
    id, absence_record_id, supporting_document_id, proposed_start_date,
    proposed_end_date, extraction_status, uploaded_by
  ) values (
    approval_id, absence_record_id, document_id, p_proposed_start_date,
    p_proposed_end_date, p_extraction_status, v_actor_id
  );
  return next;
end;
$$;

comment on function public.create_pending_medical_license(uuid, text, date, date, text) is
  'Crea ausencia, metadata del documento y aprobación PENDING en una única '
  'transacción después del upload reservado. Ninguna licencia nace aprobada.';

revoke all on function public.create_pending_medical_license(uuid, text, date, date, text) from public, anon;
grant execute on function public.create_pending_medical_license(uuid, text, date, date, text) to authenticated;

-- Desde este punto el navegador solo puede crear metadata y pendientes por
-- los RPC cerrados. Las policies históricas permanecen como defensa adicional,
-- pero el GRANT directo que permitía componer estados parciales desaparece.
revoke insert on table public.supporting_documents from authenticated;
revoke insert on table public.medical_license_approvals from authenticated;
