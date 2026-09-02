-- pgTAP GESTORA MT-3B (recorte 1): capa de autorización consciente de
-- empresa para employees/employee_groups y sus tablas de asignación.
create extension if not exists pgtap;

begin;
select plan(20);

select has_function('public', 'employee_belongs_to_active_company', array['uuid'], 'existe el helper de aislamiento por empresa');
select has_trigger('public', 'profiles', 'profiles_sync_arcotex_membership', 'existe el trigger de sincronización de membresía ARCOTEX');

-- --- Fixture: una segunda empresa, ajena a ARCOTEX -------------------------
insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values ('aa000000-0000-0000-0000-000000000001', 'MT-3B Ajena', 'MT-3B Ajena SpA', 'mt3b-ajena', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('aa000000-0000-0000-0000-000000000101', 'Admin ARCOTEX MT3B', 'ADMIN_RRHH', true),
  ('aa000000-0000-0000-0000-000000000102', 'Admin Ajena MT3B', 'ADMIN_RRHH', true);

-- 102 se registra explícitamente en la empresa ajena -- todavía no existe
-- una vía de la aplicación para esto (el modelo objetivo es
-- company_role_permissions, no profiles.role, que es compatibilidad
-- exclusiva de ARCOTEX); se inserta directo para simular ese estado futuro.
insert into public.company_memberships (user_id, company_id, role, active)
values ('aa000000-0000-0000-0000-000000000102', 'aa000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true);

-- --- 1) El trigger mantiene company_memberships sincronizado con profiles --
select ok(
  exists (
    select 1 from public.company_memberships
    where user_id = 'aa000000-0000-0000-0000-000000000101'
      and company_id = (select id from public.companies where slug = 'arcotex')
      and role = 'ADMIN_RRHH' and active
  ),
  'insertar un profile con rol sincroniza automáticamente su membresía ARCOTEX'
);

update public.profiles set role = 'SUPERVISOR_INSTALLATION' where id = 'aa000000-0000-0000-0000-000000000101';
select ok(
  exists (
    select 1 from public.company_memberships
    where user_id = 'aa000000-0000-0000-0000-000000000101'
      and company_id = (select id from public.companies where slug = 'arcotex')
      and role = 'SUPERVISOR_INSTALLATION' and active
  ),
  'cambiar el rol actualiza la membresía ARCOTEX existente, no crea una fila nueva'
);

update public.profiles set role = null where id = 'aa000000-0000-0000-0000-000000000101';
select ok(
  not exists (
    select 1 from public.company_memberships
    where user_id = 'aa000000-0000-0000-0000-000000000101'
      and company_id = (select id from public.companies where slug = 'arcotex')
      and active
  ),
  'quitar el rol desactiva la membresía ARCOTEX -- nunca la deja huérfana activa'
);

-- Deja 101 de nuevo como ADMIN_RRHH activo para el resto de las pruebas.
update public.profiles set role = 'ADMIN_RRHH' where id = 'aa000000-0000-0000-0000-000000000101';

-- --- Empleados de cada empresa ----------------------------------------------
insert into public.employees (id, external_workera_id, first_name, last_name, display_name)
values ('aa000000-0000-0000-0000-000000000201', 'MT3B-ARCOTEX-001', 'Empleado', 'Arcotex', 'Empleado Arcotex');
select is(
  (select company_id::text from public.employees where id = 'aa000000-0000-0000-0000-000000000201'),
  '0a4c0000-0000-0000-0000-000000000001',
  'un empleado nuevo sin company_id explícito sigue asignándose a ARCOTEX por defecto'
);

insert into public.employees (id, company_id, external_workera_id, first_name, last_name, display_name)
values ('aa000000-0000-0000-0000-000000000202', 'aa000000-0000-0000-0000-000000000001', 'MT3B-AJENA-001', 'Empleado', 'Ajena', 'Empleado Ajena');

-- --- 2) employees_select: aislamiento real por empresa ----------------------
set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select is(
  (select count(*)::integer from public.employees where id = 'aa000000-0000-0000-0000-000000000201'),
  1, 'el admin ARCOTEX sigue viendo empleados de su propia empresa (regresión)'
);
select is(
  (select count(*)::integer from public.employees where id = 'aa000000-0000-0000-0000-000000000202'),
  0, 'el admin ARCOTEX ya no ve un empleado de una empresa ajena'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000102';
select is(
  (select count(*)::integer from public.employees where id = 'aa000000-0000-0000-0000-000000000202'),
  1, 'el admin de la empresa ajena ve su propio empleado'
);
select is(
  (select count(*)::integer from public.employees where id = 'aa000000-0000-0000-0000-000000000201'),
  0, 'el admin de la empresa ajena no ve el empleado de ARCOTEX'
);
reset role;

-- --- 3) employees_write_admin: mismo aislamiento en escritura ---------------
set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select lives_ok(
  $$update public.employees set display_name = 'Empleado Arcotex (editado)' where id = 'aa000000-0000-0000-0000-000000000201'$$,
  'el admin ARCOTEX sigue pudiendo editar su propio empleado (regresión)'
);
select lives_ok(
  $$update public.employees set display_name = 'Hackeado' where id = 'aa000000-0000-0000-0000-000000000202'$$,
  'un UPDATE contra un empleado ajeno no lanza excepción -- RLS lo filtra en silencio'
);
reset role;
select is(
  (select display_name from public.employees where id = 'aa000000-0000-0000-0000-000000000202'),
  'Empleado Ajena', 'pero ese UPDATE no modificó nada -- la fila ajena quedó excluida'
);

