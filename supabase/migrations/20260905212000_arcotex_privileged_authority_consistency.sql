-- Cierra dos remanentes de autoridad legacy después de separar ARCOTEX del
-- control plane multiempresa. Conservar un rol en profiles sirve para una
-- reactivación explícita, pero no puede seguir exigiendo MFA ni concediendo
-- aprobación médica cuando el workspace laboral está cerrado.

create or replace function public.account_requires_mfa(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.profiles p
      join public.company_memberships cm
        on cm.user_id = p.id
       and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and cm.active
      join public.companies c
        on c.id = cm.company_id
       and c.active
       and c.status = 'ACTIVE'
       and c.workspace_enabled
      where p.id = p_user
        and p.active
        and p.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
    )
    or exists (
      select 1
      from public.platform_memberships pm
      join public.profiles p
        on p.id = pm.user_id
       and p.active
      where pm.user_id = p_user
        and pm.active
        and pm.role in ('OWNER', 'ADMIN')
    ),
    false
  );
$$;

comment on function public.account_requires_mfa(uuid) is
  'MFA se exige a OWNER/ADMIN de plataforma activos y a roles privilegiados '
  'legacy solo mientras su identidad, membresía y workspace ARCOTEX sentinel '
  'están activos. Cerrar ARCOTEX no debilita MFA del control plane.';

revoke all on function public.account_requires_mfa(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.is_medical_license_approver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.profiles p
      join public.company_memberships cm
        on cm.user_id = p.id
       and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and cm.active
      join public.companies c
        on c.id = cm.company_id
       and c.active
       and c.status = 'ACTIVE'
       and c.workspace_enabled
      join public.company_membership_roles cmr
        on cmr.company_id = cm.company_id
       and cmr.membership_id = cm.id
      join public.company_roles cr
        on cr.company_id = cmr.company_id
       and cr.id = cmr.role_id
       and cr.active
      join public.company_role_permissions crp
        on crp.company_id = cr.company_id
       and crp.role_id = cr.id
       and crp.permission_code = 'licenses.approve'
      where p.id = auth.uid()
        and p.active
        and p.medical_license_approver
    ),
    false
  );
$$;

comment on function public.is_medical_license_approver() is
  'Aprobación médica legacy solo para la identidad marcada que conserva '
  'membresía y permiso licenses.approve en el workspace ARCOTEX sentinel '
  'activo. Estado ONBOARDING o workspace cerrado revocan el acceso.';

revoke all on function public.is_medical_license_approver()
  from public, anon, authenticated, service_role;
grant execute on function public.is_medical_license_approver()
  to authenticated;
