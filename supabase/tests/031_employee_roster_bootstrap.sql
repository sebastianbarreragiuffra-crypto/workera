-- pgTAP: bootstrap de roster administrativo (planilla de personal) +
-- función atómica apply_personnel_roster_import. Cubre: constraint de
-- `source`, inserción/actualización/desactivación atómica, RLS (solo
-- is_privileged_admin puede escribir employees -- un supervisor no puede
-- aplicar el roster ni con la función), nunca hace DELETE.
create extension if not exists pgtap;

begin;
select plan(11);

-- ---------------------------------------------------------------------------
-- Fixtures
insert into public.profiles (id, display_name, role) values
  ('99200000-0000-0000-0000-000000000001', 'Fixture RRHH Roster', 'ADMIN_RRHH'),
  ('99200000-0000-0000-0000-000000000002', 'Fixture Supervisor Roster', 'SUPERVISOR_PRODUCTION');

-- 1) constraint de source
select throws_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, source)
     values ('TEST-SRC-BAD', 'X', 'Y', 'X Y', 'algo_invalido') $$,
  '23514',
  null,
  'source fuera del catálogo (workera/excel_roster) es rechazado'
);

select lives_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, source, rut)
     values ('EXCEL-11111111-1', 'JUAN', 'PEREZ', 'JUAN PEREZ', 'excel_roster', '11111111-1') $$,
  'source=excel_roster con RUT normalizado se acepta'
);

-- ---------------------------------------------------------------------------
-- 2) apply_personnel_roster_import -- solo is_privileged_admin (RLS de employees, no la función en sí)
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000002'; -- supervisor

select throws_ok(
  $$ select public.apply_personnel_roster_import(
       '[{"rut":"22222222-2","first_name":"ANA","last_name":"SOTO","display_name":"ANA SOTO","employee_group_id":"","hire_date":""}]'::jsonb,
       '[]'::jsonb, '[]'::jsonb, '99200000-0000-0000-0000-000000000002'::uuid
     ) $$,
  '42501',
  null,
  'un supervisor no puede aplicar el roster (RLS de employees_write_admin lo bloquea dentro de la función)'
);

select is(
  (select count(*)::int from public.employees where external_workera_id = 'EXCEL-22222222-2'),
  0,
  'el intento del supervisor nunca insertó nada'
);

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000001'; -- RRHH

select lives_ok(
  $$ select public.apply_personnel_roster_import(
       '[{"rut":"22222222-2","first_name":"ANA","last_name":"SOTO","display_name":"ANA SOTO","employee_group_id":"","hire_date":"","birth_month":"5","birth_day":"20"}]'::jsonb,
       '[]'::jsonb, '[]'::jsonb, '99200000-0000-0000-0000-000000000001'::uuid
     ) $$,
  'RRHH puede aplicar el roster -- inserta un empleado nuevo'
);

reset role;

select is(
  (select source::text from public.employees where external_workera_id = 'EXCEL-22222222-2'),
  'excel_roster',
  'el empleado nuevo queda con source=excel_roster'
);

select is(
  (select birth_month::int from public.employee_birthdays eb join public.employees e on e.id = eb.employee_id where e.external_workera_id = 'EXCEL-22222222-2'),
  5,
  'la fecha de nacimiento se reconcilia en employee_birthdays (arquitectura existente, reutilizada)'
);

-- ---------------------------------------------------------------------------
-- 3) update + reactivación + desactivación en la misma llamada atómica
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000001';

select lives_ok(
  format(
    $$ select public.apply_personnel_roster_import(
         '[]'::jsonb,
         '[{"id":"%s","employee_group_id":"","hire_date":"2020-01-01"}]'::jsonb,
         '["%s"]'::jsonb,
         '99200000-0000-0000-0000-000000000001'::uuid
       ) $$,
    (select id from public.employees where external_workera_id = 'EXCEL-22222222-2'),
    (select id from public.employees where external_workera_id = 'EXCEL-11111111-1')
  ),
  'update + desactivación en la misma llamada atómica funciona'
);

reset role;

select is(
  (select hire_date::text from public.employees where external_workera_id = 'EXCEL-22222222-2'),
  '2020-01-01',
  'el update aplicó hire_date correctamente'
);

select is(
  (select active from public.employees where external_workera_id = 'EXCEL-11111111-1'),
  false,
  'el empleado en p_deactivate_ids queda desactivado (nunca DELETE -- la fila sigue existiendo)'
);

select is(
  (select count(*)::int from public.employees where external_workera_id = 'EXCEL-11111111-1'),
  1,
  'la fila desactivada NUNCA se borra -- sigue existiendo, solo active=false'
);

select * from finish();
rollback;
