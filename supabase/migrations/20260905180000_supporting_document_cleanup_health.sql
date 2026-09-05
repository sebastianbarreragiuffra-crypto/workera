-- P0-A: snapshot minimo de salud para observar el sweeper laboral.
-- No retorna storage_path, actor, empleado ni nombres de archivos.

create or replace function public.get_supporting_document_cleanup_health(
  p_stale_after_seconds integer default 93600
)
returns table (
  pending_ready_count bigint,
  locked_count bigint,
  failed_count bigint,
  stale_pending_count bigint,
  oldest_pending_expires_at timestamptz,
  requires_attention boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_stale_after_seconds is null
     or p_stale_after_seconds < 3600
     or p_stale_after_seconds > 604800 then
    raise exception 'Umbral de salud de documentos invalido.' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select i.*
    from public.supporting_document_upload_intents i
    where i.consumed_at is null
      and not exists (
        select 1
        from public.supporting_documents d
        where d.storage_path = i.storage_path
      )
  ), snapshot as (
    select
      count(*) filter (
        where c.cleanup_completed_at is null
          and c.cleanup_locked_at is null
          and c.cleanup_attempt < 3
          and c.cleanup_available_at <= pg_catalog.clock_timestamp()
          and c.expires_at <= pg_catalog.clock_timestamp() - interval '5 minutes'
      )::bigint as pending_ready_count,
      count(*) filter (
        where c.cleanup_completed_at is null
          and c.cleanup_locked_at is not null
      )::bigint as locked_count,
      count(*) filter (
        where c.cleanup_result = 'FAILED'
      )::bigint as failed_count,
      count(*) filter (
        where c.cleanup_completed_at is null
          and c.cleanup_locked_at is null
          and c.expires_at <= pg_catalog.clock_timestamp()
            - pg_catalog.make_interval(secs => p_stale_after_seconds)
      )::bigint as stale_pending_count,
      min(c.expires_at) filter (
        where c.cleanup_completed_at is null
          and c.cleanup_locked_at is null
          and c.cleanup_attempt < 3
          and c.cleanup_available_at <= pg_catalog.clock_timestamp()
          and c.expires_at <= pg_catalog.clock_timestamp() - interval '5 minutes'
      ) as oldest_pending_expires_at
    from candidates c
  )
  select
    s.pending_ready_count,
    s.locked_count,
    s.failed_count,
    s.stale_pending_count,
    s.oldest_pending_expires_at,
    s.failed_count > 0 or s.stale_pending_count > 0
  from snapshot s;
end;
$$;

revoke all on function public.get_supporting_document_cleanup_health(integer)
  from public, anon, authenticated;
grant execute on function public.get_supporting_document_cleanup_health(integer)
  to service_role;

comment on function public.get_supporting_document_cleanup_health(integer) is
  'Snapshot global sin PII para watchdog: backlog listo, leases, fallos terminales y antiguedad.';
