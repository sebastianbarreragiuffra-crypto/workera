-- pgTAP: soporte de datos de demostración (employees.source='demo' +
-- cleanup_demo_data()). Cubre: 'demo' es un source válido; cleanup_demo_data
-- es exclusivo de SUPER_ADMIN; cleanup borra SOLO empleados 'demo', nunca uno
-- real ('workera'/'excel_roster'), aunque ambos existan simultáneamente.
create extension if not exists pgtap;

begin;
select plan(7);

-- ---------------------------------------------------------------------------
-- Fixtures: un SUPER_ADMIN, un supervisor, un grupo, un empleado REAL y uno DEMO.
insert into public.profiles (id, display_name, role) values
  ('99300000-0000-0000-0000-000000000001', 'Fixture SUPER_ADMIN', 'SUPER_ADMIN'),
  ('99300000-0000-0000-0000-000000000002', 'Fixture Supervisor Producción', 'SUPERVISOR_PRODUCTION');

insert into public.employees (id, external_workera_id, first_name, last_name, display_name, source, active) values
  ('99300000-0000-0000-0000-000000000010', 'WORKERA-REAL-001', 'Real', 'Uno', 'REAL UNO', 'workera', true),
  ('99300000-0000-0000-0000-000000000011', 'DEMO-TEST-001', 'Demo', 'Uno', 'DEMO UNO', 'demo', true);

-- ---------------------------------------------------------------------------
-- 1) 'demo' es un valor válido para employees.source (la migración no rompió el CHECK existente).
select lives_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, source, active)
     values ('DEMO-TEST-002', 'Demo', 'Dos', 'DEMO DOS', 'demo', true) $$,
  'employees.source acepta ''demo'' tras la migración'
);

-- 2) Un valor fuera del catálogo sigue rechazado (el CHECK no quedó abierto de más).
select throws_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, source, active)
     values ('BOGUS-001', 'Bogus', 'Uno', 'BOGUS UNO', 'bogus_source', true) $$,
  '23514',
  null,
  'un source fuera de (workera, excel_roster, demo) sigue siendo rechazado'
);

-- ---------------------------------------------------------------------------
-- 3) Un supervisor NO puede ejecutar cleanup_demo_data().
set local role authenticated;
set local request.jwt.claim.sub = '99300000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select * from public.cleanup_demo_data() $$,
  'P0001',
  'Solo SUPER_ADMIN puede ejecutar la limpieza de datos de demostración.',
  'un supervisor no puede ejecutar cleanup_demo_data()'
);

reset role;

-- 4) El empleado real y el demo original siguen intactos tras el intento bloqueado.
select is(
  (select count(*)::int from public.employees where id in ('99300000-0000-0000-0000-000000000010', '99300000-0000-0000-0000-000000000011')),
  2,
  'el intento bloqueado no borró ni al empleado real ni al demo'
);

-- ---------------------------------------------------------------------------
-- 5) SUPER_ADMIN sí puede ejecutar cleanup_demo_data(), y borra el/los empleados demo.
set local role authenticated;
set local request.jwt.claim.sub = '99300000-0000-0000-0000-000000000001';

select lives_ok(
  $$ select * from public.cleanup_demo_data() $$,
  'SUPER_ADMIN puede ejecutar cleanup_demo_data()'
);

reset role;

select is(
  (select count(*)::int from public.employees where source = 'demo'),
  0,
  'cleanup_demo_data() borró TODOS los empleados demo (incluyendo el creado en el fixture del propio test)'
);

select is(
  (select source from public.employees where id = '99300000-0000-0000-0000-000000000010'),
  'workera',
  'el empleado REAL (source=workera) sigue existiendo intacto tras cleanup_demo_data()'
);

select * from finish();
rollback;
