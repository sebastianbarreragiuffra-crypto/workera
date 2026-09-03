-- Fase 2 / bloque 3: recepción segura de comprobantes por correo.
-- La dirección usa un token opaco por persona/empresa. El backend resuelve
-- ese token después de verificar la firma del proveedor; nunca confía en From.

create table public.expense_receipt_email_aliases (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  alias_token uuid not null default gen_random_uuid(),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  unique (company_id, user_id),
  unique (alias_token),
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade
);

create trigger expense_receipt_email_aliases_set_updated_at
  before update on public.expense_receipt_email_aliases
  for each row execute function public.set_updated_at();

alter table public.expense_receipt_email_aliases enable row level security;

create policy expense_receipt_email_aliases_read_own
  on public.expense_receipt_email_aliases for select to authenticated
  using (
    user_id = auth.uid()
    and public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (public.has_company_permission(company_id, 'expenses.submit')
      or public.has_company_permission(company_id, 'expenses.manage'))
  );

revoke all on public.expense_receipt_email_aliases from public, anon, authenticated, service_role;
grant select on public.expense_receipt_email_aliases to authenticated;
grant select, insert, update on public.expense_receipt_email_aliases to service_role;

-- Ledger técnico sin contenido del correo. Permite reclamar el evento antes
-- de I/O externo, limitar replays y reservar cupo con lease recuperable.
create table public.expense_receipt_email_events (
  provider_email_id text primary key check (char_length(provider_email_id) between 1 and 240),
  provider_event_id text not null unique check (char_length(provider_event_id) between 1 and 240),
  company_id        uuid not null references public.companies(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  status            text not null check (status in ('PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED')),
  claim_token       uuid,
  usage_window_started_at timestamptz not null,
  reserved_slots    smallint not null check (reserved_slots between 0 and 10),
  consumed_slots    smallint not null default 0 check (consumed_slots between 0 and reserved_slots),
  reserved_bytes    bigint not null default 0 check (reserved_bytes between 0 and 104857600),
  attempt_count     integer not null default 1 check (attempt_count > 0),
  lease_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade,
  constraint expense_receipt_email_events_lifecycle_check check (
    (status = 'PROCESSING' and claim_token is not null and lease_expires_at is not null and completed_at is null)
    or (status = 'COMPLETED' and claim_token is null and lease_expires_at is null and completed_at is not null)
    or (status = 'FAILED' and claim_token is null and lease_expires_at is null and completed_at is null)
    or (status = 'REJECTED' and claim_token is null and lease_expires_at is null and completed_at is not null)
  )
);

-- Ventanas horarias agregadas: contabilizan también eventos rechazados sin
-- crear una fila por cada mensaje abusivo. Los bytes no se liberan al fallar
-- la firma binaria, por lo que correos nuevos inválidos no evaden la cuota.
create table public.expense_receipt_email_usage_windows (
  company_id        uuid not null references public.companies(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  event_count       integer not null default 0 check (event_count >= 0),
  rejected_count    integer not null default 0 check (rejected_count >= 0 and rejected_count <= event_count),
  reserved_slots    integer not null default 0 check (reserved_slots between 0 and 50),
  reserved_bytes    bigint not null default 0 check (reserved_bytes between 0 and 104857600),
  updated_at        timestamptz not null default now(),
  primary key (company_id, user_id, window_started_at),
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade
);

create index expense_receipt_email_events_active_reservations_idx
  on public.expense_receipt_email_events(company_id, user_id, lease_expires_at)
  where status = 'PROCESSING';

create trigger expense_receipt_email_events_set_updated_at
  before update on public.expense_receipt_email_events
  for each row execute function public.set_updated_at();

alter table public.expense_receipt_email_events enable row level security;
revoke all on public.expense_receipt_email_events from public, anon, authenticated, service_role;
alter table public.expense_receipt_email_usage_windows enable row level security;
revoke all on public.expense_receipt_email_usage_windows from public, anon, authenticated, service_role;

create or replace function public.ensure_expense_receipt_email_alias(p_company_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_alias_token uuid;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_company_id is null then
    raise exception 'La empresa es obligatoria.' using errcode = '22004';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.submit')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'No puedes activar la recepción por correo en esta empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || v_actor_id::text || ':expense-email-alias', 0)
  );

  insert into public.expense_receipt_email_aliases (company_id, user_id)
  values (p_company_id, v_actor_id)
  on conflict (company_id, user_id) do update
    set active = true
  returning alias_token into v_alias_token;

  return v_alias_token;
end;
$$;

create or replace function public.rotate_expense_receipt_email_alias(p_company_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_alias_token uuid := gen_random_uuid();
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_company_id is null then
    raise exception 'La empresa es obligatoria.' using errcode = '22004';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.submit')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'No puedes rotar la dirección de correo en esta empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || v_actor_id::text || ':expense-email-alias', 0)
  );

  insert into public.expense_receipt_email_aliases (
    company_id, user_id, alias_token, active, rotated_at
  ) values (
    p_company_id, v_actor_id, v_alias_token, true, now()
  )
  on conflict (company_id, user_id) do update
    set alias_token = excluded.alias_token,
        active = true,
        rotated_at = excluded.rotated_at
  returning alias_token into v_alias_token;

  return v_alias_token;
