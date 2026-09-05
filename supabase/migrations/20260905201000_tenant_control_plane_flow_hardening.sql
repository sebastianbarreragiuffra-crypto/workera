-- Endurece los flujos del control plane después de separar la identidad
-- global, la membresía tenant y el workspace laboral legacy.

-- ---------------------------------------------------------------------------
-- Directorio mínimo: una cuenta ve su propio perfil, el control plane ve el
-- directorio global y un miembro tenant solo ve perfiles de empresas donde
-- posee company.members.read. Se elimina el SELECT global heredado de RRHH.

create or replace function public.can_read_profile(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_target = auth.uid()
    or public.is_platform_admin()
    or exists (
      select 1
      from public.company_memberships target
      join public.companies c
        on c.id = target.company_id
       and c.active
       and c.status in ('ACTIVE', 'ONBOARDING')
      where target.user_id = p_target
        and target.active
        and public.has_company_permission(
          target.company_id,
          'company.members.read'
        )
    ),
    false
  );
$$;

comment on function public.can_read_profile(uuid) is
  'Directorio tenant mínimo: perfil propio, control plane o co-membresía con '
  'company.members.read. Evita enumeración de identidades entre empresas.';

revoke all on function public.can_read_profile(uuid) from public, anon;
grant execute on function public.can_read_profile(uuid) to authenticated;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_select_platform on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.can_read_profile(id));

-- Activar/desactivar una identidad o cambiar profiles.role afecta todos sus
-- tenants. Por eso solo el OWNER del control plane puede hacerlo directamente;
-- los roles de empresa cambian mediante los RPC tenant-aware auditados.
drop policy if exists profiles_update_admin_only on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    public.current_platform_role() = 'OWNER'
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
  )
  with check (
    public.current_platform_role() = 'OWNER'
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
  );

comment on policy profiles_update on public.profiles is
  'Solo OWNER de plataforma en AAL2 modifica la identidad global. La administración '
  'tenant usa invitaciones y platform_assign_company_role.';

-- El control plane no admite escrituras directas a tablas. Las policies
-- históricas basadas solo en permisos permitían saltarse MFA, auditoría y
-- jerarquía (por ejemplo, autoasignarse COMPANY_OWNER). Toda mutación queda
-- centralizada en RPC SECURITY DEFINER con validación explícita.
drop policy if exists companies_insert_platform on public.companies;
drop policy if exists companies_update_platform on public.companies;
drop policy if exists platform_memberships_insert on public.platform_memberships;
drop policy if exists platform_memberships_update on public.platform_memberships;
drop policy if exists company_memberships_insert_platform on public.company_memberships;
drop policy if exists company_memberships_update_platform on public.company_memberships;
drop policy if exists company_memberships_insert_company_admin on public.company_memberships;
drop policy if exists company_memberships_update_company_admin on public.company_memberships;
drop policy if exists company_roles_write on public.company_roles;
drop policy if exists company_role_permissions_write on public.company_role_permissions;
drop policy if exists company_membership_roles_write on public.company_membership_roles;
drop policy if exists company_modules_write on public.company_modules;
drop policy if exists company_invitations_write on public.company_invitations;
drop policy if exists company_onboarding_steps_write on public.company_onboarding_steps;
drop policy if exists organization_units_write on public.organization_units;
drop policy if exists job_positions_write on public.job_positions;
drop policy if exists employee_org_assignments_write on public.employee_org_assignments;
drop policy if exists organization_unit_leads_write on public.organization_unit_leads;
drop policy if exists reporting_lines_write on public.reporting_lines;
drop policy if exists membership_org_scopes_write on public.membership_org_scopes;
drop policy if exists platform_audit_log_insert on public.platform_audit_log;

