-- Offboarding y reactivación tenant-aware. Revocar el DML directo cerró una
-- vía insegura, pero también dejó al control plane sin una operación legítima
-- para retirar acceso. Este RPC conserva los roles al desactivar para que una
-- reactivación explícita pueda restaurar el mismo alcance sin adivinarlo.

create or replace function public.platform_set_company_membership_active(
  p_membership_id uuid,
  p_active boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_user_id uuid;
  v_previous_active boolean;
  v_profile_active boolean;
  v_company_active boolean;
  v_company_status public.company_lifecycle_status;
  v_workspace_enabled boolean;
  v_legacy_role public.app_role;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_membership_id is null or p_active is null then
    raise exception 'membership_id y active son obligatorios.'
      using errcode = '22004';
  end if;

  select cm.company_id, cm.user_id, cm.active, cm.role, p.active,
         c.active, c.status, c.workspace_enabled
    into v_company_id, v_user_id, v_previous_active, v_legacy_role,
         v_profile_active, v_company_active, v_company_status,
         v_workspace_enabled
  from public.company_memberships cm
  join public.profiles p on p.id = cm.user_id
  join public.companies c on c.id = cm.company_id
  where cm.id = p_membership_id
  for update of cm, p, c;

  if not found then
    raise exception 'Membresía empresarial inexistente.' using errcode = 'P0002';
  end if;

  -- Cierra la ventana entre autorización y adquisición de locks.
  if not public.can_manage_platform() then
    raise exception 'Tu autorización de plataforma ya no está activa.'
      using errcode = '42501';
  end if;

  if p_active = v_previous_active then
    return;
  end if;

  if p_active then
    if not v_profile_active then
      raise exception 'No se puede reactivar el acceso de una identidad global inactiva.'
        using errcode = '23514';
    end if;
    if not v_company_active or v_company_status not in ('ACTIVE', 'ONBOARDING') then
      raise exception 'No se puede reactivar acceso a una empresa inactiva o suspendida.'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.company_membership_roles cmr
      join public.company_roles cr
        on cr.company_id = cmr.company_id
       and cr.id = cmr.role_id
       and cr.active
      where cmr.company_id = v_company_id
        and cmr.membership_id = p_membership_id
        and (
          not v_workspace_enabled
          or (v_legacy_role is not null and cr.base_role = v_legacy_role)
        )
    ) then
      raise exception 'Asigna un rol empresarial compatible antes de reactivar el acceso.'
        using errcode = '23514';
    end if;
  end if;

  update public.company_memberships
  set active = p_active,
      updated_at = pg_catalog.clock_timestamp()
  where id = p_membership_id;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.membership.status_changed',
    'company_membership', p_membership_id::text,
    pg_catalog.jsonb_build_object(
      'member_user_id', v_user_id,
      'previous_active', v_previous_active,
      'active', p_active,
      'roles_preserved', true
    )
  );
end;
$$;

comment on function public.platform_set_company_membership_active(uuid, boolean) is
  'Desactiva o reactiva una membresía con OWNER/ADMIN+AAL2, locks, rol compatible y auditoría; conserva sus asignaciones de rol.';

revoke all on function public.platform_set_company_membership_active(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.platform_set_company_membership_active(uuid, boolean)
  to authenticated;
