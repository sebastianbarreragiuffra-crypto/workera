-- pgTAP: los privilegios legacy dependen del workspace ARCOTEX vigente. El
-- control plane es una autoridad independiente y conserva MFA al cerrarlo.
create extension if not exists pgtap;

begin;
select plan(19);

select has_function(
  'public', 'account_requires_mfa', array['uuid'],
  'existe la decisión central de alcance MFA'
);
select has_function(
  'public', 'is_medical_license_approver', array[]::text[],
  'existe la decisión de aprobación médica'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.account_requires_mfa(uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.is_medical_license_approver()', 'EXECUTE'
  ),
  'la decisión MFA sigue interna y el helper médico conserva su ACL pública mínima'
);

insert into public.profiles (
  id, display_name, role, active, medical_license_approver
) values
  (
    '91000000-0000-4000-8000-000000000101',
    'Aprobación médica 091', 'ADMIN_RRHH', true, true
  ),
  (
    '91000000-0000-4000-8000-000000000102',
    'Owner plataforma 091', null, true, false
  );

insert into public.platform_memberships (user_id, role, active)
values ('91000000-0000-4000-8000-000000000102', 'OWNER', true);

select ok(
  exists (
    select 1
    from public.company_memberships cm
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id and cr.id = cmr.role_id
    join public.company_role_permissions crp
      on crp.company_id = cr.company_id and crp.role_id = cr.id
    where cm.user_id = '91000000-0000-4000-8000-000000000101'
      and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and cm.active
      and cr.active
      and crp.permission_code = 'licenses.approve'
  ),
  'el fixture tiene membresía ARCOTEX y permiso licenses.approve vigentes'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  public.is_medical_license_approver(),
  'el aprobador autorizado funciona con ARCOTEX ACTIVE y workspace abierto'
);
reset role;

select ok(
  public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'ADMIN_RRHH legacy vigente exige MFA'
);
select ok(
  public.account_requires_mfa('91000000-0000-4000-8000-000000000102'),
  'OWNER de plataforma vigente exige MFA'
);

update public.companies
set workspace_enabled = false
where id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  not public.is_medical_license_approver(),
  'cerrar el workspace revoca de inmediato la aprobación médica legacy'
);
reset role;

select ok(
  not public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'cerrar el workspace elimina el alcance MFA que provenía solo del rol legacy'
);
select ok(
  public.account_requires_mfa('91000000-0000-4000-8000-000000000102'),
  'cerrar ARCOTEX no elimina el MFA del OWNER del control plane'
);

update public.companies
set status = 'ONBOARDING'
where id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  not public.is_medical_license_approver(),
  'ONBOARDING no concede aprobación médica en el workspace legacy'
);
reset role;

select ok(
  not public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'ONBOARDING tampoco mantiene vigente la rama MFA legacy'
);

update public.companies
set status = 'SUSPENDED', active = false
where id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  not public.is_medical_license_approver(),
  'una compañía inactiva revoca la aprobación aunque el workspace siga marcado'
);
reset role;

select ok(
  not public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'una compañía inactiva revoca también la rama MFA legacy'
);

update public.companies
set active = true,
    status = 'ACTIVE',
    workspace_enabled = true
where id = '0a4c0000-0000-0000-0000-000000000001';
update public.company_memberships
set active = false
where user_id = '91000000-0000-4000-8000-000000000101'
  and company_id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  not public.is_medical_license_approver(),
  'una membresía inactiva revoca la aprobación médica'
);
reset role;

select ok(
  not public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'una membresía inactiva revoca la rama MFA legacy'
);

update public.company_memberships
set active = true
where user_id = '91000000-0000-4000-8000-000000000101'
  and company_id = '0a4c0000-0000-0000-0000-000000000001';
delete from public.company_role_permissions crp
using public.company_membership_roles cmr,
      public.company_memberships cm
where cm.user_id = '91000000-0000-4000-8000-000000000101'
  and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
  and cmr.company_id = cm.company_id
  and cmr.membership_id = cm.id
  and crp.company_id = cmr.company_id
  and crp.role_id = cmr.role_id
  and crp.permission_code = 'licenses.approve';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-4000-8000-000000000101';
select ok(
  not public.is_medical_license_approver(),
  'retirar licenses.approve revoca el privilegio aunque el flag siga activo'
);
reset role;

select ok(
  public.account_requires_mfa('91000000-0000-4000-8000-000000000101'),
  'el permiso médico no altera la rama MFA de un rol legacy vigente'
);

select ok(
  public.account_requires_mfa('91000000-0000-4000-8000-000000000102'),
  'el OWNER permanece dentro de MFA durante todo el cierre operacional'
);

select * from finish();
rollback;
