-- pgTAP: directorio mínimo, convergencia de roles, guardas de invitación y
-- go_live independiente para un tenant solo-Rendiciones.
create extension if not exists pgtap;

begin;
select plan(60);

select has_function(
  'public', 'can_read_profile', array['uuid'],
  'existe el helper tenant-aware del directorio mínimo'
);
select ok(
  has_function_privilege('authenticated', 'public.can_read_profile(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.can_read_profile(uuid)', 'EXECUTE'),
  'solo authenticated puede consultar el helper del directorio'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'companies', 'platform_memberships', 'company_memberships',
      'company_roles', 'company_role_permissions', 'company_membership_roles',
      'company_modules', 'company_invitations', 'company_onboarding_steps',
      'organization_units', 'job_positions', 'employee_org_assignments',
      'organization_unit_leads', 'reporting_lines', 'membership_org_scopes',
      'platform_audit_log'
    ]) as guarded(table_name)
    where has_table_privilege(
      'authenticated', pg_catalog.format('public.%I', guarded.table_name), 'INSERT'
    ) or has_table_privilege(
      'authenticated', pg_catalog.format('public.%I', guarded.table_name), 'UPDATE'
    ) or has_table_privilege(
      'authenticated', pg_catalog.format('public.%I', guarded.table_name), 'DELETE'
    )
  ),
  'authenticated no conserva DML directo sobre ninguna tabla del control plane'
);

insert into public.profiles (id, display_name, role, active) values
  ('c3000000-0000-0000-0000-000000000101', 'Owner Plataforma 083', null, true),
  ('c3000000-0000-0000-0000-000000000102', 'Admin Plataforma 083', null, true),
  ('c3000000-0000-0000-0000-000000000103', 'Viewer Plataforma 083', null, true),
  ('c3000000-0000-0000-0000-000000000104', 'Lector Tenant 083', null, true),
  ('c3000000-0000-0000-0000-000000000105', 'Objetivo Tenant A 083', null, true),
  ('c3000000-0000-0000-0000-000000000106', 'Objetivo Tenant B 083', null, true),
  ('c3000000-0000-0000-0000-000000000107', 'Sin Permiso Tenant 083', null, true);
