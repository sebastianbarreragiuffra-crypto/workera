-- pgTAP: versionado e inmutabilidad de attendance_records
create extension if not exists pgtap;

begin;
select plan(5);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST-EMP-ATT-001', 'Fixture', 'Attendance', 'Fixture Attendance');

-- 1) Insertar versión 1 funciona
select lives_ok(
  $$ insert into public.attendance_records
       (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
     values (
       (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001'),
       date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:00-04',
       'hash-v1', 1, true
     ) $$,
  'attendance_records: version 1 se inserta correctamente'
);

-- 2) Duplicar el mismo número de versión para el mismo empleado+fecha debe rechazarse
select throws_ok(
  $$ insert into public.attendance_records
       (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
     values (
       (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001'),
       date '2026-08-10', timestamptz '2026-08-10 07:31-04', timestamptz '2026-08-10 19:05-04',
       'hash-dup', 1, false
     ) $$,
  '23505',
  null,
  'attendance_records: version_number duplicado para el mismo empleado+fecha es rechazado'
);

-- 3) Insertar una segunda versión is_current=true SIN desactivar la anterior debe rechazarse
--    (solo una fila "current" por empleado+fecha)
select throws_ok(
  $$ insert into public.attendance_records
       (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
     values (
       (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001'),
       date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 18:30-04',
       'hash-v2', 2, true
     ) $$,
  '23505',
  null,
  'attendance_records: dos versiones is_current=true para el mismo empleado+fecha es rechazado'
);

-- 4) Flujo correcto: desactivar v1, insertar v2 como current -> debe funcionar
select lives_ok(
  $$ update public.attendance_records set is_current = false
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001')
       and source_version = 1;
     insert into public.attendance_records
       (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
     values (
       (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001'),
       date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 18:30-04',
       'hash-v2', 2, true
     ) $$,
  'attendance_records: version 2 reemplaza correctamente a version 1 como current'
);

-- 5) Intentar modificar el clock_out de la version 1 (ya no current) debe rechazarse:
--    el hecho original es inmutable, incluso si ya no es la version vigente.
select throws_ok(
  $$ update public.attendance_records set actual_clock_out = timestamptz '2026-08-10 20:00-04'
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-EMP-ATT-001')
       and source_version = 1 $$,
  'P0001',
  null,
  'attendance_records: modificar actual_clock_out de un registro ya insertado es rechazado (trigger de inmutabilidad)'
);

select * from finish();
rollback;
