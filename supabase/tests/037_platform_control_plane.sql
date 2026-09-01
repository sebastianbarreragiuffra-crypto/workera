-- pgTAP GESTORA MT-3A: separación plataforma/empresa, módulos por cliente,
-- RBAC, onboarding y organigrama con integridad tenant.
create extension if not exists pgtap;

begin;
select plan(37);

select has_table('public', 'platform_memberships', 'existe administración de plataforma separada');
select has_table('public', 'company_roles', 'existen roles configurables por empresa');
select has_table('public', 'company_modules', 'existen módulos/entitlements por empresa');
select has_table('public', 'organization_units', 'existe árbol organizacional tenant-aware');
select has_table('public', 'employee_org_assignments', 'existen asignaciones organizacionales con vigencia');
select has_column('public', 'employees', 'company_id', 'employees ya declara su empresa raíz');
select has_column('public', 'employee_groups', 'company_id', 'employee_groups ya declara su empresa raíz');
select col_type_is('public', 'companies', 'status', 'public.company_lifecycle_status', 'companies usa un ciclo de vida explícito');

select ok(
  (select workspace_enabled and status = 'ACTIVE' from public.companies where slug = 'arcotex'),
  'ARCOTEX conserva su workspace actual habilitado'
);

insert into public.companies (
  id, name, legal_name, slug, active, status, created_by
) values (
  '91000000-0000-0000-0000-000000000001',
  'Cliente Demo',
  'Cliente Demo SpA',
  'cliente-demo',
  true,
  'ONBOARDING',
  null
);

select ok(
  (select status = 'ONBOARDING' and not workspace_enabled from public.companies where slug = 'cliente-demo'),
  'una empresa nueva nace en onboarding y sin workspace operacional'
);
select is(
  (select count(*)::int from public.company_modules where company_id = '91000000-0000-0000-0000-000000000001'),
  (select count(*)::int from public.module_catalog where active),
  'el trigger provisiona todo el catálogo de módulos'
);
select is(
  (select count(*)::int from public.company_roles where company_id = '91000000-0000-0000-0000-000000000001'),
  5,
  'el trigger provisiona los cinco roles empresariales iniciales'
);
select ok(
  exists (
    select 1 from public.organization_units
    where company_id = '91000000-0000-0000-0000-000000000001'
      and code = 'ROOT' and unit_type = 'COMPANY'
  ),
  'el trigger crea la raíz del organigrama'
);

