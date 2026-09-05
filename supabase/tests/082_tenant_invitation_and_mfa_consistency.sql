-- pgTAP: consistencia de invitaciones, rol principal y MFA durante la
-- transición desde profiles.role hacia RBAC multiempresa.
create extension if not exists pgtap;

begin;
select plan(35);

select is(
  (select is_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'company_memberships'
     and column_name = 'role'),
  'YES',
  'company_memberships.role admite tenants puramente RBAC'
);
select is(
  (select count(*)::integer from public.authorized_email_roles),
  1,
  'solo permanece el bootstrap de emergencia del OWNER inicial'
);
select ok(
  exists (
    select 1 from public.authorized_email_roles
    where role = 'SUPER_ADMIN' and platform_role = 'OWNER'
  ),
  'el único bootstrap conserva identidad, rol legacy y rol de plataforma'
);
select ok(
  has_function_privilege('authenticated', 'public.accept_my_company_invitations()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.accept_my_company_invitations()', 'EXECUTE'),
  'solo una sesión autenticada puede aceptar sus invitaciones'
);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  'b2000000-0000-0000-0000-000000000001',
  'Tenant Invitaciones 082', 'Tenant Invitaciones 082 SpA',
  'tenant-invitaciones-082', true, 'ONBOARDING', false
);
insert into public.profiles (id, display_name, role, active)
values ('b2000000-0000-0000-0000-000000000199', 'Actor Invitaciones 082', null, true);
insert into auth.users (id, email) values
  ('b2000000-0000-0000-0000-000000000101', 'auditor-082@example.test'),
  ('b2000000-0000-0000-0000-000000000102', 'reactivado-082@example.test'),
  ('b2000000-0000-0000-0000-000000000103', 'miembro-activo-082@example.test'),
  ('b2000000-0000-0000-0000-000000000104', 'admin-tenant-082@example.test'),
  ('b2000000-0000-0000-0000-000000000105', 'finanzas-082@example.test'),
  ('b2000000-0000-0000-0000-000000000106', 'legacy-arcotex-082@example.test'),
  ('b2000000-0000-0000-0000-000000000107', 'licencias-arcotex-082@example.test');

insert into public.company_roles (
  id, company_id, code, name, description, base_role, is_system, active
) values (
  'b2000000-0000-0000-0000-000000000301',
  'b2000000-0000-0000-0000-000000000001',
  'FINANCE_APPROVER_082', 'Aprobación financiera 082',
  'Rol RBAC puro con permiso financiero sensible.', null, false, true
);
insert into public.company_role_permissions (company_id, role_id, permission_code)
values (
  'b2000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000301',
  'expenses.approve'
);

-- Una invitación con rol sin base_role funciona en un tenant no laboral.
insert into public.company_invitations (
  id, company_id, email, role_id, status, expires_at, invited_by
)
select 'b2000000-0000-0000-0000-000000000201',
       'b2000000-0000-0000-0000-000000000001',
       'auditor-082@example.test', cr.id, 'PENDING',
       pg_catalog.now() + interval '1 day',
       'b2000000-0000-0000-0000-000000000199'
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'AUDITOR';

set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000101';
select is(public.accept_my_company_invitations(), 1,
  'el destinatario acepta una invitación puramente RBAC');
reset role;

select ok(
  exists (
    select 1 from public.company_memberships
    where company_id = 'b2000000-0000-0000-0000-000000000001'
      and user_id = 'b2000000-0000-0000-0000-000000000101'
      and active and role is null
  ),
  'la membresía RBAC queda activa sin inventar un rol legacy'
);
select is(
  (select cr.code
   from public.company_memberships cm
   join public.company_membership_roles cmr
     on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cm.user_id = 'b2000000-0000-0000-0000-000000000101'
     and cm.company_id = 'b2000000-0000-0000-0000-000000000001'),
  'AUDITOR',
  'la aceptación asigna exactamente el rol solicitado'
);
select ok(
  (select status = 'ACCEPTED'
          and accepted_by = 'b2000000-0000-0000-0000-000000000101'
          and accepted_at is not null
   from public.company_invitations
   where id = 'b2000000-0000-0000-0000-000000000201'),
  'la invitación queda aceptada por la identidad correcta'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where action = 'company.invitation.accepted'
     and target_id = 'b2000000-0000-0000-0000-000000000201'),
  1,
  'la aceptación queda auditada una sola vez'
);
select ok(
  not public.account_requires_mfa('b2000000-0000-0000-0000-000000000101'),
  'AUDITOR de solo lectura no queda elevado accidentalmente a MFA'
);

