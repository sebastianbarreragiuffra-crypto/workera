-- pgTAP: late_arrival_records / late_arrival_decisions
create extension if not exists pgtap;

begin;
select plan(3);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST-EMP-LA-001', 'Fixture', 'LateArrival', 'Fixture LateArrival');

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-LA-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:45-04', timestamptz '2026-08-10 17:00-04',
  'hash-la-1', 1, true
);

insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-LA-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-la-1'),
  time '07:30', timestamptz '2026-08-10 07:45-04', 15,
  (select lap.id from public.late_arrival_policies lap
     join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'PRODUCTION' and lap.day_of_week = 1)
);

insert into public.profiles (display_name, role) values ('Fixture Decisor LA', 'supervisor');

-- 1) detected=15, justificado, payroll=0: caso del encargo (docs/BUSINESS_RULES_PRE_PHASE2.md sección 7)
select lives_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
       values (%L, true, 0, 'DO_NOT_DEDUCT', %L) $$,
    (select id from public.late_arrival_records where detected_minutes = 15),
    (select id from public.profiles where display_name = 'Fixture Decisor LA')
  ),
  'late_arrival_decisions: detected=15, justified=true, payroll=0 se inserta'
);

-- 2) payroll_minutes > detected_minutes debe rechazarse (trigger cruzado)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-LA-001'),
  date '2026-08-11', timestamptz '2026-08-11 07:45-04', timestamptz '2026-08-11 17:00-04',
  'hash-la-2', 1, true
);
insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-LA-001'),
  date '2026-08-11',
  (select id from public.attendance_records where source_hash = 'hash-la-2'),
  time '07:30', timestamptz '2026-08-11 07:45-04', 15,
  (select lap.id from public.late_arrival_policies lap
     join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'PRODUCTION' and lap.day_of_week = 2)
);

select throws_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
       values (%L, false, 25, 'DEDUCT', %L) $$, -- 25 > 15 detectados
    (select id from public.late_arrival_records where detected_minutes = 15 and work_date = date '2026-08-11'),
    (select id from public.profiles where display_name = 'Fixture Decisor LA')
  ),
  'P0001',
  null,
  'late_arrival_decisions: payroll_minutes (25) > detected_minutes (15) es rechazado'
);

-- 3) payroll_minutes negativo debe rechazarse (CHECK universal)
select throws_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
       values (%L, false, -5, 'DEDUCT', %L) $$,
    (select id from public.late_arrival_records where detected_minutes = 15 and work_date = date '2026-08-11'),
    (select id from public.profiles where display_name = 'Fixture Decisor LA')
  ),
  '23514',
  null,
  'late_arrival_decisions: payroll_minutes negativo es rechazado'
);

select * from finish();
rollback;