end;
$$;

-- Solo el backend firmado puede transformar un token en identidad. Además de
-- la fila activa se revalida membresía, empresa, módulo y permiso en tiempo real.
create or replace function public.resolve_expense_receipt_email_alias(p_alias_token uuid)
returns table(company_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select a.company_id, a.user_id
  from public.expense_receipt_email_aliases a
  where a.alias_token = p_alias_token
    and a.active
    and public.company_has_module(a.company_id, 'expenses')
    and (
      public.expense_actor_has_permission(a.user_id, a.company_id, 'expenses.submit')
      or public.expense_actor_has_permission(a.user_id, a.company_id, 'expenses.manage')
    );
$$;

create or replace function public.claim_expense_receipt_email_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_event_id text,
  p_provider_email_id text,
  p_reserved_slots integer
)
returns table(result text, claim_token uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event public.expense_receipt_email_events%rowtype;
  v_claim_token uuid := gen_random_uuid();
  v_usage_window timestamptz := date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC';
  v_window_event_count integer;
  v_window_reserved_slots integer;
  v_pending_count integer;
  v_other_reserved integer;
  v_needed integer;
  v_existing boolean := false;
begin
  if p_actor_id is null or p_company_id is null then
    raise exception 'Actor y empresa son obligatorios.' using errcode = '22004';
  end if;
  if char_length(btrim(p_provider_event_id)) not between 1 and 240
     or char_length(btrim(p_provider_email_id)) not between 1 and 240
     or p_reserved_slots not between 0 and 10 then
    raise exception 'Evento de correo inválido.' using errcode = '23514';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes recibir comprobantes en esta empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );

  select * into v_event
  from public.expense_receipt_email_events e
  where e.provider_email_id = btrim(p_provider_email_id)
  for update;

  if found then
    v_existing := true;
    if v_event.company_id <> p_company_id or v_event.user_id <> p_actor_id then
      raise exception 'El evento pertenece a otro ámbito.' using errcode = '42501';
    end if;
    if v_event.status = 'COMPLETED' then
      return query select 'COMPLETED'::text, null::uuid;
      return;
    end if;
    if v_event.status = 'REJECTED' then
      return query select 'RATE_LIMITED'::text, null::uuid;
      return;
    end if;
    if v_event.status = 'PROCESSING' and v_event.lease_expires_at > now() then
      return query select 'IN_PROGRESS'::text, null::uuid;
      return;
    end if;
  end if;

  if not v_existing then
    insert into public.expense_receipt_email_usage_windows (
      company_id, user_id, window_started_at, event_count
    ) values (
      p_company_id, p_actor_id, v_usage_window, 1
    )
    on conflict (company_id, user_id, window_started_at) do update
      set event_count = public.expense_receipt_email_usage_windows.event_count + 1,
          updated_at = now()
    returning event_count, reserved_slots
      into v_window_event_count, v_window_reserved_slots;

    if v_window_event_count > 20 or v_window_reserved_slots + p_reserved_slots > 50 then
      update public.expense_receipt_email_usage_windows w
      set rejected_count = rejected_count + 1, updated_at = now()
      where w.company_id = p_company_id and w.user_id = p_actor_id
        and w.window_started_at = v_usage_window;
      return query select 'RATE_LIMITED'::text, null::uuid;
      return;
    end if;

    update public.expense_receipt_email_usage_windows w
    set reserved_slots = reserved_slots + p_reserved_slots, updated_at = now()
    where w.company_id = p_company_id and w.user_id = p_actor_id
      and w.window_started_at = v_usage_window;
  else
    -- Un reintento no vuelve a contar el mismo correo/adjuntos, pero sí debe
    -- cobrar nuevamente cualquier descarga en la ventana horaria vigente.
    insert into public.expense_receipt_email_usage_windows (
      company_id, user_id, window_started_at
    ) values (
      p_company_id, p_actor_id, v_usage_window
    )
    on conflict (company_id, user_id, window_started_at) do nothing;
  end if;

  select count(*) into v_pending_count
  from public.expense_receipt_captures c
  where c.company_id = p_company_id and c.uploaded_by = p_actor_id and c.status = 'PENDING';

  select coalesce(sum(e.reserved_slots - e.consumed_slots), 0)::integer
    into v_other_reserved
  from public.expense_receipt_email_events e
  where e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.lease_expires_at > now()
    and e.provider_email_id <> btrim(p_provider_email_id);

  v_needed := greatest(p_reserved_slots - coalesce(v_event.consumed_slots, 0), 0);
  if v_pending_count + v_other_reserved + v_needed > 50 then
    raise exception 'Tu bandeja no tiene cupo para este correo.' using errcode = '54000';
  end if;

  insert into public.expense_receipt_email_events (
    provider_email_id, provider_event_id, company_id, user_id, status, claim_token,
    usage_window_started_at, reserved_slots, consumed_slots, attempt_count, lease_expires_at
  ) values (
    btrim(p_provider_email_id), btrim(p_provider_event_id), p_company_id, p_actor_id,
    'PROCESSING', v_claim_token, v_usage_window, p_reserved_slots, 0, 1, now() + interval '5 minutes'
  )
  on conflict (provider_email_id) do update
    set provider_event_id = excluded.provider_event_id,
        status = 'PROCESSING',
        claim_token = excluded.claim_token,
        usage_window_started_at = excluded.usage_window_started_at,
        reserved_slots = greatest(public.expense_receipt_email_events.reserved_slots, excluded.reserved_slots),
        reserved_bytes = 0,
        attempt_count = public.expense_receipt_email_events.attempt_count + 1,
        lease_expires_at = excluded.lease_expires_at,
        completed_at = null;

  return query select 'CLAIMED'::text, v_claim_token;