insert into public.platform_memberships (user_id, role, active) values
  ('c3000000-0000-0000-0000-000000000101', 'OWNER', true),
  ('c3000000-0000-0000-0000-000000000102', 'ADMIN', true),
  ('c3000000-0000-0000-0000-000000000103', 'VIEWER', true);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values
  ('c3000000-0000-0000-0000-000000000001',
   'Tenant A 083', 'Tenant A 083 SpA', 'tenant-a-083', true, 'ONBOARDING', false),
  ('c3000000-0000-0000-0000-000000000002',
   'Tenant B 083', 'Tenant B 083 SpA', 'tenant-b-083', true, 'ONBOARDING', false),
  ('c3000000-0000-0000-0000-000000000003',
   'Tenant Suspendido 083', 'Tenant Suspendido 083 SpA',
   'tenant-suspendido-083', false, 'SUSPENDED', false);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('c3000000-0000-0000-0000-000000000201',
   'c3000000-0000-0000-0000-000000000104',
   'c3000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('c3000000-0000-0000-0000-000000000202',
   'c3000000-0000-0000-0000-000000000105',
   'c3000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('c3000000-0000-0000-0000-000000000203',
   'c3000000-0000-0000-0000-000000000106',
   'c3000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true),
  ('c3000000-0000-0000-0000-000000000204',
   'c3000000-0000-0000-0000-000000000107',
   'c3000000-0000-0000-0000-000000000001', null, true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr
  on cr.company_id = cm.company_id
 and cr.code = case cm.id
   when 'c3000000-0000-0000-0000-000000000201'::uuid then 'HR_ADMIN'
   when 'c3000000-0000-0000-0000-000000000202'::uuid then 'PRODUCTION_SUPERVISOR'
   when 'c3000000-0000-0000-0000-000000000203'::uuid then 'PRODUCTION_SUPERVISOR'
 end
where cm.id in (
  'c3000000-0000-0000-0000-000000000201',
  'c3000000-0000-0000-0000-000000000202',
  'c3000000-0000-0000-0000-000000000203'
);

insert into public.company_roles (
  id, company_id, code, name, base_role, is_system, active
) values (
  'c3000000-0000-0000-0000-000000000301',
  'c3000000-0000-0000-0000-000000000001',
  'NO_DIRECTORY_083', 'Sin directorio 083', null, false, true
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
values (
  'c3000000-0000-0000-0000-000000000001',
  'c3000000-0000-0000-0000-000000000204',
  'c3000000-0000-0000-0000-000000000301'
);

-- Directorio mínimo: propio, co-tenant autorizado y nunca otro tenant.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000104';
select ok(public.can_read_profile('c3000000-0000-0000-0000-000000000104'),
  'una cuenta siempre puede leer su propio perfil');
select ok(public.can_read_profile('c3000000-0000-0000-0000-000000000105'),
  'company.members.read permite ver un perfil del mismo tenant');
select is(
  (select count(*)::integer from public.profiles
   where id = 'c3000000-0000-0000-0000-000000000106'),
  0,
  'RLS oculta perfiles que pertenecen únicamente a otro tenant'
);
select ok(not public.can_read_profile('c3000000-0000-0000-0000-000000000106'),
  'el helper también niega explícitamente el perfil cross-tenant');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000107';
select ok(not public.can_read_profile('c3000000-0000-0000-0000-000000000105'),
  'compartir empresa sin company.members.read no abre el directorio');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::integer from public.profiles
   where id in (
     'c3000000-0000-0000-0000-000000000104',
     'c3000000-0000-0000-0000-000000000105',
     'c3000000-0000-0000-0000-000000000106'
   )),
  3,
  'un rol activo del control plane conserva el directorio global'
);
reset role;

-- Solo OWNER en AAL2 modifica la identidad global directamente.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select lives_ok(
  $$update public.profiles set display_name = 'Cambio Admin Rechazado 083'
    where id = 'c3000000-0000-0000-0000-000000000105'$$,
  'un ADMIN de plataforma recibe cero filas, no una excepción engañosa'
);
reset role;
set local request.jwt.claims = '';
select is(
  (select display_name from public.profiles
   where id = 'c3000000-0000-0000-0000-000000000105'),
  'Objetivo Tenant A 083',
  'ADMIN no modifica la identidad global'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000101';
set local request.jwt.claim.aal = 'aal1';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000101","aal":"aal1"}';
select lives_ok(
  $$update public.profiles set display_name = 'Cambio Owner AAL1 Rechazado 083'
    where id = 'c3000000-0000-0000-0000-000000000105'$$,
  'OWNER en AAL1 queda fuera de la policy sin una excepción engañosa'
);
reset role;
set local request.jwt.claims = '';
select is(
  (select display_name from public.profiles
   where id = 'c3000000-0000-0000-0000-000000000105'),
  'Objetivo Tenant A 083',
  'OWNER sin segundo factor no modifica la identidad global'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000101","aal":"aal2"}';
select lives_ok(
  $$update public.profiles set display_name = 'Cambio Owner Permitido 083'
    where id = 'c3000000-0000-0000-0000-000000000105'$$,
  'OWNER en AAL2 puede modificar la identidad global'
);
reset role;
set local request.jwt.claims = '';
select is(
  (select display_name from public.profiles
   where id = 'c3000000-0000-0000-0000-000000000105'),
  'Cambio Owner Permitido 083',
  'el cambio autorizado por OWNER persiste'
);

-- Incluso un manager válido en AAL2 carece de privilegio SQL directo: las
-- mutaciones del control plane deben pasar por RPC SECURITY DEFINER.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select throws_ok(
  $$update public.company_modules set status = 'ENABLED'
    where company_id = 'c3000000-0000-0000-0000-000000000001'
      and module_key = 'expenses'$$,
  '42501', null,
  'ADMIN en AAL2 tampoco puede saltarse los RPC con DML directo'
);
reset role;
set local request.jwt.claims = '';
select is(
  (select status::text from public.company_modules
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and module_key = 'expenses'),
  'DISABLED',
  'el DML directo denegado no altera el entitlement'
);

-- El RPC solo cambia módulos cuyo catálogo declara aislamiento tenant. Un
-- no-op legacy se tolera por idempotencia pero no fabrica auditoría.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select throws_ok(
  $$select public.platform_set_company_module_status(
    'c3000000-0000-0000-0000-000000000001', 'payroll', 'PILOT')$$,
  '23514',
  'Este módulo sigue ligado al workspace laboral y no puede cambiarse hasta completar su aislamiento multiempresa.',
  'un tenant nuevo no puede activar un módulo legacy'
);
select lives_ok(
  $$select public.platform_set_company_module_status(
    'c3000000-0000-0000-0000-000000000001', 'payroll', 'DISABLED')$$,
  'repetir el estado de un módulo legacy es un no-op idempotente'
);
reset role;
set local request.jwt.claims = '';
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and action = 'company.module.status_changed'
     and target_id = 'payroll'),
  0,
  'el no-op legacy no genera auditoría ficticia'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_company_module_status(
    'c3000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'un módulo tenant-isolated sí cambia mediante RPC'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select cm.status = 'PILOT'
          and pal.metadata ->> 'tenant_isolated' = 'true'
   from public.company_modules cm
   join public.platform_audit_log pal
     on pal.company_id = cm.company_id
    and pal.action = 'company.module.status_changed'
    and pal.target_id = cm.module_key
   where cm.company_id = 'c3000000-0000-0000-0000-000000000001'
     and cm.module_key = 'expenses'),
  'el cambio aislado persiste y la auditoría registra la capacidad usada'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select throws_ok(
  $$select public.platform_set_company_module_status(
    'c3000000-0000-0000-0000-000000000003', 'expenses', 'PILOT')$$,
  '23503', 'Módulo o empresa inexistente o inactiva.',
  'una empresa inactiva no admite cambios aunque el módulo esté aislado'
);
reset role;
set local request.jwt.claims = '';

-- El RPC de rol principal limpia la compatibilidad legacy en RBAC puro.
set local request.jwt.claim.aal = 'aal2';
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
select lives_ok(
  format(
    $$select public.platform_assign_company_role(
      'c3000000-0000-0000-0000-000000000202', %L)$$,
    (select id from public.company_roles
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and code = 'AUDITOR')
  ),
  'ADMIN asigna un rol puramente RBAC en un workspace bloqueado'
);
reset role;
select is(
  (select role from public.company_memberships
   where id = 'c3000000-0000-0000-0000-000000000202'),
  null,
  'el RPC limpia el rol legacy al asignar un rol RBAC puro'
);
select is(
  (select array_agg(cr.code order by cr.code)
   from public.company_membership_roles cmr
   join public.company_roles cr
     on cr.company_id = cmr.company_id and cr.id = cmr.role_id
   where cmr.membership_id = 'c3000000-0000-0000-0000-000000000202'),
  array['AUDITOR']::text[],
  'la asignación converge a exactamente un rol principal'
);
select is(
  (select role from public.profiles
   where id = 'c3000000-0000-0000-0000-000000000105'),
  null,
  'un workspace bloqueado nunca escribe profiles.role'
);
select ok(
  exists (
    select 1 from public.platform_audit_log
    where action = 'company.membership_role.assigned'
      and target_id = 'c3000000-0000-0000-0000-000000000202'
      and metadata ->> 'membership_legacy_role_cleared' = 'true'
  ),
  'la auditoría declara que la compatibilidad legacy fue limpiada'
);

-- Guardas de creación de invitaciones.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
select lives_ok(
  format(
    $$select public.platform_create_company_invitation(
      'c3000000-0000-0000-0000-000000000001',
      'nuevo-auditor-083@example.test', %L)$$,
    (select id from public.company_roles
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and code = 'AUDITOR')
  ),
  'un tenant no laboral admite invitaciones con rol RBAC puro'
);
reset role;
select is(
  (select count(*)::integer from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'nuevo-auditor-083@example.test' and status = 'PENDING'),
  1,
  'la invitación RBAC pura queda pendiente'
);

insert into auth.users (id, email)
values ('c3000000-0000-0000-0000-000000000108', 'existente-083@example.test');
insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  'c3000000-0000-0000-0000-000000000208',
  'c3000000-0000-0000-0000-000000000108',
  'c3000000-0000-0000-0000-000000000001',
  'SUPERVISOR_PRODUCTION', true
);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select 'c3000000-0000-0000-0000-000000000001',
       'c3000000-0000-0000-0000-000000000208', cr.id
from public.company_roles cr
where cr.company_id = 'c3000000-0000-0000-0000-000000000001'
  and cr.code = 'PRODUCTION_SUPERVISOR';

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
select throws_ok(
  format(
    $$select public.platform_create_company_invitation(
      'c3000000-0000-0000-0000-000000000001',
      'existente-083@example.test', %L)$$,
    (select id from public.company_roles
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and code = 'AUDITOR')
  ),
  'P0004', 'La persona ya es miembro activo de esta empresa.',
  'no se puede usar una invitación para cambiar a un miembro activo'
);
reset role;
select is(
  (select count(*)::integer from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'existente-083@example.test'),
  0,
  'el rechazo de miembro activo no deja una invitación parcial'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
select throws_ok(
  format(
    $$select public.platform_create_company_invitation(
      '0a4c0000-0000-0000-0000-000000000001',
      'auditor-arcotex-083@example.test', %L)$$,
    (select id from public.company_roles
     where company_id = '0a4c0000-0000-0000-0000-000000000001'
       and code = 'AUDITOR')
  ),
  '23514', 'El workspace habilitado exige un rol con compatibilidad legacy.',
  'ARCOTEX rechaza una invitación sin equivalencia legacy'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
select throws_ok(
  format(
    $$select public.platform_create_company_invitation(
      'c3000000-0000-0000-0000-000000000003',
      'suspendido-083@example.test', %L)$$,
    (select id from public.company_roles
     where company_id = 'c3000000-0000-0000-0000-000000000003'
       and code = 'HR_ADMIN')
  ),
  '23503', 'Empresa inexistente o inactiva.',
  'una empresa suspendida no admite invitaciones'
);
reset role;

-- go_live no puede saltarse el checklist previo.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000001', 'go_live', true)$$,
  '23514', 'Completa los pasos anteriores antes de activar la empresa.',
  'go_live exige todos los pasos activos anteriores completos'
);
reset role;
select is(
  (select status::text from public.company_onboarding_steps
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and step_key = 'go_live'),
  'NOT_STARTED',
  'el rechazo por checklist no deja go_live parcialmente completo'
);

update public.company_onboarding_steps
set status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp(),
    completed_by = 'c3000000-0000-0000-0000-000000000102'
where company_id = 'c3000000-0000-0000-0000-000000000001'
  and step_key <> 'go_live';

-- go_live usa Rendiciones ya activado por el RPC y no abre el workspace laboral.

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000001', 'go_live', true)$$,
  'Rendiciones en PILOT permite completar go_live'
);
reset role;
select is(
  (select status::text from public.company_onboarding_steps
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and step_key = 'go_live'),
  'COMPLETE',
  'go_live queda completo'
);
select ok(
  (select status = 'ACTIVE' and not workspace_enabled and onboarded_at is not null
   from public.companies
   where id = 'c3000000-0000-0000-0000-000000000001'),
  'la empresa queda activa sin abrir el workspace laboral'
);
select ok(
  exists (
    select 1 from public.platform_audit_log
    where company_id = 'c3000000-0000-0000-0000-000000000001'
      and action = 'company.onboarding_step.status_changed'
      and target_id = 'go_live'
      and metadata ->> 'workspace_enabled' = 'false'
      and metadata ->> 'independent_module_enabled' = 'true'
  ),
  'la auditoría distingue el go_live modular del workspace laboral'
);

-- Un checklist cerrado no admite reabrir pasos internos antes de reabrir
-- go_live, y al reabrirlo el tenant modular vuelve coherentemente a onboarding.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000001', 'company_profile', false)$$,
  '23514', 'Reabre go_live antes de reabrir un paso anterior.',
  'un paso previo no se reabre mientras go_live siga completo'
);
reset role;
select is(
  (select status::text from public.company_onboarding_steps
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and step_key = 'company_profile'),
  'COMPLETE',
  'el intento incoherente conserva completo el paso previo'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000001', 'go_live', false)$$,
  'un tenant modular puede reabrir go_live'
);
reset role;
select ok(
  (select c.status = 'ONBOARDING' and not c.workspace_enabled
          and os.status = 'NOT_STARTED'
   from public.companies c
   join public.company_onboarding_steps os
     on os.company_id = c.id and os.step_key = 'go_live'
   where c.id = 'c3000000-0000-0000-0000-000000000001'),
  'reabrir go_live revierte empresa y paso al estado de onboarding'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000001', 'company_profile', false)$$,
  'después de reabrir go_live sí se puede reabrir un paso previo'
);
reset role;
select is(
  (select status::text from public.company_onboarding_steps
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and step_key = 'company_profile'),
  'NOT_STARTED',
  'la reapertura coherente limpia el paso previo'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
    '0a4c0000-0000-0000-0000-000000000001', 'go_live', false)$$,
  '23514', 'No se puede reabrir go_live mientras el workspace laboral está operativo.',
  'un workspace laboral operativo no puede reabrir go_live'
);
reset role;