revoke insert, update, delete on
  public.companies,
  public.platform_memberships,
  public.company_memberships,
  public.company_roles,
  public.company_role_permissions,
  public.company_membership_roles,
  public.company_modules,
  public.company_invitations,
  public.company_onboarding_steps,
  public.organization_units,
  public.job_positions,
  public.employee_org_assignments,
  public.organization_unit_leads,
  public.reporting_lines,
  public.membership_org_scopes,
  public.platform_audit_log
from authenticated;

-- ---------------------------------------------------------------------------
-- Asignación de rol principal: siempre converge ambas representaciones. Para
-- un tenant RBAC puro, el valor legacy se limpia a NULL.

create or replace function public.platform_assign_company_role(
  p_membership_id uuid,
  p_role_id uuid
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
  v_member_user_id uuid;
  v_membership_active boolean;
  v_workspace_enabled boolean;
  v_role_company_id uuid;
  v_base_role public.app_role;
  v_role_code text;
  v_role_active boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_membership_id is null or p_role_id is null then
    raise exception 'membership_id y role_id son obligatorios.'
      using errcode = '22004';
  end if;

  select cm.company_id, cm.user_id, cm.active, c.workspace_enabled
    into v_company_id, v_member_user_id, v_membership_active, v_workspace_enabled
  from public.company_memberships cm
  join public.companies c
    on c.id = cm.company_id
   and c.active
   and c.status in ('ACTIVE', 'ONBOARDING')
  join public.profiles p
    on p.id = cm.user_id
   and p.active
  where cm.id = p_membership_id
  for update of cm, p;

  if not found then
    raise exception 'Membresia, empresa o identidad inexistente o inactiva.'
      using errcode = '23503';
  end if;
  if not v_membership_active then
    raise exception 'No se puede asignar un rol a una membresia inactiva.'
      using errcode = '23514';
  end if;

  select cr.company_id, cr.base_role, cr.code, cr.active
    into v_role_company_id, v_base_role, v_role_code, v_role_active
  from public.company_roles cr
  where cr.id = p_role_id
  for key share;

  if not found then
    raise exception 'Rol empresarial inexistente.' using errcode = '23503';
  end if;
  if v_role_company_id <> v_company_id then
    raise exception 'La membresia y el rol deben pertenecer a la misma empresa.'
      using errcode = '23514';
  end if;
  if not v_role_active then
    raise exception 'No se puede asignar un rol empresarial inactivo.'
      using errcode = '23514';
  end if;
  if v_workspace_enabled and v_base_role is null then
    raise exception 'Un workspace habilitado requiere un rol con compatibilidad legacy.'
      using errcode = '23514';
  end if;

  delete from public.company_membership_roles cmr
  where cmr.company_id = v_company_id
    and cmr.membership_id = p_membership_id;

  insert into public.company_membership_roles (
    company_id, membership_id, role_id, assigned_by
  ) values (
    v_company_id, p_membership_id, p_role_id, v_actor_id
  );

  update public.company_memberships cm
  set role = v_base_role,
      updated_at = pg_catalog.clock_timestamp()
  where cm.id = p_membership_id;

  if v_workspace_enabled then
    update public.profiles p
    set role = v_base_role
    where p.id = v_member_user_id;
  end if;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.membership_role.assigned',
    'company_membership', p_membership_id::text,
    pg_catalog.jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_role_code,
      'membership_legacy_role_updated', true,
      'membership_legacy_role_cleared', v_base_role is null,
      'profile_legacy_role_updated', v_workspace_enabled
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Una invitación no se usa para mutar a un miembro ya activo y tampoco puede
-- proponer un rol sin equivalente legacy a un workspace laboral habilitado.

create or replace function public.platform_create_company_invitation(
  p_company_id uuid,
  p_email text,
  p_role_id uuid,
  p_expires_at timestamptz default (pg_catalog.now() + interval '7 days')
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_invitation_id uuid := gen_random_uuid();
  v_email text := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  v_role_company_id uuid;
  v_role_code text;
  v_role_active boolean;
  v_base_role public.app_role;
  v_workspace_enabled boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or v_email is null or p_role_id is null or p_expires_at is null then
    raise exception 'company_id, email, role_id y expires_at son obligatorios.'
      using errcode = '22004';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'El correo de invitacion no tiene un formato valido.'
      using errcode = '22023';
  end if;
  if p_expires_at <= pg_catalog.now() then
    raise exception 'La invitacion debe vencer en el futuro.'
      using errcode = '22023';
  end if;

  select c.workspace_enabled into v_workspace_enabled
  from public.companies c
  where c.id = p_company_id
    and c.active
    and c.status in ('ACTIVE', 'ONBOARDING');

  if not found then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '23503';
  end if;

  select cr.company_id, cr.code, cr.active, cr.base_role
    into v_role_company_id, v_role_code, v_role_active, v_base_role
  from public.company_roles cr
  where cr.id = p_role_id
  for key share;

  if not found then
    raise exception 'Rol empresarial inexistente.' using errcode = '23503';
  end if;
  if v_role_company_id <> p_company_id then
    raise exception 'La invitacion y el rol deben pertenecer a la misma empresa.'
      using errcode = '23514';
  end if;
  if not v_role_active then
    raise exception 'No se puede invitar con un rol empresarial inactivo.'
      using errcode = '23514';
  end if;
  if v_workspace_enabled and v_base_role is null then
    raise exception 'El workspace habilitado exige un rol con compatibilidad legacy.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from auth.users u
    join public.company_memberships cm
      on cm.user_id = u.id
     and cm.company_id = p_company_id
     and cm.active
    where pg_catalog.lower(pg_catalog.btrim(u.email)) = v_email
  ) then
    raise exception 'La persona ya es miembro activo de esta empresa.'
      using errcode = 'P0004';
  end if;

  update public.company_invitations ci
  set status = 'EXPIRED'::public.company_invitation_status
  where ci.company_id = p_company_id
    and ci.email = v_email
    and ci.status = 'PENDING'
    and ci.expires_at <= pg_catalog.now();

  insert into public.company_invitations (
    id, company_id, email, role_id, status, expires_at, invited_by
  ) values (
    v_invitation_id, p_company_id, v_email, p_role_id,
    'PENDING', p_expires_at, v_actor_id
  );

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, p_company_id, 'company.invitation.created',
    'company_invitation', v_invitation_id::text,
    pg_catalog.jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_role_code,
      'status', 'PENDING'
    )
  );

  return v_invitation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- go_live también puede cerrar el onboarding de un tenant solo-Rendiciones.