-- --- 4) employee_groups_select: mismo aislamiento -------------------------
insert into public.employee_groups (id, company_id, code, name)
values ('aa000000-0000-0000-0000-000000000301', 'aa000000-0000-0000-0000-000000000001', 'MT3B_AJENA_GROUP', 'Grupo Ajeno MT3B');

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select is(
  (select count(*)::integer from public.employee_groups where id = 'aa000000-0000-0000-0000-000000000301'),
  0, 'el admin ARCOTEX no ve un employee_group de una empresa ajena'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000102';
select is(
  (select count(*)::integer from public.employee_groups where id = 'aa000000-0000-0000-0000-000000000301'),
  1, 'el admin de la empresa ajena ve su propio employee_group'
);
select is(
  (select count(*)::integer from public.employee_groups where code = 'PRODUCTION'),
  0, 'el admin de la empresa ajena no ve el catálogo de grupos de ARCOTEX'
);
reset role;

-- --- 5) can_manage_employee(): el gate de empresa aplica incluso al admin
--        privilegiado, no solo al criterio de grupo/supervisor -------------
set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select ok(
  public.can_manage_employee('aa000000-0000-0000-0000-000000000201'),
  'el admin ARCOTEX puede gestionar su propio empleado (regresión)'
);
select ok(
  not public.can_manage_employee('aa000000-0000-0000-0000-000000000202'),
  'un admin privilegiado de ARCOTEX ya no puede gestionar el empleado de una empresa ajena'
);
reset role;

-- --- 6) supervisor_assignments: mismo aislamiento vía employee_belongs_to_active_company
insert into public.supervisor_assignments (id, employee_id, supervisor_profile_id, effective_from)
values ('aa000000-0000-0000-0000-000000000401', 'aa000000-0000-0000-0000-000000000202', 'aa000000-0000-0000-0000-000000000102', current_date);

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select is(
  (select count(*)::integer from public.supervisor_assignments where id = 'aa000000-0000-0000-0000-000000000401'),
  0, 'el admin ARCOTEX no ve una asignación de supervisor de un empleado ajeno'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000102';
select is(
  (select count(*)::integer from public.supervisor_assignments where id = 'aa000000-0000-0000-0000-000000000401'),
  1, 'el admin de la empresa ajena ve su propia asignación de supervisor'
);
reset role;

select * from finish();
rollback;