-- Completar el checklist de B y habilitar un módulo no aislado demuestra que
-- el gate se deriva del catálogo y no del nombre/status de cualquier módulo.
update public.company_onboarding_steps
set status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp(),
    completed_by = 'c3000000-0000-0000-0000-000000000102'
where company_id = 'c3000000-0000-0000-0000-000000000002'
  and step_key <> 'go_live';
update public.company_modules
set status = 'PILOT', enabled_at = pg_catalog.clock_timestamp(),
    enabled_by = 'c3000000-0000-0000-0000-000000000102'
where company_id = 'c3000000-0000-0000-0000-000000000002'
  and module_key = 'payroll';
select ok(
  (select not tenant_isolated from public.module_catalog where key = 'payroll'),
  'el fixture negativo usa un módulo activo que el catálogo no declara aislado'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
    'c3000000-0000-0000-0000-000000000002', 'go_live', true)$$,
  '23514', 'Activa al menos un módulo multiempresa antes de completar go_live.',
  'un módulo PILOT no aislado no satisface go_live'
);
reset role;
select ok(
  (select c.status = 'ONBOARDING' and not c.workspace_enabled
          and os.status = 'NOT_STARTED'
   from public.companies c
   join public.company_onboarding_steps os
     on os.company_id = c.id and os.step_key = 'go_live'
   where c.id = 'c3000000-0000-0000-0000-000000000002'),
  'el rechazo conserva empresa y checklist sin cambios parciales'
);

