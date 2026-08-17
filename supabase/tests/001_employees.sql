-- pgTAP: employees
create extension if not exists pgtap;

begin;
select plan(5);

-- Fixture: usar el grupo PRODUCTION ya sembrado por 07_seeds.sql
select ok(
  (select count(*) from public.employee_groups where code = 'PRODUCTION') = 1,
  'seed: PRODUCTION existe'
);

-- 1) Insertar un empleado con external_workera_id único: debe funcionar
select lives_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name)
     values ('TEST-EMP-001', 'Fixture', 'Uno', 'Fixture Uno') $$,
  'insertar empleado con external_workera_id único funciona'
);

-- 2) external_workera_id duplicado: debe rechazarse (UNIQUE)
select throws_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name)
     values ('TEST-EMP-001', 'Otro', 'Duplicado', 'Otro Duplicado') $$,
  '23505',
  null,
  'external_workera_id duplicado es rechazado'
);

-- 3) employee_group_id nulo debe ser aceptado (sync sin clasificación todavía)
select lives_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
     values ('TEST-EMP-002', 'Sin', 'Grupo', 'Sin Grupo', null) $$,
  'empleado sin employee_group_id es aceptado (BLOCKING se resuelve en DailyReview, no aquí)'
);

-- 4) RUT con formato inválido debe rechazarse
select throws_ok(
  $$ insert into public.employees (external_workera_id, first_name, last_name, display_name, rut)
     values ('TEST-EMP-003', 'Rut', 'Invalido', 'Rut Invalido', '12.345.678-9') $$,
  '23514',
  null,
  'RUT con puntos (formato no normalizado) es rechazado'
);

select * from finish();
rollback;
