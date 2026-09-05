-- P0-A: recoleccion durable de objetos laborales cuya reserva vencio sin commit.
--
-- El navegador intenta compensar un upload fallido, pero una caida definitiva
-- puede ocurrir despues de escribir Storage y antes de borrar el objeto. Este
-- ledger permite que un worker server-side reclame exclusivamente reservas
-- vencidas y no consumidas, con gracia, SKIP LOCKED, fencing y reintentos
-- acotados. Un storage_path ya registrado nunca entra en la cola.

alter table public.supporting_document_upload_intents
  add column cleanup_attempt integer not null default 0,
  add column cleanup_available_at timestamptz not null default now(),
  add column cleanup_locked_at timestamptz,
  add column cleanup_locked_by uuid,
  add column cleanup_completed_at timestamptz,
  add column cleanup_result text,
  add column cleanup_error_code text,
  add constraint supporting_document_upload_intents_cleanup_attempt_chk
    check (cleanup_attempt between 0 and 3),
  add constraint supporting_document_upload_intents_cleanup_lock_chk
    check ((cleanup_locked_at is null) = (cleanup_locked_by is null)),
  add constraint supporting_document_upload_intents_cleanup_result_chk
    check (cleanup_result is null or cleanup_result in ('REMOVED_OR_ABSENT', 'FAILED')),
  add constraint supporting_document_upload_intents_cleanup_completion_chk
    check (
      (cleanup_completed_at is null and cleanup_result is null)
      or
      (cleanup_completed_at is not null and cleanup_result is not null
       and cleanup_locked_at is null and cleanup_locked_by is null)
    ),
  add constraint supporting_document_upload_intents_cleanup_error_code_chk
    check (
      cleanup_error_code is null
      or cleanup_error_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
    );

drop index if exists supporting_document_upload_intents_pending_idx;
create index supporting_document_upload_intents_pending_idx
  on public.supporting_document_upload_intents
    (cleanup_available_at, expires_at, created_at, id)
  where consumed_at is null and cleanup_completed_at is null;