-- Eso NO habilita el workspace laboral ni debilita el gate MT-3B-D.

update public.onboarding_step_catalog
set description = 'Aprobar checklist y habilitar los módulos contratados; el workspace laboral mantiene su gate independiente.'
where key = 'go_live';

create or replace function public.platform_set_onboarding_step_completed(
  p_company_id uuid,
  p_step_key text,
  p_completed boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_onboarding_status;
  v_next_status public.company_onboarding_status;
  v_workspace_enabled boolean;
  v_independent_module_enabled boolean := false;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_step_key is null or p_completed is null then
    raise exception 'company_id, step_key y completed son obligatorios.'
      using errcode = '22004';
  end if;

  select cos.status, c.workspace_enabled
    into v_previous_status, v_workspace_enabled
  from public.company_onboarding_steps cos
  join public.companies c on c.id = cos.company_id
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key
    and c.active
    and c.status in ('ACTIVE', 'ONBOARDING')
  for update;

  if not found then
    raise exception 'Paso de onboarding no provisionado para la empresa.'
      using errcode = '23503';
  end if;

  if p_completed and p_step_key = 'go_live' and exists (
    select 1
    from public.onboarding_step_catalog osc
    left join public.company_onboarding_steps pending
      on pending.company_id = p_company_id
     and pending.step_key = osc.key
    where osc.active
      and osc.key <> 'go_live'
      and coalesce(pending.status, 'NOT_STARTED') <> 'COMPLETE'
  ) then
    raise exception 'Completa los pasos anteriores antes de activar la empresa.'
      using errcode = '23514';
  end if;

  if not p_completed and p_step_key = 'go_live' and v_workspace_enabled then
    raise exception 'No se puede reabrir go_live mientras el workspace laboral está operativo.'
      using errcode = '23514';
  end if;

  if not p_completed and p_step_key <> 'go_live' and exists (
    select 1
    from public.company_onboarding_steps live_step
    where live_step.company_id = p_company_id
      and live_step.step_key = 'go_live'
      and live_step.status = 'COMPLETE'
  ) then
    raise exception 'Reabre go_live antes de reabrir un paso anterior.'
      using errcode = '23514';
  end if;

  if p_completed and p_step_key = 'go_live' and not v_workspace_enabled then
    select exists (
      select 1
      from public.company_modules cm
      join public.module_catalog mc
        on mc.key = cm.module_key
       and mc.active
       and mc.tenant_isolated
      where cm.company_id = p_company_id
        and cm.status in ('ENABLED', 'PILOT')
    ) into v_independent_module_enabled;

    if not v_independent_module_enabled then
      raise exception 'Activa al menos un módulo multiempresa antes de completar go_live.'
        using errcode = '23514';
    end if;
  end if;

  v_next_status := case
    when p_completed then 'COMPLETE'::public.company_onboarding_status
    else 'NOT_STARTED'::public.company_onboarding_status
  end;

  update public.company_onboarding_steps cos
  set status = v_next_status,
      completed_at = case when p_completed then pg_catalog.clock_timestamp() else null end,
      completed_by = case when p_completed then v_actor_id else null end
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key;

  if p_completed and p_step_key = 'go_live' then
    update public.companies c
    set status = 'ACTIVE',
        onboarded_at = coalesce(c.onboarded_at, pg_catalog.clock_timestamp())
    where c.id = p_company_id;
  elsif not p_completed and p_step_key = 'go_live' then
    update public.companies c
    set status = 'ONBOARDING'
    where c.id = p_company_id
      and c.status = 'ACTIVE'
      and not c.workspace_enabled;
  end if;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, p_company_id, 'company.onboarding_step.status_changed',
    'company_onboarding_step', p_step_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', v_next_status,
      'workspace_enabled', v_workspace_enabled,
      'independent_module_enabled', v_independent_module_enabled
    )
  );