-- El estado de entrega de invitaciones también es una mutación privilegiada.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal1';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal1"}';
select throws_ok(
  format(
    $$select public.platform_mark_company_invitation_delivery(%L, 'SENT', null)$$,
    (select id from public.company_invitations
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and email = 'nuevo-auditor-083@example.test' and status = 'PENDING')
  ),
  'P0001', 'Esta operación requiere verificación de segundo factor (MFA).',
  'ADMIN en AAL1 no puede marcar una entrega de invitación'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select delivery_status = 'PENDING' and delivery_attempts = 0
   from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'nuevo-auditor-083@example.test' and status = 'PENDING'),
  'el rechazo MFA no altera el estado ni los intentos de entrega'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select lives_ok(
  format(
    $$select public.platform_mark_company_invitation_delivery(%L, 'SENT', null)$$,
    (select id from public.company_invitations
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and email = 'nuevo-auditor-083@example.test' and status = 'PENDING')
  ),
  'ADMIN en AAL2 puede registrar la entrega mediante RPC'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select delivery_status = 'SENT' and delivery_attempts = 1
          and last_delivery_at is not null
   from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'nuevo-auditor-083@example.test' and status = 'PENDING')
  and exists (
    select 1 from public.platform_audit_log
    where action = 'company.invitation.delivery_attempted'
      and company_id = 'c3000000-0000-0000-0000-000000000001'
      and metadata ->> 'delivery_status' = 'SENT'
  ),
  'la entrega AAL2 persiste una vez y deja auditoría'
);