-- Reactivar una membresía reemplaza el rol anterior, nunca lo acumula.
insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  'b2000000-0000-0000-0000-000000000402',
  'b2000000-0000-0000-0000-000000000102',
  'b2000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', false
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select 'b2000000-0000-0000-0000-000000000001',
       'b2000000-0000-0000-0000-000000000402', cr.id
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';
insert into public.company_invitations (
  id, company_id, email, role_id, status, expires_at, invited_by
)
select 'b2000000-0000-0000-0000-000000000202',
       'b2000000-0000-0000-0000-000000000001',
       'reactivado-082@example.test', cr.id, 'PENDING',
       pg_catalog.now() + interval '1 day',
       'b2000000-0000-0000-0000-000000000199'
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'AUDITOR';

set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000102';
select is(public.accept_my_company_invitations(), 1,
  'una invitación puede reactivar una membresía inactiva');
reset role;

select ok(
  (select active and role is null from public.company_memberships
   where id = 'b2000000-0000-0000-0000-000000000402'),
  'la membresía reactivada converge al rol legacy del nuevo rol'
);
select is(
  (select array_agg(cr.code order by cr.code)
   from public.company_membership_roles cmr
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cmr.membership_id = 'b2000000-0000-0000-0000-000000000402'),
  array['AUDITOR']::text[],
  'la reactivación elimina el rol privilegiado anterior'
);
select is(
  (select status::text from public.company_invitations
   where id = 'b2000000-0000-0000-0000-000000000202'),
  'ACCEPTED',
  'la invitación de reactivación queda consumida'
);

-- Una invitación nunca sirve como cambio lateral de rol para un miembro activo.
insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  'b2000000-0000-0000-0000-000000000403',
  'b2000000-0000-0000-0000-000000000103',
  'b2000000-0000-0000-0000-000000000001', 'SUPER_ADMIN', true
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select 'b2000000-0000-0000-0000-000000000001',
       'b2000000-0000-0000-0000-000000000403', cr.id
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'COMPANY_OWNER';
insert into public.company_invitations (
  id, company_id, email, role_id, status, expires_at, invited_by
)
select 'b2000000-0000-0000-0000-000000000203',
       'b2000000-0000-0000-0000-000000000001',
       'miembro-activo-082@example.test', cr.id, 'PENDING',
       pg_catalog.now() + interval '1 day',
       'b2000000-0000-0000-0000-000000000199'
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'AUDITOR';

set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000103';
select is(public.accept_my_company_invitations(), 0,
  'un miembro activo no cambia de rol aceptando otra invitación');
reset role;

select is(
  (select status::text from public.company_invitations
   where id = 'b2000000-0000-0000-0000-000000000203'),
  'REVOKED',
  'la invitación lateral queda revocada'
);
select is(
  (select array_agg(cr.code order by cr.code)
   from public.company_membership_roles cmr
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cmr.membership_id = 'b2000000-0000-0000-0000-000000000403'),
  array['COMPANY_OWNER']::text[],
  'el miembro activo conserva exactamente su rol previo'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where action = 'company.invitation.revoked_existing_member'
     and target_id = 'b2000000-0000-0000-0000-000000000203'),
  1,
  'el rechazo de la invitación lateral queda auditado'
);