end;
$$;

create or replace function public.reserve_expense_receipt_email_bytes(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_email_id text,
  p_claim_token uuid,
  p_reserved_bytes bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event public.expense_receipt_email_events%rowtype;
  v_window_bytes bigint;
begin
  if p_claim_token is null or p_reserved_bytes not between 1 and 104857600 then
    raise exception 'Reserva de bytes inválida.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );
  select * into v_event
  from public.expense_receipt_email_events e
  where e.provider_email_id = p_provider_email_id
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token
    and e.lease_expires_at > now()
  for update;
  if not found then
    raise exception 'Evento de correo no reclamado por este intento.' using errcode = '23514';
  end if;
  if v_event.reserved_bytes > 0 then
    if p_reserved_bytes > v_event.reserved_bytes then
      raise exception 'El reintento excede los bytes ya reservados.' using errcode = '23514';
    end if;
    return true;
  end if;

  select w.reserved_bytes into v_window_bytes
  from public.expense_receipt_email_usage_windows w
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_event.usage_window_started_at
  for update;
  if not found then
    raise exception 'Ventana de uso del correo no encontrada.' using errcode = '23514';
  end if;

  if v_window_bytes + p_reserved_bytes > 104857600 then
    update public.expense_receipt_email_usage_windows w
    set rejected_count = rejected_count + 1, updated_at = now()
    where w.company_id = p_company_id and w.user_id = p_actor_id
      and w.window_started_at = v_event.usage_window_started_at;
    update public.expense_receipt_email_events e
    set status = 'REJECTED', claim_token = null, lease_expires_at = null, completed_at = now()
    where e.provider_email_id = p_provider_email_id and e.claim_token = p_claim_token;
    return false;
  end if;

  update public.expense_receipt_email_usage_windows w
  set reserved_bytes = reserved_bytes + p_reserved_bytes, updated_at = now()
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_event.usage_window_started_at;
  update public.expense_receipt_email_events e
  set reserved_bytes = p_reserved_bytes
  where e.provider_email_id = p_provider_email_id and e.claim_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.complete_expense_receipt_email_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_email_id text,
  p_claim_token uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.expense_receipt_email_events e
  set status = 'COMPLETED', claim_token = null, lease_expires_at = null, completed_at = now()
  where e.provider_email_id = p_provider_email_id
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token;
  if not found then raise exception 'Evento de correo no reclamado por este intento.' using errcode = '23514'; end if;
end;
$$;

create or replace function public.release_expense_receipt_email_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_email_id text,
  p_claim_token uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.expense_receipt_email_events e
  set status = 'FAILED', claim_token = null, lease_expires_at = null, completed_at = null
  where e.provider_email_id = p_provider_email_id
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token;
end;
$$;

-- Todo camino que introduce un PENDING comparte la misma lock. Las cargas web
-- respetan reservas activas; una captura EMAIL consume luego su propia reserva.
create or replace function public.enforce_expense_capture_quota_with_email_reservations()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pending_count integer;
  v_reserved_count integer;
begin
  if new.status <> 'PENDING'
     or (tg_op = 'UPDATE' and old.status = 'PENDING') then return new; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.company_id::text || ':' || new.uploaded_by::text, 0)
  );
  select count(*) into v_pending_count
  from public.expense_receipt_captures c
  where c.company_id = new.company_id and c.uploaded_by = new.uploaded_by and c.status = 'PENDING';
  select coalesce(sum(e.reserved_slots - e.consumed_slots), 0)::integer into v_reserved_count
  from public.expense_receipt_email_events e
  where e.company_id = new.company_id and e.user_id = new.uploaded_by
    and e.status = 'PROCESSING' and e.lease_expires_at > now();

  if (tg_op = 'INSERT' and new.source = 'EMAIL' and v_pending_count >= 50)
     or ((tg_op <> 'INSERT' or new.source <> 'EMAIL') and v_pending_count + v_reserved_count >= 50) then
    raise exception 'Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.' using errcode = '54000';
  end if;
  return new;
