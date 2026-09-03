-- MT-3B: los módulos que ya aíslan completamente sus datos y permisos por
-- empresa pueden cambiar de estado sin depender del workspace laboral legacy.
-- La decisión vive en el catálogo; el control plane no conoce módulos concretos.

alter table public.module_catalog
  add column tenant_isolated boolean not null default false;

comment on column public.module_catalog.tenant_isolated is
  'Indica que el módulo posee gates backend y RLS tenant-aware completos y puede cambiar de estado aunque el workspace laboral esté operativo.';

update public.module_catalog
set tenant_isolated = true
where key = 'expenses';

-- La inicialización de Rendiciones pertenece al dominio Rendiciones, no al RPC
-- genérico del control plane. El trigger conserva la operación atómica y la
-- idempotencia de provision_expense_defaults().
create or replace function public.provision_expense_defaults_on_module_enable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.provision_expense_defaults(new.company_id, new.enabled_by);
  return new;
end;
$$;

revoke all on function public.provision_expense_defaults_on_module_enable()
  from public, anon, authenticated;

create trigger company_modules_provision_expense_defaults
  after update of status on public.company_modules
  for each row
  when (
    new.module_key = 'expenses'
    and new.status in ('ENABLED', 'PILOT')
    and new.enabled_by is not null
  )
  execute function public.provision_expense_defaults_on_module_enable();

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
  'Cambia entitlements según las capacidades declaradas en module_catalog, mantiene enabled_at/enabled_by coherentes y audita el cambio atómicamente.';