create or replace function public.reclaim_stale_supporting_document_cleanups(
  p_stale_after_seconds integer default 300
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if p_stale_after_seconds < 60 or p_stale_after_seconds > 3600 then
    raise exception 'stale_after_seconds debe estar entre 60 y 3600.' using errcode = '22023';
  end if;

  for v_row in
    update public.supporting_document_upload_intents i
    set cleanup_available_at = pg_catalog.clock_timestamp(),
        cleanup_locked_at = null,
        cleanup_locked_by = null,
        cleanup_completed_at = case
          when i.cleanup_attempt >= 3 then pg_catalog.clock_timestamp()
          else null
        end,
        cleanup_result = case
          when i.cleanup_attempt >= 3 then 'FAILED'
          else null
        end,
        cleanup_error_code = case
          when i.cleanup_attempt >= 3 then 'LEASE_EXHAUSTED'
          else i.cleanup_error_code
        end
    where i.cleanup_completed_at is null
      and i.cleanup_locked_at < pg_catalog.clock_timestamp()
        - pg_catalog.make_interval(secs => p_stale_after_seconds)
    returning i.id, i.cleanup_result, i.cleanup_attempt
  loop
    v_count := v_count + 1;
    if v_row.cleanup_result = 'FAILED' then
      insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
      values (
        null,
        'SUPPORTING_DOCUMENT_ORPHAN_CLEANUP_FAILED',
        'supporting_document_upload_intents',
        v_row.id,
        pg_catalog.jsonb_build_object(
          'result', 'FAILED',
          'error_code', 'LEASE_EXHAUSTED',
          'attempts', v_row.cleanup_attempt
        )
      );
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.claim_expired_supporting_document_uploads(
  p_worker_id uuid,
  p_limit integer default 20,
  p_grace_seconds integer default 300
)
returns table (
  intent_id uuid,
  storage_path text,
  attempt integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or p_limit < 1 or p_limit > 100 then
    raise exception 'worker_id y limit valido son obligatorios.' using errcode = '22023';
  end if;
  if p_grace_seconds < 60 or p_grace_seconds > 86400 then
    raise exception 'grace_seconds debe estar entre 60 y 86400.' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select i.id
    from public.supporting_document_upload_intents i
    where i.consumed_at is null
      and i.cleanup_completed_at is null
      and i.cleanup_locked_at is null
      and i.cleanup_attempt < 3
      and i.cleanup_available_at <= pg_catalog.clock_timestamp()
      and i.expires_at <= pg_catalog.clock_timestamp()
        - pg_catalog.make_interval(secs => p_grace_seconds)
      and not exists (
        select 1
        from public.supporting_documents d
        where d.storage_path = i.storage_path
      )
    order by i.cleanup_available_at, i.expires_at, i.created_at, i.id
    for update of i skip locked
    limit p_limit
  ), claimed as (
    update public.supporting_document_upload_intents i
    set cleanup_attempt = i.cleanup_attempt + 1,
        cleanup_locked_at = pg_catalog.clock_timestamp(),
        cleanup_locked_by = p_worker_id,
        cleanup_error_code = null
    from candidates c
    where i.id = c.id
      and i.cleanup_attempt < 3
      and i.cleanup_locked_at is null
    returning i.id, i.storage_path, i.cleanup_attempt
  )
  select c.id, c.storage_path, c.cleanup_attempt
  from claimed c;
end;
$$;

create or replace function public.complete_supporting_document_orphan_cleanup(
  p_intent_id uuid,
  p_worker_id uuid,
  p_result text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_intent public.supporting_document_upload_intents%rowtype;
begin
  if p_result <> 'REMOVED_OR_ABSENT' then
    raise exception 'Resultado de limpieza invalido.' using errcode = '22023';
  end if;

  update public.supporting_document_upload_intents i
  set cleanup_locked_at = null,
      cleanup_locked_by = null,
      cleanup_completed_at = pg_catalog.clock_timestamp(),
      cleanup_result = p_result,
      cleanup_error_code = null
  where i.id = p_intent_id
    and i.consumed_at is null
    and i.cleanup_completed_at is null
    and i.cleanup_locked_by = p_worker_id
    and not exists (
      select 1
      from public.supporting_documents d
      where d.storage_path = i.storage_path
    )
  returning i.* into v_intent;

  if not found then
    raise exception 'Lease de limpieza inexistente, vencida o protegida.' using errcode = '40001';
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    null,
    'SUPPORTING_DOCUMENT_ORPHAN_CLEANED',
    'supporting_document_upload_intents',
    v_intent.id,
    pg_catalog.jsonb_build_object(
      'result', p_result,
      'attempts', v_intent.cleanup_attempt
    )
  );
  return p_result;
end;
$$;

create or replace function public.fail_supporting_document_orphan_cleanup(
  p_intent_id uuid,
  p_worker_id uuid,
  p_error_code text,
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
  v_intent public.supporting_document_upload_intents%rowtype;
  v_retried boolean;
begin
  if p_error_code is null
     or p_error_code !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
     or p_retryable is null
     or p_retry_delay_seconds < 1
     or p_retry_delay_seconds > 3600 then
    raise exception 'Fallo de limpieza invalido.' using errcode = '22023';
  end if;

  select i.* into v_intent
  from public.supporting_document_upload_intents i
  where i.id = p_intent_id
    and i.consumed_at is null
    and i.cleanup_completed_at is null
    and i.cleanup_locked_by = p_worker_id
  for update;
  if not found then
    raise exception 'Lease de limpieza inexistente o vencida.' using errcode = '40001';
  end if;

  v_retried := p_retryable and v_intent.cleanup_attempt < 3;
  update public.supporting_document_upload_intents i
  set cleanup_available_at = case
        when v_retried then pg_catalog.clock_timestamp()
          + pg_catalog.make_interval(secs => p_retry_delay_seconds)
        else i.cleanup_available_at
      end,
      cleanup_locked_at = null,
      cleanup_locked_by = null,
      cleanup_completed_at = case
        when v_retried then null
        else pg_catalog.clock_timestamp()
      end,
      cleanup_result = case when v_retried then null else 'FAILED' end,
      cleanup_error_code = p_error_code
  where i.id = p_intent_id;

  if not v_retried then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null,
      'SUPPORTING_DOCUMENT_ORPHAN_CLEANUP_FAILED',
      'supporting_document_upload_intents',
      v_intent.id,
      pg_catalog.jsonb_build_object(
        'result', 'FAILED',
        'error_code', p_error_code,
        'attempts', v_intent.cleanup_attempt
      )
    );
  end if;
  return v_retried;
end;
$$;

revoke all on function public.reclaim_stale_supporting_document_cleanups(integer)
  from public, anon, authenticated;
revoke all on function public.claim_expired_supporting_document_uploads(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_supporting_document_orphan_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_supporting_document_orphan_cleanup(uuid, uuid, text, boolean, integer)
  from public, anon, authenticated;

grant execute on function public.reclaim_stale_supporting_document_cleanups(integer)
  to service_role;
grant execute on function public.claim_expired_supporting_document_uploads(uuid, integer, integer)
  to service_role;
grant execute on function public.complete_supporting_document_orphan_cleanup(uuid, uuid, text)
  to service_role;
grant execute on function public.fail_supporting_document_orphan_cleanup(uuid, uuid, text, boolean, integer)
  to service_role;

comment on function public.claim_expired_supporting_document_uploads(uuid, integer, integer) is
  'Claim SKIP LOCKED de reservas laborales vencidas. Excluye de forma autoritativa cualquier storage_path ya registrado.';
comment on function public.complete_supporting_document_orphan_cleanup(uuid, uuid, text) is
  'Cierra una limpieza fenced y audita solo identificador, resultado y numero de intentos; nunca expone la ruta.';