-- MFA conserva el alcance respaldado por guardas backend: roles legacy y
-- control plane. Un rol tenant puro todavía no se eleva por permisos RBAC.
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('b2000000-0000-0000-0000-000000000404',
   'b2000000-0000-0000-0000-000000000104',
   'b2000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('b2000000-0000-0000-0000-000000000405',
   'b2000000-0000-0000-0000-000000000105',
   'b2000000-0000-0000-0000-000000000001', null, true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select 'b2000000-0000-0000-0000-000000000001',
       'b2000000-0000-0000-0000-000000000404', cr.id
from public.company_roles cr
where cr.company_id = 'b2000000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';
insert into public.company_membership_roles (company_id, membership_id, role_id)
values (
  'b2000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000405',
  'b2000000-0000-0000-0000-000000000301'
);

select ok(not public.account_requires_mfa('b2000000-0000-0000-0000-000000000104'),
  'un ADMIN_RRHH solo tenant no entra todavía al alcance MFA');
select ok(not public.account_requires_mfa('b2000000-0000-0000-0000-000000000105'),
  'un rol RBAC puro con permiso financiero sensible aún no exige MFA');
update public.company_memberships set active = false
where id = 'b2000000-0000-0000-0000-000000000405';
select ok(not public.account_requires_mfa('b2000000-0000-0000-0000-000000000105'),
  'una membresía RBAC inactiva deja de exigir MFA');

update public.companies set active = false, status = 'SUSPENDED'
where id = 'b2000000-0000-0000-0000-000000000001';
select ok(not public.account_requires_mfa('b2000000-0000-0000-0000-000000000104'),
  'suspender la empresa mantiene fuera de alcance a la cuenta solo tenant');
update public.companies set active = true, status = 'ONBOARDING'
where id = 'b2000000-0000-0000-0000-000000000001';
update public.profiles set role = 'ADMIN_RRHH'
where id = 'b2000000-0000-0000-0000-000000000104';
select ok(public.account_requires_mfa('b2000000-0000-0000-0000-000000000104'),
  'el mismo perfil entra al alcance MFA al recibir ADMIN_RRHH legacy');
update public.profiles set active = false
where id = 'b2000000-0000-0000-0000-000000000104';
select ok(not public.account_requires_mfa('b2000000-0000-0000-0000-000000000104'),
  'un perfil inactivo tampoco exige MFA por su rol tenant');

-- La bandera histórica de aprobador no basta: debe existir una membresía
-- ARCOTEX activa y el rol asignado debe conceder licenses.approve.
update public.profiles
set display_name = 'Aprobador licencias ARCOTEX 082',
    medical_license_approver = true
where id = 'b2000000-0000-0000-0000-000000000107';
insert into public.company_roles (
  id, company_id, code, name, description, base_role, is_system, active
) values (
  'b2000000-0000-0000-0000-000000000307',
  '0a4c0000-0000-0000-0000-000000000001',
  'LICENSE_APPROVER_082', 'Aprobador licencias 082',
  'Rol custom que autoriza aprobación médica.', null, false, true
);
insert into public.company_role_permissions (company_id, role_id, permission_code)
values (
  '0a4c0000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000307', 'licenses.approve'
);
insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  'b2000000-0000-0000-0000-000000000407',
  'b2000000-0000-0000-0000-000000000107',
  '0a4c0000-0000-0000-0000-000000000001', null, true
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
values (
  '0a4c0000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000407',
  'b2000000-0000-0000-0000-000000000307'
);

-- El sentinel UUID, no un slug mutable, identifica el tenant legacy.
update public.companies set slug = 'arcotex-renamed-082'
where id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000107';
select ok(public.is_medical_license_approver(),
  'el UUID sentinel de ARCOTEX autoriza aunque cambie su slug');
reset role;
update public.companies set slug = 'arcotex'
where id = '0a4c0000-0000-0000-0000-000000000001';

update public.company_memberships set active = false
where id = 'b2000000-0000-0000-0000-000000000407';
set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000107';
select ok(not public.is_medical_license_approver(),
  'una membresía ARCOTEX inactiva revoca la aprobación médica');
reset role;

update public.company_memberships set active = true
where id = 'b2000000-0000-0000-0000-000000000407';
delete from public.company_role_permissions
where company_id = '0a4c0000-0000-0000-0000-000000000001'
  and role_id = 'b2000000-0000-0000-0000-000000000307'
  and permission_code = 'licenses.approve';
set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000107';
select ok(not public.is_medical_license_approver(),
  'la bandera histórica no autoriza sin licenses.approve');
reset role;

update public.profiles set medical_license_approver = true
where id = 'b2000000-0000-0000-0000-000000000105';
update public.company_memberships set active = true
where id = 'b2000000-0000-0000-0000-000000000405';
insert into public.company_role_permissions (company_id, role_id, permission_code)
values (
  'b2000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000301', 'licenses.approve'
);
set local role authenticated;
set local request.jwt.claim.sub = 'b2000000-0000-0000-0000-000000000105';
select ok(not public.is_medical_license_approver(),
  'licenses.approve fuera de ARCOTEX no concede aprobación médica legacy');
reset role;

-- El puente legacy ARCOTEX converge profiles, membership y rol RBAC.
update public.profiles set role = 'ADMIN_RRHH'
where id = 'b2000000-0000-0000-0000-000000000106';
select ok(
  exists (
    select 1 from public.company_memberships cm
    join public.companies c on c.id = cm.company_id
    where c.slug = 'arcotex'
      and cm.user_id = 'b2000000-0000-0000-0000-000000000106'
      and cm.active and cm.role = 'ADMIN_RRHH'
  ),
  'asignar profiles.role crea o reactiva la membresía ARCOTEX alineada'
);
select is(
  (select array_agg(cr.code order by cr.code)
   from public.company_memberships cm
   join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
   join public.company_membership_roles cmr
     on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cm.user_id = 'b2000000-0000-0000-0000-000000000106'),
  array['HR_ADMIN']::text[],
  'el puente deja un único rol RBAC equivalente en ARCOTEX'
);

-- Si ARCOTEX ya eligió un rol custom compatible, el puente no debe
-- reemplazarlo por el rol de sistema al sincronizar profiles.role.
insert into public.company_roles (
  id, company_id, code, name, description, base_role, is_system, active
) values (
  'b2000000-0000-0000-0000-000000000306',
  '0a4c0000-0000-0000-0000-000000000001',
  'CUSTOM_PRODUCTION_082', 'Producción custom 082',
  'Equivalente legacy elegido explícitamente por ARCOTEX.',
  'SUPERVISOR_PRODUCTION', false, true
);
delete from public.company_membership_roles
where membership_id = (
  select cm.id from public.company_memberships cm
  join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
  where cm.user_id = 'b2000000-0000-0000-0000-000000000106'
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, 'b2000000-0000-0000-0000-000000000306'
from public.company_memberships cm
join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
where cm.user_id = 'b2000000-0000-0000-0000-000000000106';
update public.profiles set role = 'SUPERVISOR_PRODUCTION'
where id = 'b2000000-0000-0000-0000-000000000106';
select is(
  (select cm.role::text from public.company_memberships cm
   join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
   where cm.user_id = 'b2000000-0000-0000-0000-000000000106'),
  'SUPERVISOR_PRODUCTION',
  'cambiar profiles.role actualiza la compatibilidad legacy de ARCOTEX'
);
select is(
  (select array_agg(cr.code order by cr.code)
   from public.company_memberships cm
   join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
   join public.company_membership_roles cmr
     on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cm.user_id = 'b2000000-0000-0000-0000-000000000106'),
  array['CUSTOM_PRODUCTION_082']::text[],
  'el cambio legacy preserva el rol custom compatible de ARCOTEX'
);
update public.profiles set active = false
where id = 'b2000000-0000-0000-0000-000000000106';
select ok(
  (select not cm.active and cm.role is null
   from public.company_memberships cm
   join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
   where cm.user_id = 'b2000000-0000-0000-0000-000000000106'),
  'desactivar el perfil desactiva y limpia la membresía ARCOTEX'
);
select is(
  (select count(*)::integer from public.company_membership_roles cmr
   join public.company_memberships cm on cm.id = cmr.membership_id
   join public.companies c on c.id = cm.company_id and c.slug = 'arcotex'
   where cm.user_id = 'b2000000-0000-0000-0000-000000000106'),
  0,
  'desactivar el perfil elimina los privilegios RBAC ARCOTEX'
);

set local role anon;
select throws_ok(
  $$select public.accept_my_company_invitations()$$,
  '42501', null,
  'anon no puede aceptar invitaciones'
);
reset role;

select * from finish();
rollback;
