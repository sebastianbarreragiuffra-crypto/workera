-- pgTAP Fase 2B: attendance_statuses (11 códigos reales) + attendance_status_records
create extension if not exists pgtap;

begin;
select plan(6);

-- 1) Los 11 códigos existen
select is(
  (select count(*)::int from public.attendance_statuses
     where code in ('P','F','F-P','F-J','P-L','P-M','V','L','L-M','R','?')),
  11,
  'attendance_statuses: los 11 códigos reales existen'
);

-- 2) Los códigos son únicos (constraint UNIQUE ya lo garantiza; se confirma que
--    no hay duplicados en la tabla completa)
select is(
  (select count(distinct code)::int from public.attendance_statuses),
  (select count(*)::int from public.attendance_statuses),
  'attendance_statuses: todos los códigos son únicos'
);

-- 3) "?" requiere revisión (NEEDS_REVIEW conceptual)
select ok(
  (select requires_review from public.attendance_statuses where code = '?'),
  '"?" (tarjeta no marcada) tiene requires_review = true'
);

-- 4) "R" NO tiene requires_review forzado (regla pendiente, no inventada)
select ok(
  not (select requires_review from public.attendance_statuses where code = 'R'),
  '"R" (recuperan horas) no fuerza requires_review (regla pendiente de confirmación)'
);

-- 5) attendance_status_records: inserción manual requiere created_by
insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST2B-EMP-STATUS-001', 'Fixture', 'Status', 'Fixture Status');

select throws_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, source_hash)
       values (%L, date '2026-08-10', %L, 'manual', 'hash-status-1') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-STATUS-001'),
    (select id from public.attendance_statuses where code = 'L')
  ),
  '23514',
  null,
  'attendance_status_records: source=manual sin created_by es rechazado'
);

-- 6) Con created_by, la novedad manual se inserta correctamente (sección 11 del encargo)
insert into public.profiles (display_name, role) values ('Fixture Supervisor Status', 'SUPERVISOR_PRODUCTION');
select lives_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, source_hash, created_by, reason)
       values (%L, date '2026-08-10', %L, 'manual', 'hash-status-2', %L, 'Workera no trajo la licencia, ingresada manualmente') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-STATUS-001'),
    (select id from public.attendance_statuses where code = 'L'),
    (select id from public.profiles where display_name = 'Fixture Supervisor Status')
  ),
  'attendance_status_records: novedad manual (L) con created_by y reason se inserta'
);

select * from finish();
rollback;
