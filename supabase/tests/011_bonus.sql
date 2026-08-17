-- pgTAP Fase 2B: bonus_policies / employee_daily_bonuses
create extension if not exists pgtap;

begin;
select plan(6);

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST2B-EMP-BONUS-001', 'Fixture', 'Bonus', 'Fixture Bonus',
  (select id from public.employee_groups where code = 'PRODUCTION')
);
insert into public.profiles (display_name, role) values ('Fixture Decisor Bonus', 'SUPERVISOR_PRODUCTION');

-- Caso 1: approved = 120 -> bono representable ($1.000 CLP)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:35-04',
  'hash-2b-bonus-1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-2b-bonus-1'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001') and work_date = date '2026-08-10'),
  120, 0, 'FULLY_APPROVED',
  (select id from public.profiles where display_name = 'Fixture Decisor Bonus')
);

select lives_ok(
  format(
    $$ insert into public.employee_daily_bonuses
         (employee_id, work_date, overtime_decision_id, bonus_policy_id, amount, currency)
       values (%L, date '2026-08-10', %L, %L, 1000, 'CLP') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
    (select od.id from public.overtime_decisions od join public.overtime_records ovr on ovr.id = od.overtime_record_id
       where ovr.employee_id = (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001')
         and ovr.work_date = date '2026-08-10'),
    (select bp.id from public.bonus_policies bp join public.employee_groups eg on eg.id = bp.employee_group_id
       where eg.code = 'PRODUCTION')
  ),
  'employee_daily_bonuses: PRODUCTION + 120 min aprobados = $1.000 CLP se inserta'
);

-- Caso 2: approved = 90 -> NO BONUS (el trigger de validación debe rechazar el intento)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-11', timestamptz '2026-08-11 07:30-04', timestamptz '2026-08-11 18:30-04',
  'hash-2b-bonus-2', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-11',
  (select id from public.attendance_records where source_hash = 'hash-2b-bonus-2'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  90,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001') and work_date = date '2026-08-11'),
  90, 0, 'FULLY_APPROVED',
  (select id from public.profiles where display_name = 'Fixture Decisor Bonus')
);

select throws_ok(
  format(
    $$ insert into public.employee_daily_bonuses
         (employee_id, work_date, overtime_decision_id, bonus_policy_id, amount, currency)
       values (%L, date '2026-08-11', %L, %L, 1000, 'CLP') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
    (select od.id from public.overtime_decisions od join public.overtime_records ovr on ovr.id = od.overtime_record_id
       where ovr.employee_id = (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001')
         and ovr.work_date = date '2026-08-11'),
    (select bp.id from public.bonus_policies bp join public.employee_groups eg on eg.id = bp.employee_group_id
       where eg.code = 'PRODUCTION')
  ),
  'P0001',
  null,
  'employee_daily_bonuses: approved=90 (< 120) es rechazado por el trigger de validación -> NO BONUS'
);

-- Caso 3: monto que no coincide con la política vigente debe rechazarse
-- (tercer día, con su propia OvertimeDecision fresca, para no chocar con el
-- UNIQUE(overtime_decision_id) ya consumido en el Caso 1)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-12', timestamptz '2026-08-12 07:30-04', timestamptz '2026-08-12 19:35-04',
  'hash-2b-bonus-3', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
  date '2026-08-12',
  (select id from public.attendance_records where source_hash = 'hash-2b-bonus-3'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 3)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001') and work_date = date '2026-08-12'),
  120, 0, 'FULLY_APPROVED',
  (select id from public.profiles where display_name = 'Fixture Decisor Bonus')
);

select throws_ok(
  format(
    $$ insert into public.employee_daily_bonuses
         (employee_id, work_date, overtime_decision_id, bonus_policy_id, amount, currency)
       values (%L, date '2026-08-12', %L, %L, 5000, 'CLP') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001'),
    (select od.id from public.overtime_decisions od join public.overtime_records ovr on ovr.id = od.overtime_record_id
       where ovr.employee_id = (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001')
         and ovr.work_date = date '2026-08-12'),
    (select bp.id from public.bonus_policies bp join public.employee_groups eg on eg.id = bp.employee_group_id
       where eg.code = 'PRODUCTION')
  ),
  'P0001',
  null,
  'employee_daily_bonuses: monto que no coincide con la bonus_policy vigente es rechazado'
);

-- Caso 4: bono ya otorgado es inmutable (no se puede editar el monto después)
select throws_ok(
  format(
    $$ update public.employee_daily_bonuses set amount = 2000 where employee_id = %L and work_date = date '2026-08-10' $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-BONUS-001')
  ),
  'P0001',
  null,
  'employee_daily_bonuses: un bono ya otorgado es inmutable'
);

-- Caso 5: amount negativo en bonus_policies es rechazado (dinero, sección 23)
select throws_ok(
  format(
    $$ insert into public.bonus_policies
         (bonus_type_id, employee_group_id, trigger_type, threshold_minutes, amount, currency, effective_from)
       values (%L, %L, 'APPROVED_OVERTIME_MINUTES_THRESHOLD', 120, -1000, 'CLP', date '2026-01-01') $$,
    (select id from public.bonus_types where code = 'PRODUCTION_DAILY_OVERTIME_BONUS'),
    (select id from public.employee_groups where code = 'INSTALLATION')
  ),
  '23514',
  null,
  'bonus_policies: amount negativo es rechazado'
);

-- Caso 6: INSTALLATION no tiene bonus_policy sembrada (PENDING_BUSINESS_CONFIRMATION)
select is(
  (select count(*)::int from public.bonus_policies bp
     join public.employee_groups eg on eg.id = bp.employee_group_id
     where eg.code = 'INSTALLATION'),
  0,
  'bonus_policies: INSTALLATION no tiene ninguna política sembrada (regla pendiente, no inventada)'
);

select * from finish();
rollback;
