-- P0-A: cuota distribuida, MFA y auditoria para las tres descargas laborales
-- heredadas que aun operan exclusivamente en ARCOTEX.
--
-- Esta migracion NO declara resuelta la multiempresa: payroll_batches,
-- supplier_master_imports y parte del modelo de asistencia todavia no poseen
-- company_id. La funcion deriva deliberadamente el unico workspace laboral
-- habilitado (slug arcotex) y falla cerrada para cualquier otro escenario.

alter table public.workforce_data_access_limits
  drop constraint workforce_data_access_limits_scope_check;

alter table public.workforce_data_access_limits
  add constraint workforce_data_access_limits_scope_check check (scope in (
    'supporting_document.download',
    'attendance.export',
    'payroll_batch.export',
    'supplier_master.download'
  ));

create or replace function public.can_read_supplier_master_path(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and public.is_privileged_admin()
    and public.current_actor_satisfies_mfa()
    and exists (
      select 1
      from public.companies c
      join public.supplier_master_imports i
        on i.storage_path = p_storage_path and i.status = 'ACTIVE'
      where c.slug = 'arcotex'
        and c.active
        and c.workspace_enabled
        and public.is_active_company_member(c.id)
    );
$$;

comment on function public.can_read_supplier_master_path(text) is
  'Permite leer solo la ruta del maestro ACTIVE del workspace laboral ARCOTEX, '
  'con rol privilegiado, membresia vigente y MFA aplicable. No habilita una '
  'segunda empresa mientras la tabla no tenga company_id.';

revoke all on function public.can_read_supplier_master_path(text) from public, anon;
grant execute on function public.can_read_supplier_master_path(text) to authenticated;

drop policy if exists supplier_master_files_storage_select on storage.objects;
create policy supplier_master_files_storage_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'supplier-master-files'
    and public.can_read_supplier_master_path(name)
  );

create or replace function public.authorize_workforce_data_access(
  p_scope text,
  p_resource_id uuid default null,
  p_period_type text default null,
  p_period_start date default null,
  p_period_end date default null
)
returns table (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer,
  storage_path text,
  original_filename text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_entity_id uuid;
  v_storage_path text;
  v_original_filename text;
  v_event_prefix text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_started_at timestamptz;
  v_window_seconds constant integer := 3600;
  v_limit integer;
  v_request_count integer;
begin
  if v_actor_id is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;

  select c.id
  into v_company_id
  from public.companies c
  where c.slug = 'arcotex'
    and c.active
    and c.workspace_enabled;

  if v_company_id is null
     or not coalesce(public.is_active_company_member(v_company_id), false)
     or not coalesce(public.current_actor_satisfies_mfa(), false) then
    raise exception 'Acceso no autorizado.' using errcode = '42501';
  end if;

  case p_scope
    when 'attendance.export' then
      v_limit := 20;
      v_event_prefix := 'ATTENDANCE_EXPORT';
      v_entity_id := v_company_id;
      if not coalesce(public.is_corporate_user(), false) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;
      if p_resource_id is not null
         or p_period_type is null
         or p_period_type not in ('SEMANAL', 'QUINCENAL', 'MENSUAL', 'PAGO')
         or p_period_start is null
         or p_period_end is null
         or p_period_end < p_period_start
         or p_period_end - p_period_start > 62 then
        raise exception 'Periodo invalido.' using errcode = '22023';
      end if;

    when 'payroll_batch.export' then
      v_limit := 20;
      v_event_prefix := 'PAYROLL_BATCH_EXPORT';
      if not coalesce(public.is_privileged_admin(), false) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;
      if p_resource_id is null
         or p_period_type is not null
         or p_period_start is not null
         or p_period_end is not null then
        raise exception 'Recurso invalido.' using errcode = '22023';
      end if;
      select b.id into v_entity_id
      from public.payroll_batches b
      where b.id = p_resource_id;
      if v_entity_id is null then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'supplier_master.download' then
      v_limit := 10;
      v_event_prefix := 'SUPPLIER_MASTER_DOWNLOAD';
      if not coalesce(public.is_privileged_admin(), false) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;
      if p_resource_id is not null
         or p_period_type is not null
         or p_period_start is not null
         or p_period_end is not null then
        raise exception 'Esta superficie no acepta parametros.' using errcode = '22023';
      end if;
      select i.id, i.storage_path, i.original_filename
      into v_entity_id, v_storage_path, v_original_filename
      from public.supplier_master_imports i
      where i.status = 'ACTIVE';
      if v_entity_id is null or v_storage_path is null then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    else
      raise exception 'Superficie no permitida.' using errcode = '22023';
  end case;

  v_window_started_at := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from v_now) / v_window_seconds)
      * v_window_seconds
  );

  insert into public.workforce_data_access_limits as limits (
    company_id, actor_id, scope, window_started_at, request_count, updated_at
  ) values (
    v_company_id, v_actor_id, p_scope, v_window_started_at, 1, v_now
  )
  on conflict (company_id, actor_id, scope) do update
  set window_started_at = excluded.window_started_at,
      request_count = case
        when limits.window_started_at <> excluded.window_started_at then 1
        else least(limits.request_count + 1, v_limit + 2)
      end,
      updated_at = excluded.updated_at
  returning limits.window_started_at, limits.request_count
  into v_window_started_at, v_request_count;

  allowed := v_request_count <= v_limit;
  request_limit := v_limit;
  remaining := greatest(v_limit - v_request_count, 0);
  retry_after_seconds := case when allowed then 0 else
    greatest(
      pg_catalog.ceil(extract(epoch from (
        v_window_started_at
        + pg_catalog.make_interval(secs => v_window_seconds)
        - v_now
      )))::integer,
      1
    )
  end;

  if allowed then
    storage_path := v_storage_path;
    original_filename := v_original_filename;
  else
    storage_path := null;
    original_filename := null;
  end if;

  if allowed or v_request_count = v_limit + 1 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      v_actor_id,
      v_event_prefix || case when allowed then '_AUTHORIZED' else '_RATE_LIMITED' end,
      case p_scope
        when 'attendance.export' then 'attendance_exports'
        when 'payroll_batch.export' then 'payroll_batches'
        else 'supplier_master_imports'
      end,
      v_entity_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'scope', p_scope,
        'period_type', p_period_type,
        'period_start', p_period_start,
        'period_end', p_period_end,
        'request_count', v_request_count,
        'request_limit', v_limit,
        'retry_after_seconds', case when allowed then null else retry_after_seconds end
      ))
    );
  end if;

  return next;
end;
$$;

comment on function public.authorize_workforce_data_access(text, uuid, text, date, date) is
  'Gate transitorio ARCOTEX para asistencia, lotes de nomina y maestro de '
  'proveedores: exige sesion, membresia, rol, MFA, recurso/periodo valido, '
  'consume cuota y audita antes de entregar datos. No habilita multiempresa.';

revoke all on function public.authorize_workforce_data_access(text, uuid, text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_workforce_data_access(text, uuid, text, date, date)
  to authenticated;
