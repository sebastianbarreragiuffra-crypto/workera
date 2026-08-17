-- pgTAP Fase 3: autorización de escritura por contexto operacional (grupo) +
-- protección IDOR/BOLA (secciones 5/6/34/37/38 del encargo)
create extension if not exists pgtap;

begin;
select plan(7);

insert into public.profiles (id, display_name, role) values
  ('31000000-0000-0000-0000-000000000001', 'Fixture Supervisor Prod', 'SUPERVISOR_PRODUCTION'),
  ('31000000-0000-0000-0000-000000000002', 'Fixture Supervisor Install', 'SUPERVISOR_INSTALLATION');

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-IDOR-PROD-001', 'Fixture', 'Prod', 'Fixture Prod',
  (select id from public.employee_groups where code = 'PRODUCTION')
);
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-IDOR-INSTALL-001', 'Fixture', 'Install', 'Fixture Install',
  (select id from public.employee_groups where code = 'INSTALLATION')
);

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:00-04',
  'hash-idor-prod-1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-idor-prod-1'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);

-- 1) SUPERVISOR_PRODUCTION puede aprobar horas extra de un trabajador de
-- PRODUCTION (dentro de su contexto operacional)
set local role authenticated;
set local request.jwt.claim.sub = '31000000-0000-0000-0000-000000000001';

select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records
       where employee_id = (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001')),
    '31000000-0000-0000-0000-000000000001'
  ),
  'SUPERVISOR_PRODUCTION puede aprobar horas extra de un trabajador de PRODUCTION'
);

reset role;

-- 2) SUPERVISOR_INSTALLATION intenta aprobar horas extra de ese MISMO
-- trabajador de PRODUCTION (IDOR: usa un UUID válido pero fuera de su
-- dominio) -> DENIED. Se usa un segundo overtime_record para no chocar con
-- el UNIQUE ya consumido en el caso 1.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
  date '2026-08-11', timestamptz '2026-08-11 07:30-04', timestamptz '2026-08-11 19:00-04',
  'hash-idor-prod-2', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
  date '2026-08-11',
  (select id from public.attendance_records where source_hash = 'hash-idor-prod-2'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);

set local role authenticated;
set local request.jwt.claim.sub = '31000000-0000-0000-0000-000000000002';

select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001')
       and work_date = date '2026-08-11'),
    '31000000-0000-0000-0000-000000000002'
  ),
  '42501',
  null,
  'SUPERVISOR_INSTALLATION NO puede aprobar horas extra de un trabajador de PRODUCTION (IDOR bloqueado por RLS)'
);

reset role;

-- Fixture para los casos 3 y 4: un atraso real de un trabajador de
-- INSTALLATION (dentro del dominio de SUPERVISOR_INSTALLATION).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-INSTALL-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:45-04', timestamptz '2026-08-10 17:00-04',
  'hash-idor-install-1', 1, true
);
insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST3-IDOR-INSTALL-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-idor-install-1'),
  time '07:30', timestamptz '2026-08-10 07:45-04', 15,
  (select lap.id from public.late_arrival_policies lap join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'INSTALLATION' and lap.day_of_week = 1)
);

-- 3) SUPERVISOR_INSTALLATION intenta forjar el actor (decided_by = otro
-- usuario) sobre un REGISTRO REAL de su propio dominio -> DENIED, porque
-- decided_by no coincide con auth.uid() (se usa un registro real, no un uuid
-- inexistente, para aislar exactamente la condición de actor forjado sin que
-- el trigger de validación de dominio dispare primero por otra razón).
set local role authenticated;
set local request.jwt.claim.sub = '31000000-0000-0000-0000-000000000002';

select throws_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
       values (%L, true, 0, 'DO_NOT_DEDUCT', %L) $$,
    (select id from public.late_arrival_records where employee_id =
       (select id from public.employees where external_workera_id = 'TEST3-IDOR-INSTALL-001')),
    '31000000-0000-0000-0000-000000000001' -- forjando el actor de OTRO supervisor
  ),
  '42501',
  null,
  'decided_by forjado (distinto de auth.uid()) es rechazado por WITH CHECK, aun sobre un registro real dentro del propio dominio'
);

-- 4) SUPERVISOR_INSTALLATION SÍ puede operar sobre ese mismo registro con su
-- PROPIO actor — confirma que el scoping no es "denegar todo", es "denegar
-- fuera de dominio o con actor forjado" (el intento fallido del caso 3 no
-- insertó ninguna fila, por eso este registro sigue disponible).
select lives_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
       values (%L, true, 0, 'DO_NOT_DEDUCT', %L) $$,
    (select id from public.late_arrival_records where employee_id =
       (select id from public.employees where external_workera_id = 'TEST3-IDOR-INSTALL-001')),
    '31000000-0000-0000-0000-000000000002'
  ),
  'SUPERVISOR_INSTALLATION puede justificar el atraso de un trabajador de INSTALLATION (dentro de su dominio)'
);

reset role;

-- 5) Ningún supervisor puede modificar directamente el source de Workera
-- (attendance_records) — ni siquiera dentro de su propio dominio.
set local role authenticated;
set local request.jwt.claim.sub = '31000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.attendance_records set actual_clock_out = timestamptz '2026-08-10 22:00-04'
     where source_hash = 'hash-idor-prod-1' $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede modificar attendance_records directamente (sin policy de UPDATE)'
);

-- 6) Ningún supervisor puede insertar/manipular overtime_records (cálculo del
-- sistema) directamente.
select throws_ok(
  format(
    $$ insert into public.overtime_records
         (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
       values (%L, date '2026-08-12', %L, %L, 999, %L) $$,
    (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
    (select id from public.attendance_records where source_hash = 'hash-idor-prod-1'),
    (select id from public.overtime_types where code = 'OVERTIME_50'),
    (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
       where eg.code = 'PRODUCTION' and op.day_of_week = 1)
  ),
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede insertar overtime_records directamente (candidate_minutes es cálculo del sistema)'
);

-- 7) Ningún supervisor puede crear un bono manualmente.
select throws_ok(
  format(
    $$ insert into public.employee_daily_bonuses
         (employee_id, work_date, overtime_decision_id, bonus_policy_id, amount, currency)
       values (%L, date '2026-08-10', %L, %L, 999999, 'CLP') $$,
    (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001'),
    (select id from public.overtime_decisions where overtime_record_id =
       (select id from public.overtime_records where employee_id =
          (select id from public.employees where external_workera_id = 'TEST3-IDOR-PROD-001')
          and work_date = date '2026-08-10')),
    (select bp.id from public.bonus_policies bp join public.employee_groups eg on eg.id = bp.employee_group_id
       where eg.code = 'PRODUCTION')
  ),
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede crear un EmployeeDailyBonus manualmente ($999.999)'
);

reset role;
select * from finish();
rollback;
