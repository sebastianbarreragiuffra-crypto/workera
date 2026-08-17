-- pgTAP: schedule_assignments y supervisor_assignments (rangos y solapamientos)
create extension if not exists pgtap;

begin;
select plan(4);

-- Fixtures
insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST-EMP-ASSIGN-001', 'Fixture', 'Assign', 'Fixture Assign');

insert into public.profiles (display_name, role)
values ('Fixture Supervisor', 'supervisor');

insert into public.work_schedules (name) values ('Fixture Schedule');

-- 1) schedule_assignments: effective_to < effective_from debe rechazarse
select throws_ok(
  format(
    $$ insert into public.schedule_assignments (employee_id, work_schedule_id, effective_from, effective_to)
       values ((select id from public.employees where external_workera_id = 'TEST-EMP-ASSIGN-001'),
               (select id from public.work_schedules where name = 'Fixture Schedule'),
               date '2026-02-01', date '2026-01-01') $$
  ),
  '23514',
  null,
  'schedule_assignments: rango inválido (effective_to < effective_from) es rechazado'
);

-- 2) schedule_assignments: solapamiento debe rechazarse
select lives_ok(
  $$ insert into public.schedule_assignments (employee_id, work_schedule_id, effective_from, effective_to)
     values ((select id from public.employees where external_workera_id = 'TEST-EMP-ASSIGN-001'),
             (select id from public.work_schedules where name = 'Fixture Schedule'),
             date '2026-01-01', date '2026-06-30') $$,
  'schedule_assignments: primera asignación válida'
);

select throws_ok(
  $$ insert into public.schedule_assignments (employee_id, work_schedule_id, effective_from, effective_to)
     values ((select id from public.employees where external_workera_id = 'TEST-EMP-ASSIGN-001'),
             (select id from public.work_schedules where name = 'Fixture Schedule'),
             date '2026-06-01', null) $$,
  '23P01',
  null,
  'schedule_assignments: solapamiento de rango es rechazado (EXCLUDE)'
);

-- 3) supervisor_assignments: solapamiento debe rechazarse
insert into public.supervisor_assignments (employee_id, supervisor_profile_id, effective_from, effective_to, source)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-ASSIGN-001'),
  (select id from public.profiles where display_name = 'Fixture Supervisor'),
  date '2026-01-01', date '2026-06-30', 'internal'
);

select throws_ok(
  format(
    $$ insert into public.supervisor_assignments (employee_id, supervisor_profile_id, effective_from, effective_to, source)
       values (%L, %L, date '2026-03-01', date '2026-04-01', 'internal') $$,
    (select id from public.employees where external_workera_id = 'TEST-EMP-ASSIGN-001'),
    (select id from public.profiles where display_name = 'Fixture Supervisor')
  ),
  '23P01',
  null,
  'supervisor_assignments: solapamiento de rango es rechazado (EXCLUDE)'
);

select * from finish();
rollback;
