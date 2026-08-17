-- pgTAP Fase 3: autoridad de RRHH sobre decisiones + seguridad de
-- WeeklyReview/ReportingPeriod (secciones 7/8/17/18/40/41/43 del encargo)
create extension if not exists pgtap;

begin;
select plan(10);

insert into public.profiles (id, display_name, role) values
  ('32000000-0000-0000-0000-000000000001', 'Fixture Admin', 'ADMIN_RRHH'),
  ('32000000-0000-0000-0000-000000000002', 'Fixture Supervisor Prod', 'SUPERVISOR_PRODUCTION');

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-ADMIN-OT-001', 'Fixture', 'AdminOT', 'Fixture AdminOT',
  (select id from public.employee_groups where code = 'PRODUCTION')
);
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:00-04',
  'hash-admin-ot-1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-admin-ot-1'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001')),
  120, 0, 'FULLY_APPROVED', '32000000-0000-0000-0000-000000000002'
);

-- 1) SUPERVISOR_PRODUCTION no puede invalidar (is_current=false) su propia
-- decisión ya tomada — solo RRHH revisa/anula decisiones existentes.
set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000002';

-- USING(is_admin_rrhh()) simple no genera excepción para un no-admin: la fila
-- queda fuera del conjunto visible para UPDATE y la sentencia "vive" afectando
-- 0 filas (comportamiento estándar de Postgres RLS).
select lives_ok(
  format(
    $$ update public.overtime_decisions set is_current = false where overtime_record_id = %L $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'))
  ),
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
select is(
  (select is_current from public.overtime_decisions where overtime_record_id =
     (select id from public.overtime_records where employee_id =
        (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'))),
  true,
  'SUPERVISOR_PRODUCTION NO logra invalidar una OvertimeDecision ya tomada (is_current sigue true)'
);

reset role;

-- 2) ADMIN_RRHH SÍ puede hacerlo (REVIEW/OVERRIDE, sección 7/8) — la decisión
-- original NO se borra, queda is_current=false como historial.
set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000001';

select lives_ok(
  format(
    $$ update public.overtime_decisions set is_current = false where overtime_record_id = %L $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'))
  ),
  'ADMIN_RRHH puede invalidar una OvertimeDecision para permitir una revisión (REVIEW/OVERRIDE)'
);

reset role;

select is(
  (select count(*)::int from public.overtime_decisions where overtime_record_id =
     (select id from public.overtime_records where employee_id =
        (select id from public.employees where external_workera_id = 'TEST3-ADMIN-OT-001'))),
  1,
  'la decisión original NO se borró — sigue existiendo como historial (is_current=false)'
);

-- 3) ReportingPeriod: solo ADMIN_RRHH puede abrir/cerrar/reabrir.
set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.reporting_periods (period_start, period_end)
     values (date '2026-08-01', date '2026-08-31') $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede crear un ReportingPeriod'
);

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000001';

insert into public.reporting_periods (period_start, period_end, status)
values (date '2026-08-01', date '2026-08-31', 'READY_TO_CLOSE');

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ update public.reporting_periods set status = 'CLOSED'
     where period_start = date '2026-08-01' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
select is(
  (select status::text from public.reporting_periods where period_start = date '2026-08-01'),
  'READY_TO_CLOSE',
  'SUPERVISOR_PRODUCTION NO logra cerrar el ReportingPeriod (regla obligatoria, sección 18 — sigue READY_TO_CLOSE)'
);

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000001';

select lives_ok(
  format(
    $$ update public.reporting_periods set status = 'CLOSED', closed_by = %L
       where period_start = date '2026-08-01' $$,
    '32000000-0000-0000-0000-000000000001'
  ),
  'ADMIN_RRHH puede cerrar el ReportingPeriod, con closed_by = auth.uid()'
);

reset role;

-- 4) WeeklyReview: supervisor no puede cerrar/reabrir; sí puede avanzar
-- estados intermedios (OPEN -> READY_TO_CLOSE).
insert into public.weekly_reviews (period_start, period_end) values (date '2026-08-01', date '2026-08-07');

set local role authenticated;
set local request.jwt.claim.sub = '32000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ update public.weekly_reviews set status = 'READY_TO_CLOSE'
     where period_start = date '2026-08-01' and period_end = date '2026-08-07' $$,
  'SUPERVISOR_PRODUCTION puede avanzar WeeklyReview a READY_TO_CLOSE (revisión operacional)'
);

select throws_ok(
  $$ update public.weekly_reviews set status = 'CLOSED'
     where period_start = date '2026-08-01' and period_end = date '2026-08-07' $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede CERRAR un WeeklyReview'
);

reset role;
select * from finish();
rollback;
