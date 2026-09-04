-- Fase 2 / bloque 4: recepción segura de comprobantes por WhatsApp Cloud API.
--
-- El número remitente nunca se persiste: el backend lo transforma con HMAC
-- antes de llamar a estas funciones. La vinculación usa un código aleatorio de
-- un solo uso y corta cualquier vínculo anterior del mismo número para que una
-- foto nunca sea ambigua entre dos empresas.

create table public.expense_receipt_whatsapp_links (
  company_id          uuid not null references public.companies(id) on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  wa_id_hash          text,
  pairing_token_hash  text,
  pairing_expires_at  timestamptz,
  active              boolean not null default false,
  paired_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (company_id, user_id),
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade,
  constraint expense_receipt_whatsapp_links_hashes_check check (
    (wa_id_hash is null or wa_id_hash ~ '^[0-9a-f]{64}$')
    and (pairing_token_hash is null or pairing_token_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint expense_receipt_whatsapp_links_state_check check (
    (active and wa_id_hash is not null and paired_at is not null
      and pairing_token_hash is null and pairing_expires_at is null)
    or (not active and wa_id_hash is null and paired_at is null
      and ((pairing_token_hash is null and pairing_expires_at is null)
        or (pairing_token_hash is not null and pairing_expires_at is not null)))
  )
);

create unique index expense_receipt_whatsapp_links_wa_id_idx
  on public.expense_receipt_whatsapp_links(wa_id_hash)
  where active and wa_id_hash is not null;
create unique index expense_receipt_whatsapp_links_pairing_idx
  on public.expense_receipt_whatsapp_links(pairing_token_hash)
  where pairing_token_hash is not null;

create trigger expense_receipt_whatsapp_links_set_updated_at
  before update on public.expense_receipt_whatsapp_links
  for each row execute function public.set_updated_at();

alter table public.expense_receipt_whatsapp_links enable row level security;
create policy expense_receipt_whatsapp_links_read_own
  on public.expense_receipt_whatsapp_links for select to authenticated
  using (
    user_id = auth.uid()
    and public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (public.has_company_permission(company_id, 'expenses.submit')
      or public.has_company_permission(company_id, 'expenses.manage'))
  );

revoke all on public.expense_receipt_whatsapp_links from public, anon, authenticated, service_role;
grant select on public.expense_receipt_whatsapp_links to authenticated;
grant select, insert, update on public.expense_receipt_whatsapp_links to service_role;

create table public.expense_receipt_whatsapp_events (
  provider_message_hash text primary key check (provider_message_hash ~ '^[0-9a-f]{64}$'),
  company_id            uuid not null references public.companies(id) on delete cascade,
  user_id               uuid not null references public.profiles(id) on delete cascade,
  status                text not null check (status in ('PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED')),
  claim_token           uuid,
  usage_window_started_at timestamptz not null,
  reserved_bytes        bigint not null default 0 check (reserved_bytes between 0 and 10485760),
  attempt_count         integer not null default 1 check (attempt_count > 0),
  lease_expires_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz,
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade,
  constraint expense_receipt_whatsapp_events_state_check check (
    (status = 'PROCESSING' and claim_token is not null and lease_expires_at is not null and completed_at is null)
    or (status = 'COMPLETED' and claim_token is null and lease_expires_at is null and completed_at is not null)
    or (status = 'FAILED' and claim_token is null and lease_expires_at is null and completed_at is null)
    or (status = 'REJECTED' and claim_token is null and lease_expires_at is null and completed_at is not null)
  )
);

create table public.expense_receipt_whatsapp_usage_windows (
  company_id        uuid not null references public.companies(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  event_count       integer not null default 0 check (event_count between 0 and 60),
  reserved_bytes    bigint not null default 0 check (reserved_bytes between 0 and 104857600),
  updated_at        timestamptz not null default now(),
  primary key (company_id, user_id, window_started_at),
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id) on delete cascade
);

create index expense_receipt_whatsapp_events_active_idx
  on public.expense_receipt_whatsapp_events(company_id, user_id, lease_expires_at)
  where status = 'PROCESSING';

create trigger expense_receipt_whatsapp_events_set_updated_at
  before update on public.expense_receipt_whatsapp_events
  for each row execute function public.set_updated_at();

alter table public.expense_receipt_whatsapp_events enable row level security;
alter table public.expense_receipt_whatsapp_usage_windows enable row level security;
revoke all on public.expense_receipt_whatsapp_events from public, anon, authenticated, service_role;
revoke all on public.expense_receipt_whatsapp_usage_windows from public, anon, authenticated, service_role;

create or replace function public.begin_expense_receipt_whatsapp_pairing(
  p_company_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_company_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Solicitud de vinculación inválida.' using errcode = '23514';
  end if;
  if p_expires_at <= now() + interval '1 minute'
     or p_expires_at > now() + interval '15 minutes' then
    raise exception 'La vinculación debe vencer entre 1 y 15 minutos.' using errcode = '23514';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.submit')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'No puedes vincular WhatsApp en esta empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || v_actor_id::text || ':expense-whatsapp', 0)
  );

  insert into public.expense_receipt_whatsapp_links (
    company_id, user_id, wa_id_hash, pairing_token_hash,
    pairing_expires_at, active, paired_at
  ) values (
    p_company_id, v_actor_id, null, p_token_hash,
    p_expires_at, false, null
  )
  on conflict (company_id, user_id) do update
    set wa_id_hash = null,
        pairing_token_hash = excluded.pairing_token_hash,
        pairing_expires_at = excluded.pairing_expires_at,
        active = false,
        paired_at = null;

  return p_expires_at;
end;
$$;

create or replace function public.disconnect_expense_receipt_whatsapp(p_company_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  update public.expense_receipt_whatsapp_links l
  set wa_id_hash = null, pairing_token_hash = null, pairing_expires_at = null,
      active = false, paired_at = null
  where l.company_id = p_company_id and l.user_id = v_actor_id;
  return found;
end;
$$;

create or replace function public.claim_expense_receipt_whatsapp_pairing(
  p_token_hash text,
  p_wa_id_hash text
)
returns table(company_id uuid, user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link public.expense_receipt_whatsapp_links%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_wa_id_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_wa_id_hash, 0));

  select l.* into v_link
  from public.expense_receipt_whatsapp_links l
  where l.pairing_token_hash = p_token_hash
    and not l.active
    and l.pairing_expires_at > now()
    and public.company_has_module(l.company_id, 'expenses')
    and (public.expense_actor_has_permission(l.user_id, l.company_id, 'expenses.submit')
      or public.expense_actor_has_permission(l.user_id, l.company_id, 'expenses.manage'))
  for update;
  if not found then return; end if;

  update public.expense_receipt_whatsapp_links l
  set wa_id_hash = null, active = false, paired_at = null
  where l.wa_id_hash = p_wa_id_hash and l.active
    and (l.company_id, l.user_id) <> (v_link.company_id, v_link.user_id);

  update public.expense_receipt_whatsapp_links l
  set wa_id_hash = p_wa_id_hash,
      pairing_token_hash = null,
      pairing_expires_at = null,
      active = true,
      paired_at = now()
  where l.company_id = v_link.company_id and l.user_id = v_link.user_id;

  return query select v_link.company_id, v_link.user_id;
end;
$$;

create or replace function public.resolve_expense_receipt_whatsapp_sender(p_wa_id_hash text)
returns table(company_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select l.company_id, l.user_id
  from public.expense_receipt_whatsapp_links l
  where l.wa_id_hash = p_wa_id_hash
    and l.active
    and public.company_has_module(l.company_id, 'expenses')
    and (public.expense_actor_has_permission(l.user_id, l.company_id, 'expenses.submit')
      or public.expense_actor_has_permission(l.user_id, l.company_id, 'expenses.manage'));
$$;

create or replace function public.claim_expense_receipt_whatsapp_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_message_hash text
)
returns table(result text, claim_token uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event public.expense_receipt_whatsapp_events%rowtype;
  v_token uuid := gen_random_uuid();
  v_window timestamptz := date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC';
  v_pending integer;
  v_reserved integer;
  v_events integer;
begin
  if p_actor_id is null or p_company_id is null
     or p_provider_message_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Evento de WhatsApp inválido.' using errcode = '23514';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes recibir comprobantes en esta empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );
  select e.* into v_event
  from public.expense_receipt_whatsapp_events e
  where e.provider_message_hash = p_provider_message_hash
  for update;

  if found and v_event.status = 'COMPLETED' then
    return query select 'COMPLETED'::text, null::uuid;
    return;
  end if;
  if found and v_event.status = 'PROCESSING' and v_event.lease_expires_at > now() then
    return query select 'IN_PROGRESS'::text, null::uuid;
    return;
  end if;

  insert into public.expense_receipt_whatsapp_usage_windows (
    company_id, user_id, window_started_at, event_count
  ) values (p_company_id, p_actor_id, v_window, 0)
  on conflict (company_id, user_id, window_started_at) do nothing;
  select w.event_count into v_events
  from public.expense_receipt_whatsapp_usage_windows w
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_window
  for update;

  if v_events >= 60 then
    insert into public.expense_receipt_whatsapp_events (
      provider_message_hash, company_id, user_id, status,
      claim_token, usage_window_started_at, lease_expires_at, completed_at
    ) values (
      p_provider_message_hash, p_company_id, p_actor_id, 'REJECTED',
      null, v_window, null, now()
    )
    on conflict (provider_message_hash) do update
      set status = 'REJECTED', claim_token = null, lease_expires_at = null, completed_at = now();
    return query select 'RATE_LIMITED'::text, null::uuid;
    return;
  end if;

  update public.expense_receipt_whatsapp_usage_windows w
  set event_count = event_count + 1
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_window;

  select count(*) into v_pending
  from public.expense_receipt_captures c
  where c.company_id = p_company_id and c.uploaded_by = p_actor_id and c.status = 'PENDING';
  select count(*) into v_reserved
  from public.expense_receipt_whatsapp_events e
  where e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.lease_expires_at > now()
    and e.provider_message_hash <> p_provider_message_hash;
  if v_pending + v_reserved >= 50 then
    insert into public.expense_receipt_whatsapp_events (
      provider_message_hash, company_id, user_id, status,
      claim_token, usage_window_started_at, lease_expires_at, completed_at
    ) values (
      p_provider_message_hash, p_company_id, p_actor_id, 'REJECTED',
      null, v_window, null, now()
    )
    on conflict (provider_message_hash) do update
      set status = 'REJECTED', claim_token = null, lease_expires_at = null, completed_at = now();
    return query select 'LIMIT'::text, null::uuid;
    return;
  end if;

  insert into public.expense_receipt_whatsapp_events (
    provider_message_hash, company_id, user_id, status, claim_token,
    usage_window_started_at, lease_expires_at, completed_at, attempt_count
  ) values (
    p_provider_message_hash, p_company_id, p_actor_id, 'PROCESSING', v_token,
    v_window, now() + interval '5 minutes', null, 1
  )
  on conflict (provider_message_hash) do update
    set company_id = excluded.company_id,
        user_id = excluded.user_id,
        status = 'PROCESSING',
        claim_token = excluded.claim_token,
        usage_window_started_at = excluded.usage_window_started_at,
        reserved_bytes = 0,
        lease_expires_at = excluded.lease_expires_at,
        completed_at = null,
        attempt_count = public.expense_receipt_whatsapp_events.attempt_count + 1;

  return query select 'CLAIMED'::text, v_token;
end;
$$;

create or replace function public.reserve_expense_receipt_whatsapp_bytes(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_message_hash text,
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
  v_window timestamptz;
  v_used bigint;
begin
  if p_reserved_bytes <= 0 or p_reserved_bytes > 10485760 or p_claim_token is null then
    return false;
  end if;
  select e.usage_window_started_at into v_window
  from public.expense_receipt_whatsapp_events e
  where e.provider_message_hash = p_provider_message_hash
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token
    and e.lease_expires_at > now()
  for update;
  if not found then return false; end if;

  select w.reserved_bytes into v_used
  from public.expense_receipt_whatsapp_usage_windows w
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_window
  for update;
  if v_used + p_reserved_bytes > 104857600 then return false; end if;

  update public.expense_receipt_whatsapp_usage_windows w
  set reserved_bytes = reserved_bytes + p_reserved_bytes
  where w.company_id = p_company_id and w.user_id = p_actor_id
    and w.window_started_at = v_window;
  update public.expense_receipt_whatsapp_events e
  set reserved_bytes = p_reserved_bytes
  where e.provider_message_hash = p_provider_message_hash
    and e.claim_token = p_claim_token;
  return true;
end;
$$;

create or replace function public.register_expense_receipt_whatsapp_capture(
  p_actor_id uuid,
  p_company_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size integer,
  p_checksum_sha256 text,
  p_provider_message_hash text,
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
  if p_actor_id is null or p_company_id is null or p_claim_token is null then
    raise exception 'Actor, empresa y reclamo son obligatorios.' using errcode = '22004';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.submit')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'No puedes recibir comprobantes en esta empresa.' using errcode = '42501';
  end if;
  if p_storage_path !~ ('^' || p_company_id::text || '/' || p_actor_id::text || '/inbox/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$')
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     or p_file_size <= 0 or p_file_size > 10485760
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or p_provider_message_hash !~ '^[0-9a-f]{64}$'
     or char_length(btrim(p_original_filename)) not between 1 and 240 then
    raise exception 'Captura de WhatsApp inválida.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_actor_id::text, 0)
  );
  select c.id into v_capture_id
  from public.expense_receipt_captures c
  where c.company_id = p_company_id and c.source = 'WHATSAPP'
    and c.external_message_id = p_provider_message_hash;
  if found then return v_capture_id; end if;

  if not exists (
    select 1 from public.expense_receipt_whatsapp_events e
    where e.provider_message_hash = p_provider_message_hash
      and e.company_id = p_company_id and e.user_id = p_actor_id
      and e.status = 'PROCESSING' and e.claim_token = p_claim_token
      and e.lease_expires_at > now() and e.reserved_bytes = p_file_size
  ) then
    raise exception 'El evento de WhatsApp no tiene una reserva activa.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'expense-receipts' and so.name = p_storage_path
  ) then
    raise exception 'El archivo no existe en el almacenamiento privado.' using errcode = '23503';
  end if;
  if (select count(*) from public.expense_receipt_captures c
      where c.company_id = p_company_id and c.uploaded_by = p_actor_id and c.status = 'PENDING') >= 50 then
    raise exception 'Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.' using errcode = '54000';
  end if;

  insert into public.expense_receipt_captures (
    company_id, uploaded_by, source, storage_path, original_filename,
    mime_type, file_size, checksum_sha256, external_message_id
  ) values (
    p_company_id, p_actor_id, 'WHATSAPP', p_storage_path, btrim(p_original_filename),
    p_mime_type, p_file_size, p_checksum_sha256, p_provider_message_hash
  ) returning id into v_capture_id;
  return v_capture_id;
end;
$$;

create or replace function public.complete_expense_receipt_whatsapp_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_message_hash text,
  p_claim_token uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.expense_receipt_whatsapp_events e
  set status = 'COMPLETED', claim_token = null, lease_expires_at = null, completed_at = now()
  where e.provider_message_hash = p_provider_message_hash
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_expense_receipt_whatsapp_event(
  p_actor_id uuid,
  p_company_id uuid,
  p_provider_message_hash text,
  p_claim_token uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.expense_receipt_whatsapp_events e
  set status = 'FAILED', claim_token = null, lease_expires_at = null, completed_at = null
  where e.provider_message_hash = p_provider_message_hash
    and e.company_id = p_company_id and e.user_id = p_actor_id
    and e.status = 'PROCESSING' and e.claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.begin_expense_receipt_whatsapp_pairing(uuid, text, timestamptz) from public, anon;
revoke all on function public.disconnect_expense_receipt_whatsapp(uuid) from public, anon;
revoke all on function public.claim_expense_receipt_whatsapp_pairing(text, text) from public, anon, authenticated;
revoke all on function public.resolve_expense_receipt_whatsapp_sender(text) from public, anon, authenticated;
revoke all on function public.claim_expense_receipt_whatsapp_event(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_expense_receipt_whatsapp_bytes(uuid, uuid, text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.register_expense_receipt_whatsapp_capture(uuid, uuid, text, text, text, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_expense_receipt_whatsapp_event(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_expense_receipt_whatsapp_event(uuid, uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.begin_expense_receipt_whatsapp_pairing(uuid, text, timestamptz) to authenticated;
grant execute on function public.disconnect_expense_receipt_whatsapp(uuid) to authenticated;
grant execute on function public.claim_expense_receipt_whatsapp_pairing(text, text) to service_role;
grant execute on function public.resolve_expense_receipt_whatsapp_sender(text) to service_role;
grant execute on function public.claim_expense_receipt_whatsapp_event(uuid, uuid, text) to service_role;
grant execute on function public.reserve_expense_receipt_whatsapp_bytes(uuid, uuid, text, uuid, bigint) to service_role;
grant execute on function public.register_expense_receipt_whatsapp_capture(uuid, uuid, text, text, text, integer, text, text, uuid) to service_role;
grant execute on function public.complete_expense_receipt_whatsapp_event(uuid, uuid, text, uuid) to service_role;
grant execute on function public.release_expense_receipt_whatsapp_event(uuid, uuid, text, uuid) to service_role;

comment on table public.expense_receipt_whatsapp_links is
  'Vínculo opaco y revocable entre una identidad WhatsApp y una persona/empresa de Rendiciones.';
comment on column public.expense_receipt_whatsapp_links.wa_id_hash is
  'HMAC-SHA256 del wa_id; el número real nunca se persiste.';
comment on table public.expense_receipt_whatsapp_events is
  'Ledger idempotente sin contenido de mensajes para recepción de comprobantes por WhatsApp.';
