-- pgTAP Fase 3: novedades manuales (licencia/vacaciones) dentro del contexto
-- del supervisor + lectura amplia confirmada para los 3 roles corporativos
-- (secciones 3/4/11/30 del encargo)
create extension if not exists pgtap;

begin;
select plan(6);

insert into public.profiles (id, display_name, role) values
  ('35000000-0000-0000-0000-000000000001', 'Fixture Admin Manual', 'ADMIN_RRHH'),
  ('35000000-0000-0000-0000-000000000002', 'Fixture Supervisor Prod Manual', 'SUPERVISOR_PRODUCTION'),
  ('35000000-0000-0000-0000-000000000003', 'Fixture Supervisor Install Manual', 'SUPERVISOR_INSTALLATION');

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-MANUAL-PROD-001', 'Fixture', 'ManualProd', 'Fixture ManualProd',
  (select id from public.employee_groups where code = 'PRODUCTION')
);

-- 1) SUPERVISOR_PRODUCTION registra una licencia manual para un trabajador de
-- su propio grupo, con created_by forzado a sí mismo.
set local role authenticated;
set local request.jwt.claim.sub = '35000000-0000-0000-0000-000000000002';

select lives_ok(
  format(
    $$ insert into public.absence_records
         (employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by)
       values (%L, %L, date '2026-08-10', date '2026-08-15', 'manual', 'hash-manual-021', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST3-MANUAL-PROD-001'),
    (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
    '35000000-0000-0000-0000-000000000002'
  ),
  'SUPERVISOR_PRODUCTION puede registrar una licencia manual (L) para su propio grupo'
);

-- 2) No puede registrarla fingiendo que otro usuario fue quien la creó.
select throws_ok(
  format(
    $$ insert into public.absence_records
         (employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by)
       values (%L, %L, date '2026-09-01', date '2026-09-05', 'manual', 'hash-manual-022', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST3-MANUAL-PROD-001'),
    (select id from public.absence_types where code = 'VACATION'),
    '35000000-0000-0000-0000-000000000001' -- fingiendo ser el admin
  ),
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede registrar una novedad manual fingiendo otro created_by'
);

reset role;

-- 3-5) Lectura amplia confirmada: los 3 roles corporativos pueden leer employees.
set local role authenticated;
set local request.jwt.claim.sub = '35000000-0000-0000-0000-000000000001';
select isnt_empty($$ select 1 from public.employees $$, 'ADMIN_RRHH puede leer employees');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '35000000-0000-0000-0000-000000000002';
select isnt_empty($$ select 1 from public.employees $$, 'SUPERVISOR_PRODUCTION puede leer employees (incluso de otros grupos)');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '35000000-0000-0000-0000-000000000003';
select isnt_empty($$ select 1 from public.employees $$, 'SUPERVISOR_INSTALLATION puede leer employees (incluso de otros grupos)');

-- 6) Pero SUPERVISOR_INSTALLATION no puede registrar una novedad manual para
-- un trabajador de PRODUCTION (fuera de su dominio).
select throws_ok(
  format(
    $$ insert into public.absence_records
         (employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by)
       values (%L, %L, date '2026-10-01', date '2026-10-05', 'manual', 'hash-manual-023', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST3-MANUAL-PROD-001'),
    (select id from public.absence_types where code = 'VACATION'),
    '35000000-0000-0000-0000-000000000003'
  ),
  '42501',
  null,
  'SUPERVISOR_INSTALLATION no puede registrar una novedad manual para un trabajador de PRODUCTION'
);

reset role;
select * from finish();
rollback;