end;
$$;

-- El resultado de entrega forma parte de la trazabilidad de una invitación.
-- Un actor en aal1 no debe poder falsificar SENT/FAILED mediante RPC directo.
create or replace function public.platform_mark_company_invitation_delivery(
  p_invitation_id uuid,
  p_delivery_status text,
  p_error_code text default null
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
  v_status text := pg_catalog.upper(pg_catalog.btrim(p_delivery_status));
  v_error_code text := nullif(pg_catalog.left(pg_catalog.btrim(p_error_code), 80), '');
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_invitation_id is null then
    raise exception 'invitation_id es obligatorio.' using errcode = '22004';
  end if;
  if v_status is null or v_status not in ('SENT', 'ACCOUNT_EXISTS', 'FAILED') then
    raise exception 'Estado de entrega no válido.' using errcode = '22023';
  end if;

  update public.company_invitations ci
  set delivery_status = v_status,
      delivery_attempts = ci.delivery_attempts + 1,
      last_delivery_at = pg_catalog.clock_timestamp(),
      delivery_error_code = case when v_status = 'FAILED' then v_error_code else null end
  where ci.id = p_invitation_id
    and ci.status = 'PENDING'
  returning ci.company_id into v_company_id;

  if v_company_id is null then
    raise exception 'La invitación pendiente no existe.' using errcode = 'P0002';
  end if;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.invitation.delivery_attempted',
    'company_invitation', p_invitation_id::text,
    pg_catalog.jsonb_build_object(
      'delivery_status', v_status,
      'error_code', v_error_code
    )
  );
end;
$$;
