-- pgTAP GESTORA MT-3A: organigrama agregado sin exposición laboral.
create extension if not exists pgtap;

begin;
select plan(13);

select has_function('public', 'platform_company_organization', array['uuid'],
  'existe la proyección agregada de organigrama');
select ok(
  has_function_privilege('authenticated', 'public.platform_company_organization(uuid)', 'EXECUTE'),
  'authenticated puede invocar la proyección, su autorización interna decide');
select ok(
  not has_function_privilege('anon', 'public.platform_company_organization(uuid)', 'EXECUTE'),
  'anon no recibe EXECUTE');

insert into public.profiles (id, display_name, role, active) values
  ('93000000-0000-0000-0000-000000000101', 'Platform Viewer Org', null, true),
  ('93000000-0000-0000-0000-000000000102', 'Client Org', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('93000000-0000-0000-0000-000000000101', 'VIEWER', true);

insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  '93000000-0000-0000-0000-000000000201',
  '93000000-0000-0000-0000-000000000102',
  '0a4c0000-0000-0000-0000-000000000001',
  'ADMIN_RRHH',
  true
)
on conflict (user_id, company_id) do nothing;

insert into public.company_membership_roles (company_id, membership_id, role_id)
select
  '0a4c0000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000201',
  cr.id
from public.company_roles cr
where cr.company_id = '0a4c0000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name, active
) values
  ('93000000-0000-0000-0000-000000000301', '0a4c0000-0000-0000-0000-000000000001', 'ORG-039-A', 'Persona', 'Activa', 'Persona Activa', true),
  ('93000000-0000-0000-0000-000000000302', '0a4c0000-0000-0000-0000-000000000001', 'ORG-039-I', 'Persona', 'Inactiva', 'Persona Inactiva', false);

insert into public.organization_units (
  id, company_id, parent_id, code, name, unit_type, sort_order
)
select
  '93000000-0000-0000-0000-000000000401',
  c.id,
  root.id,
  'AREA_TEST_039',
  'Área Test',
  'AREA',
  10
from public.companies c
join public.organization_units root on root.company_id = c.id and root.code = 'ROOT'
where c.id = '0a4c0000-0000-0000-0000-000000000001';

insert into public.employee_org_assignments (
  company_id, employee_id, org_unit_id, effective_from, is_primary
) values
  ('0a4c0000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000301', '93000000-0000-0000-0000-000000000401', current_date - 1, true),
  ('0a4c0000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000302', '93000000-0000-0000-0000-000000000401', current_date - 1, true);

insert into public.organization_unit_leads (
  company_id, org_unit_id, employee_id, effective_from
) values (
  '0a4c0000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000401',
  '93000000-0000-0000-0000-000000000301',
  current_date - 1
);

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-0000-0000-000000000101';

select lives_ok(
  $$select * from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001')$$,
  'un VIEWER de plataforma puede leer la proyección agregada');
select is(
  (select direct_member_count from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001') where unit_id = '93000000-0000-0000-0000-000000000401'),
  1::bigint,
  'solo cuenta trabajadores activos y vigentes');
select ok(
  (select has_leader from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001') where unit_id = '93000000-0000-0000-0000-000000000401'),
  'indica jefatura vigente sin revelar su identidad');
select ok(
  (select count(*) >= 2 from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001')),
  'la proyección devuelve la estructura ARCOTEX sin depender del número de asignaciones');
select is(
  (select count(*) from public.employee_org_assignments),
  0::bigint,
  'el administrador global no puede leer asignaciones laborales crudas');
select is(
  (select count(*) from public.organization_unit_leads),
  0::bigint,
  'el administrador global no puede leer jefaturas crudas');
select throws_ok(
  $$select * from public.platform_company_organization('93000000-0000-0000-0000-000000009999')$$,
  '23503',
  'Empresa inexistente.',
  'la proyección rechaza empresas inexistentes');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select * from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001')$$,
  '42501',
  'Acceso exclusivo del control plane.',
  'un administrador de cliente no obtiene la proyección global');

reset role;
set local role anon;
set local request.jwt.claim.sub = '';
select throws_ok(
  $$select * from public.platform_company_organization('0a4c0000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  'anon no puede ejecutar la función');

reset role;
select is(
  (select count(*) from public.employee_org_assignments where company_id = '0a4c0000-0000-0000-0000-000000000001'),
  2::bigint,
  'las filas laborales permanecen intactas');

select * from finish();
rollback;