end;
$$;

create trigger expense_receipt_captures_enforce_email_reservations
  before insert or update of status on public.expense_receipt_captures
  for each row execute function public.enforce_expense_capture_quota_with_email_reservations();

-- Registro idempotente para el canal EMAIL. La advisory lock comparte la
-- misma clave de cupo que la web: reintentos y cargas simultáneas no superan
-- los 50 pendientes. Un external_message_id existente devuelve su ID.
create or replace function public.register_inbound_expense_receipt_capture(
  p_actor_id uuid,
  p_company_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size integer,
  p_checksum_sha256 text,
  p_external_message_id text,
  p_provider_email_id text,
  p_claim_token uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capture_id uuid;
begin
  if p_actor_id is null or p_company_id is null then
    raise exception 'Actor y empresa son obligatorios.' using errcode = '22004';
  end if;
  if p_claim_token is null then
    raise exception 'El token de intento es obligatorio.' using errcode = '22004';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes recibir comprobantes en esta empresa.' using errcode = '42501';
  end if;
  if p_storage_path !~ ('^' || p_company_id::text || '/' || p_actor_id::text || '/inbox/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$') then
    raise exception 'La ruta de captura no corresponde a la empresa y usuario.' using errcode = '42501';
  end if;
  if p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     or p_file_size <= 0 or p_file_size > 10485760
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(btrim(p_original_filename)) not between 1 and 240
     or char_length(btrim(p_external_message_id)) not between 1 and 240 then
    raise exception 'Captura de correo inválida.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );

  select c.id into v_capture_id
  from public.expense_receipt_captures c
  where c.company_id = p_company_id
    and c.source = 'EMAIL'
    and c.external_message_id = btrim(p_external_message_id);
  if found then return v_capture_id; end if;

  if not exists (
    select 1 from public.expense_receipt_email_events e
    where e.provider_email_id = p_provider_email_id
      and e.company_id = p_company_id and e.user_id = p_actor_id
      and e.claim_token = p_claim_token
      and e.status = 'PROCESSING' and e.lease_expires_at > now()
      and e.consumed_slots < e.reserved_slots
  ) then
    raise exception 'El evento de correo no tiene una reserva activa.' using errcode = '23514';
  end if;

  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'expense-receipts' and so.name = p_storage_path
  ) then
    raise exception 'El archivo no existe en el almacenamiento privado.' using errcode = '23503';
  end if;
  if (
    select count(*)
    from public.expense_receipt_captures c
    where c.company_id = p_company_id and c.uploaded_by = p_actor_id and c.status = 'PENDING'
  ) >= 50 then
    raise exception 'Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.' using errcode = '54000';
  end if;

  v_capture_id := gen_random_uuid();
  insert into public.expense_receipt_captures (
    id, company_id, uploaded_by, source, storage_path, original_filename,
    mime_type, file_size, checksum_sha256, external_message_id
  ) values (
    v_capture_id, p_company_id, p_actor_id, 'EMAIL', p_storage_path,
    btrim(p_original_filename), p_mime_type, p_file_size, p_checksum_sha256,
    btrim(p_external_message_id)
  );

  update public.expense_receipt_email_events e
  set consumed_slots = consumed_slots + 1
  where e.provider_email_id = p_provider_email_id
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.claim_token = p_claim_token
    and e.status = 'PROCESSING' and e.lease_expires_at > now()
    and e.consumed_slots < e.reserved_slots;
  if not found then raise exception 'No se pudo consumir la reserva del correo.' using errcode = '23514'; end if;
  return v_capture_id;
