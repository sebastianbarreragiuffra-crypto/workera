-- Un tenant nuevo no puede activar módulos cuyo modelo de datos sigue ligado
-- al workspace laboral de ARCOTEX. La UI ya no es la única barrera: el RPC
-- decide por la capacidad declarada en module_catalog.tenant_isolated.

create or replace function public.platform_set_company_module_status(
  p_company_id uuid,
  p_module_key text,
  p_status public.company_module_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_module_status;
  v_catalog_active boolean;
  v_tenant_isolated boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_module_key is null or p_status is null then
    raise exception 'company_id, module_key y status son obligatorios.'
      using errcode = '22004';
  end if;

  select cm.status, mc.active, mc.tenant_isolated
    into v_previous_status, v_catalog_active, v_tenant_isolated
  from public.company_modules cm
  join public.module_catalog mc on mc.key = cm.module_key
  join public.companies c
    on c.id = cm.company_id
   and c.active
   and c.status in ('ACTIVE', 'ONBOARDING')
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key
  for update of cm;

  -- Revalidar después del lock evita que una revocación concurrente del actor
  -- llegue tarde respecto de la mutación.
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;

  if not found then
    raise exception 'Módulo o empresa inexistente o inactiva.'
      using errcode = '23503';
  end if;

  if not v_catalog_active and p_status in ('ENABLED', 'PILOT') then
    raise exception 'No se puede habilitar un módulo inactivo del catálogo.'
      using errcode = '23514';
  end if;

  if not v_tenant_isolated and p_status <> v_previous_status then
    raise exception 'Este módulo sigue ligado al workspace laboral y no puede cambiarse hasta completar su aislamiento multiempresa.'
      using errcode = '23514';
  end if;

  -- Un no-op es idempotente y no genera un evento de auditoría ficticio.
  if p_status = v_previous_status then
    return;
  end if;

  update public.company_modules cm
  set status = p_status,
      enabled_at = case
        when p_status in ('ENABLED', 'PILOT') then pg_catalog.clock_timestamp()
        else null
      end,
      enabled_by = case
        when p_status in ('ENABLED', 'PILOT') then v_actor_id
        else null
      end
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, p_company_id, 'company.module.status_changed',
    'company_module', p_module_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', p_status,
      'tenant_isolated', v_tenant_isolated
    )
  );
end;
$$;

comment on function public.platform_set_company_module_status(
  uuid, text, public.company_module_status
) is
  'Cambia solo módulos tenant-isolated de empresas operables; exige MFA, revalida al actor y audita cambios efectivos.';
