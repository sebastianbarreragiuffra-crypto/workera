-- Integra la protección MFA de los RPC privilegiados con el catálogo de
-- módulos tenant-aware introducido por MT-3B.
--
-- La migración 20260904120000 agregó la guarda AAL2 reproduciendo una versión
-- anterior de esta función. Eso reintrodujo la excepción hardcodeada para
-- `expenses` y volvió a provisionar sus defaults dentro del control plane,
-- anulando el diseño genérico de 20260902140000. Esta versión conserva AAL2,
-- vuelve a decidir por module_catalog.tenant_isolated y deja la inicialización
-- de Rendiciones en su trigger de dominio.

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
  v_workspace_enabled boolean;
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

  select cm.status, mc.active, mc.tenant_isolated, c.workspace_enabled
    into v_previous_status, v_catalog_active, v_tenant_isolated, v_workspace_enabled
  from public.company_modules cm
  join public.module_catalog mc on mc.key = cm.module_key
  join public.companies c on c.id = cm.company_id
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key
  for update of cm;

  -- La autorización puede revocarse mientras esta sesión espera el lock. La
  -- segunda lectura cierra esa ventana antes de cualquier mutación.
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;

  if not found then
    raise exception 'Modulo no provisionado para la empresa.'
      using errcode = '23503';
  end if;

  if not v_catalog_active and p_status in ('ENABLED', 'PILOT') then
    raise exception 'No se puede habilitar un modulo inactivo del catalogo.'
      using errcode = '23514';
  end if;

  if v_workspace_enabled and not v_tenant_isolated and p_status <> v_previous_status then
    raise exception 'Los módulos de un workspace operativo no se pueden cambiar hasta completar los gates backend y RLS de MT-3D.'
      using errcode = '23514';
  end if;

  update public.company_modules cm
  set status = p_status,
      enabled_at = case
        when p_status in ('ENABLED', 'PILOT')
          then case
            when v_previous_status in ('ENABLED', 'PILOT') then cm.enabled_at
            else pg_catalog.clock_timestamp()
          end
        else null
      end,
      enabled_by = case
        when p_status in ('ENABLED', 'PILOT') then v_actor_id
        else null
      end
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key;

  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    p_company_id,
    'company.module.status_changed',
    'company_module',
    p_module_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', p_status
    )
  );
end;
$$;

comment on function public.platform_set_company_module_status(uuid, text, public.company_module_status) is
  'Cambia entitlements según module_catalog, exige MFA para actores privilegiados, conserva enabled_at/enabled_by y audita atómicamente.';