-- Revocar es el único modo de corregir una invitación pendiente: reenviar no
-- cambia su rol. El RPC aplica el mismo gate MFA y libera el índice parcial.
set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal1';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal1"}';
select throws_ok(
  format(
    $$select public.platform_revoke_company_invitation(%L)$$,
    (select id from public.company_invitations
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and email = 'nuevo-auditor-083@example.test' and status = 'PENDING')
  ),
  'P0001', 'Esta operación requiere verificación de segundo factor (MFA).',
  'ADMIN en AAL1 no puede revocar una invitación pendiente'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'PENDING' and delivery_status = 'SENT'
   from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'nuevo-auditor-083@example.test'),
  'el rechazo MFA conserva intacta la invitación entregada'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select lives_ok(
  format(
    $$select public.platform_revoke_company_invitation(%L)$$,
    (select id from public.company_invitations
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and email = 'nuevo-auditor-083@example.test' and status = 'PENDING')
  ),
  'ADMIN en AAL2 puede revocar la invitación'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'REVOKED'
   from public.company_invitations
   where company_id = 'c3000000-0000-0000-0000-000000000001'
     and email = 'nuevo-auditor-083@example.test')
  and exists (
    select 1 from public.platform_audit_log
    where company_id = 'c3000000-0000-0000-0000-000000000001'
      and action = 'company.invitation.revoked'
  ),
  'la revocación cambia el estado y deja auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = 'c3000000-0000-0000-0000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000102","aal":"aal2"}';
select lives_ok(
  format(
    $$select public.platform_create_company_invitation(
      'c3000000-0000-0000-0000-000000000001',
      'nuevo-auditor-083@example.test', %L)$$,
    (select id from public.company_roles
     where company_id = 'c3000000-0000-0000-0000-000000000001'
       and code = 'HR_ADMIN')
  ),
  'tras revocar se puede invitar de nuevo con el rol corregido'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select count(*) filter (where ci.status = 'REVOKED') = 1
          and count(*) filter (
            where ci.status = 'PENDING' and cr.code = 'HR_ADMIN'
          ) = 1
   from public.company_invitations ci
   join public.company_roles cr
     on cr.company_id = ci.company_id and cr.id = ci.role_id
   where ci.company_id = 'c3000000-0000-0000-0000-000000000001'
     and ci.email = 'nuevo-auditor-083@example.test'),
  'queda historial revocado y una sola invitación pendiente con el rol nuevo'
);

select * from finish();
rollback;