end;
$$;

revoke all on function public.ensure_expense_receipt_email_alias(uuid) from public, anon;
revoke all on function public.rotate_expense_receipt_email_alias(uuid) from public, anon;
revoke all on function public.resolve_expense_receipt_email_alias(uuid) from public, anon, authenticated;
revoke all on function public.claim_expense_receipt_email_event(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.reserve_expense_receipt_email_bytes(uuid, uuid, text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.complete_expense_receipt_email_event(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_expense_receipt_email_event(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.enforce_expense_capture_quota_with_email_reservations() from public, anon, authenticated;
revoke all on function public.register_inbound_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.ensure_expense_receipt_email_alias(uuid) to authenticated;
grant execute on function public.rotate_expense_receipt_email_alias(uuid) to authenticated;
grant execute on function public.resolve_expense_receipt_email_alias(uuid) to service_role;
grant execute on function public.claim_expense_receipt_email_event(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.reserve_expense_receipt_email_bytes(uuid, uuid, text, uuid, bigint) to service_role;
grant execute on function public.complete_expense_receipt_email_event(uuid, uuid, text, uuid) to service_role;
grant execute on function public.release_expense_receipt_email_event(uuid, uuid, text, uuid) to service_role;
grant execute on function public.register_inbound_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text, text, uuid) to service_role;

comment on table public.expense_receipt_email_aliases is
  'Direcciones opacas y rotatables para recibir comprobantes por correo sin confiar en el remitente.';
comment on column public.expense_receipt_email_aliases.alias_token is
  'Capacidad secreta incluida en la dirección de recepción; no debe exponerse en logs ni telemetría.';
comment on table public.expense_receipt_email_usage_windows is
  'Cuotas horarias agregadas de eventos, adjuntos y bytes del canal de correo, incluidos intentos rechazados.';
