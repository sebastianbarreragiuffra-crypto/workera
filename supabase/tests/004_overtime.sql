-- pgTAP: overtime_records / overtime_decisions (candidato vs. decisión)
create extension if not exists pgtap;

begin;
select plan(6);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST-EMP-OT-001', 'Fixture', 'Overtime', 'Fixture Overtime');

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:45-04',
  'hash-ot-1', 1, true
);

-- 1) candidate_minutes negativo debe rechazarse
select throws_ok(
  format(
    $$ insert into public.overtime_records
         (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
       values (%L, date '2026-08-10', %L, %L, -10, %L) $$,
    (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001'),
    (select id from public.attendance_records where source_hash = 'hash-ot-1'),
    (select id from public.overtime_types where code = 'OVERTIME_50'),
    (select op.id from public.overtime_policies op
       join public.employee_groups eg on eg.id = op.employee_group_id
       where eg.code = 'PRODUCTION' and op.day_of_week = 1)
  ),
  '23514',
  null,
  'overtime_records: candidate_minutes negativo es rechazado'
);

-- 2) candidate_minutes = 120 (caso "19:45 -> tope de 120", ver docs/BUSINESS_RULES_PRE_PHASE2.md)
select lives_ok(
  format(
    $$ insert into public.overtime_records
         (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
       values (%L, date '2026-08-10', %L, %L, 120, %L) $$,
    (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001'),
    (select id from public.attendance_records where source_hash = 'hash-ot-1'),
    (select id from public.overtime_types where code = 'OVERTIME_50'),
    (select op.id from public.overtime_policies op
       join public.employee_groups eg on eg.id = op.employee_group_id
       where eg.code = 'PRODUCTION' and op.day_of_week = 1)
  ),
  'overtime_records: candidate_minutes = 120 (clock_out real 19:45, tope aplicado) se inserta'
);

insert into public.profiles (display_name, role) values ('Fixture Decisor', 'supervisor');

-- 3) Aprobación parcial válida: candidate=120, approved=90, rejected=30
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 90, 30, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where candidate_minutes = 120
       and employee_id = (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001')),
    (select id from public.profiles where display_name = 'Fixture Decisor')
  ),
  'overtime_decisions: aprobación parcial 90/30 sobre candidato 120 se inserta'
);

-- 4) approved + rejected != candidate debe rechazarse (trigger validate_overtime_decision)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001'),
  date '2026-08-11', timestamptz '2026-08-11 07:30-04', timestamptz '2026-08-11 19:45-04',
  'hash-ot-2', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-OT-001'),
  date '2026-08-11',
  (select id from public.attendance_records where source_hash = 'hash-ot-2'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op
     join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);

select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 90, 20, 'PARTIALLY_APPROVED', %L) $$, -- 90+20=110 != 120
    (select id from public.overtime_records where candidate_minutes = 120
       and work_date = date '2026-08-11'),
    (select id from public.profiles where display_name = 'Fixture Decisor')
  ),
  'P0001',
  null,
  'overtime_decisions: approved+rejected != candidate es rechazado (trigger cruzado)'
);

-- 5) approved_minutes > candidate_minutes debe rechazarse
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 150, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where candidate_minutes = 120
       and work_date = date '2026-08-11'),
    (select id from public.profiles where display_name = 'Fixture Decisor')
  ),
  'P0001',
  null,
  'overtime_decisions: approved_minutes > candidate_minutes es rechazado (trigger cruzado)'
);

-- 6) decision_status inconsistente con las cantidades debe rechazarse (CHECK de fila)
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'REJECTED', %L) $$, -- REJECTED pero approved=120
    (select id from public.overtime_records where candidate_minutes = 120
       and work_date = date '2026-08-11'),
    (select id from public.profiles where display_name = 'Fixture Decisor')
  ),
  '23514',
  null,
  'overtime_decisions: decision_status inconsistente con las cantidades es rechazado (CHECK)'
);

select * from finish();
rollback;