insert into public.profiles (id, display_name, role, active) values
  ('91000000-0000-0000-0000-000000000101', 'Gestora Owner Fixture', null, true),
  ('91000000-0000-0000-0000-000000000102', 'Cliente RRHH Fixture', null, true),
  ('91000000-0000-0000-0000-000000000103', 'Cliente Outsider Fixture', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('91000000-0000-0000-0000-000000000101', 'OWNER', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('91000000-0000-0000-0000-000000000201', '91000000-0000-0000-0000-000000000102', '91000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('91000000-0000-0000-0000-000000000202', '91000000-0000-0000-0000-000000000103', '0a4c0000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where cm.id = '91000000-0000-0000-0000-000000000201'
  and cr.code = 'HR_ADMIN';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000101';
select ok(public.is_platform_admin(), 'la membresía de plataforma autoriza el control plane sin profiles.role');
select is((select count(*)::int from public.companies), 2, 'el owner de plataforma ve toda la cartera');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.companies), 1, 'un miembro cliente ve solo su empresa');
select is((select count(*)::int from public.companies where slug = 'arcotex'), 0, 'un miembro cliente no descubre ARCOTEX');
reset role;

update public.companies
set active = false, status = 'SUSPENDED'
where id = '91000000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.companies), 0, 'empresa desactivada revoca descubrimiento inmediatamente');
reset role;
update public.companies
set active = true, status = 'ONBOARDING'
where id = '91000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000102';
select ok(public.has_company_permission('91000000-0000-0000-0000-000000000001', 'employees.read'), 'RRHH recibe permisos de personas mediante RBAC tenant');
select ok(not public.has_company_permission('91000000-0000-0000-0000-000000000001', 'modules.manage'), 'RRHH no hereda gestión comercial de módulos');
reset role;

update public.company_modules
set status = 'PILOT', enabled_at = now()
where company_id = '91000000-0000-0000-0000-000000000001' and module_key = 'expenses';

select is(
  (select status::text from public.company_modules where company_id = '0a4c0000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  'DISABLED',
  'el estado de un módulo es independiente entre empresas'
);
select ok(
  public.company_has_module('91000000-0000-0000-0000-000000000001', 'expenses'),
  'PILOT cuenta como entitlement habilitado para el cliente correcto'
);

select throws_ok(
  format(
    $$insert into public.organization_units (company_id, parent_id, code, name, unit_type)
      values ('0a4c0000-0000-0000-0000-000000000001', %L, 'CROSS_PARENT', 'Cruce', 'AREA')$$,
    (select id from public.organization_units where company_id = '91000000-0000-0000-0000-000000000001' and code = 'ROOT')
  ),
  '23503',
  null,
  'una unidad no puede apuntar a un padre de otra empresa'
);

select throws_ok(
  $$insert into public.employee_groups (id, company_id, code, name, active)
    values (
      '91000000-0000-0000-0000-000000000301',
      '91000000-0000-0000-0000-000000000001',
      'DEMO',
      'Demo',
      true
    )$$,
  '23514',
  'El workspace de la empresa esta bloqueado para datos laborales.',
  'un tenant en onboarding no puede crear grupos laborales'
);

select throws_ok(
  $$insert into public.employees (
      id, company_id, external_workera_id, first_name, last_name, display_name, active
    ) values (
      '91000000-0000-0000-0000-000000000302',
      '91000000-0000-0000-0000-000000000001',
      'demo-employee-tenant',
      'Empleado',
      'Demo',
      'Empleado Demo',
      true
    )$$,
  '23514',
  'El workspace de la empresa esta bloqueado para datos laborales.',
  'un tenant en onboarding no puede crear personas laborales'
);

insert into public.organization_units (id, company_id, parent_id, code, name, unit_type) values
  ('91000000-0000-0000-0000-000000000401', '91000000-0000-0000-0000-000000000001', (select id from public.organization_units where company_id = '91000000-0000-0000-0000-000000000001' and code = 'ROOT'), 'LEVEL_A', 'Nivel A', 'DIVISION'),
  ('91000000-0000-0000-0000-000000000402', '91000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000401', 'LEVEL_B', 'Nivel B', 'TEAM');

select throws_ok(
  $$update public.organization_units
    set parent_id = '91000000-0000-0000-0000-000000000402'
    where id = '91000000-0000-0000-0000-000000000401'$$,
  '23514',
  null,
  'el organigrama rechaza ciclos'
);

select throws_ok(
  $$insert into public.company_invitations (company_id, email, role_id, invited_by)
    select '91000000-0000-0000-0000-000000000001', 'MAYUSCULA@EXAMPLE.COM', id, '91000000-0000-0000-0000-000000000101'
    from public.company_roles where company_id = '91000000-0000-0000-0000-000000000001' and code = 'HR_ADMIN'$$,
  '23514',
  null,
  'las invitaciones exigen email normalizado'
);

insert into public.company_invitations (company_id, email, role_id, invited_by)
select '91000000-0000-0000-0000-000000000001', 'persona@example.com', id, '91000000-0000-0000-0000-000000000101'
from public.company_roles where company_id = '91000000-0000-0000-0000-000000000001' and code = 'HR_ADMIN';

select throws_ok(
  $$insert into public.company_invitations (company_id, email, role_id, invited_by)
    select '91000000-0000-0000-0000-000000000001', 'persona@example.com', id, '91000000-0000-0000-0000-000000000101'
    from public.company_roles where company_id = '91000000-0000-0000-0000-000000000001' and code = 'COMPANY_OWNER'$$,
  '23505',
  null,
  'solo existe una invitación pendiente por email y empresa'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000102';
select throws_ok(
  $$update public.company_modules set status = 'DISABLED'
    where company_id = '91000000-0000-0000-0000-000000000001'
      and module_key = 'expenses'$$,
  '42501',
  null,
  'RRHH no recibe DML directo sobre entitlements'
);
reset role;
select is(
  (select status::text from public.company_modules where company_id = '91000000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  'PILOT',
  'RLS impide que RRHH cambie entitlements aunque conozca la clave'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status(
      '91000000-0000-0000-0000-000000000001', 'expenses', 'ENABLED'
    )$$,
  'el owner de plataforma gestiona el entitlement mediante RPC auditado'
);
reset role;
select is(
  (select status::text from public.company_modules where company_id = '91000000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  'ENABLED',
  'el owner de plataforma sí puede gestionar el entitlement'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select * from public.platform_company_portfolio()$$,
  '42501',
  null,
  'un administrador cliente no puede ejecutar la proyección global del portafolio'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000101';
select is((select count(*)::int from public.platform_company_portfolio()), 2, 'el portafolio agregado contiene exactamente los dos clientes');
select is((select count(*)::int from public.employees), 0, 'ser admin de plataforma no concede lectura automática de empleados');
reset role;

set local role anon;
select throws_ok($$select 1 from public.platform_memberships$$, '42501', null, 'anon no accede al control plane');
reset role;

update public.platform_memberships
set role = 'VIEWER'
where user_id <> '91000000-0000-0000-0000-000000000101' and role = 'OWNER';

select throws_ok(
  $$update public.platform_memberships set active = false where user_id = '91000000-0000-0000-0000-000000000101'$$,
  '23514',
  null,
  'no se puede remover al último OWNER activo de la plataforma'
);

select * from finish();
rollback;
