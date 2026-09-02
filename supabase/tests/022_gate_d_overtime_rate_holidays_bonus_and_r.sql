-- pgTAP Gate D: clasificación HH50/HH100, feriados, límites de Producción/
-- Instalación, motor de bono automático, desactivación de R, ACL/RLS.
create extension if not exists pgtap;

begin;
select plan(44);

-- ---------------------------------------------------------------------------
-- Fixtures base
insert into public.profiles (id, display_name, role) values
  ('40000000-0000-0000-0000-000000000001', 'Fixture Admin GateD', 'ADMIN_RRHH'),
  ('40000000-0000-0000-0000-000000000002', 'Fixture Supervisor Prod GateD', 'SUPERVISOR_PRODUCTION'),
  ('40000000-0000-0000-0000-000000000003', 'Fixture Supervisor Install GateD', 'SUPERVISOR_INSTALLATION'),
  ('40000000-0000-0000-0000-000000000004', 'Fixture Trabajador Sin Rol GateD', null);

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values
  ('GATED-PROD-001', 'Fixture', 'ProdD', 'Fixture ProdD', (select id from public.employee_groups where code = 'PRODUCTION')),
  ('GATED-INSTALL-001', 'Fixture', 'InstallD', 'Fixture InstallD', (select id from public.employee_groups where code = 'INSTALLATION')),
  ('GATED-ADMIN-001', 'Fixture', 'AdminGroupD', 'Fixture AdminGroupD', (select id from public.employee_groups where code = 'ADMINISTRATION'));

-- Helper repetido: crea attendance_record + overtime_record (candidato) para
-- un empleado+fecha+minutos dados, retornando implícitamente vía subselect
-- posterior por (employee external_workera_id, work_date). No se usa una
-- función pgTAP genérica para no ocultar los datos exactos de cada caso.

-- ===========================================================================
-- CLASIFICACIÓN HH50/HH100 (8)
-- ===========================================================================

select is(
  public.classify_overtime_type_id(date '2026-08-10'), -- lunes
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  'classify_overtime_type_id: lunes normal -> OVERTIME_50'
);
select is(
  public.classify_overtime_type_id(date '2026-08-14'), -- viernes
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  'classify_overtime_type_id: viernes normal -> OVERTIME_50'
);
select is(
  public.classify_overtime_type_id(date '2026-08-22'), -- sábado no feriado
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  'classify_overtime_type_id: sábado normal -> OVERTIME_50'
);
select is(
  public.classify_overtime_type_id(date '2026-08-16'), -- domingo
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'classify_overtime_type_id: domingo -> OVERTIME_100'
);

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000001';
insert into public.holidays (holiday_date, name, created_by) values
  (date '2026-09-07', 'Feriado fixture (lunes)', '40000000-0000-0000-0000-000000000001'),
  (date '2026-09-12', 'Feriado fixture (sábado)', '40000000-0000-0000-0000-000000000001'),
  (date '2026-09-08', 'Feriado fixture (martes)', '40000000-0000-0000-0000-000000000001');
reset role;

select is(
  public.classify_overtime_type_id(date '2026-09-07'),
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'classify_overtime_type_id: feriado en lunes -> OVERTIME_100'
);
select is(
  public.classify_overtime_type_id(date '2026-09-12'),
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'classify_overtime_type_id: feriado en sábado -> OVERTIME_100'
);
select is(
  public.classify_overtime_type_id(date '2026-09-08'),
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'classify_overtime_type_id: feriado en martes prevalece sobre HH50 -> OVERTIME_100'
);

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 09:30-04',
  'hash-gated-classify-1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-gated-classify-1'),
  (select id from public.overtime_types where code = 'OVERTIME_100'), -- propuesto por el "cliente"
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select is(
  (select overtime_type_id from public.overtime_records
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-10'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  'overtime_records: el trigger ignora el overtime_type_id propuesto y clasifica según work_date (lunes -> OVERTIME_50)'
);

-- ===========================================================================
-- PRODUCCIÓN — límites aprobables (8)
-- ===========================================================================

-- 2026-08-17 lunes: candidato 120, aprobar 120 -> permitido
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-17', timestamptz '2026-08-17 07:30-04', timestamptz '2026-08-17 19:30-04',
  'hash-gated-prod-mon120', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-17',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-mon120'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-17'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'PRODUCTION lunes: 120 min aprobados es permitido'
);

-- 2026-08-18 martes: candidato 130, intentar aprobar 121 -> rechazado (excede 120)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-18', timestamptz '2026-08-18 07:30-04', timestamptz '2026-08-18 19:40-04',
  'hash-gated-prod-tue130', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-18',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-tue130'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  130,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 121, 9, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-18'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'P0001',
  null,
  'PRODUCTION martes: aprobar 121 min es rechazado (excede el máximo de 120 lunes-viernes)'
);

-- El dato original (candidate_minutes=130) no se altera por el rechazo anterior.
select is(
  (select candidate_minutes from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-18'),
  130,
  'overtime_records.candidate_minutes se conserva íntegro (130) aunque exceda el máximo aprobable'
);

-- 2026-08-22 sábado: candidato 360, aprobar 360 -> permitido
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-22', timestamptz '2026-08-22 08:00-04', timestamptz '2026-08-22 14:00-04',
  'hash-gated-prod-sat360', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-22',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-sat360'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  360,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 6)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 360, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-22'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'PRODUCTION sábado: 360 min aprobados es permitido'
);

-- 2026-08-29 sábado: candidato 400, intentar aprobar 361 -> rechazado
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-29', timestamptz '2026-08-29 08:00-04', timestamptz '2026-08-29 14:40-04',
  'hash-gated-prod-sat400', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-29',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-sat400'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  400,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 6)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 361, 39, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-29'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'P0001',
  null,
  'PRODUCTION sábado: aprobar 361 min es rechazado (excede el máximo de 360)'
);

-- 2026-08-16 domingo: candidato 360, aprobar 360 -> permitido
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-16', timestamptz '2026-08-16 08:00-04', timestamptz '2026-08-16 14:00-04',
  'hash-gated-prod-sun360', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-16',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-sun360'),
  (select id from public.overtime_types where code = 'OVERTIME_50'), -- se sobrescribirá a OVERTIME_100
  360,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 0)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 360, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-16'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'PRODUCTION domingo: 360 min aprobados es permitido'
);

-- 2026-08-30 domingo: candidato 400, intentar aprobar 361 -> rechazado
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-30', timestamptz '2026-08-30 08:00-04', timestamptz '2026-08-30 14:40-04',
  'hash-gated-prod-sun400', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-30',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-sun400'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  400,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 0)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 361, 39, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-30'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'P0001',
  null,
  'PRODUCTION domingo: aprobar 361 min es rechazado (excede el máximo de 360)'
);

-- Feriado (2026-09-07, lunes): candidato 360, aprobar 360 -> permitido (360, no 120)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-07', timestamptz '2026-09-07 08:00-04', timestamptz '2026-09-07 14:00-04',
  'hash-gated-prod-holiday360', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-07',
  (select id from public.attendance_records where source_hash = 'hash-gated-prod-holiday360'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  360,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 360, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-09-07'),
    '40000000-0000-0000-0000-000000000002'
  ),
  'PRODUCTION feriado (lunes 2026-09-07): 360 min aprobados es permitido (no se limita a 120)'
);

-- ===========================================================================
-- INSTALACIÓN (5)
-- ===========================================================================

-- 2026-08-17 lunes: candidato 120, aprobar 120 -> permitido
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-17', timestamptz '2026-08-17 07:30-04', timestamptz '2026-08-17 19:30-04',
  'hash-gated-install-mon120', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-17',
  (select id from public.attendance_records where source_hash = 'hash-gated-install-mon120'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  -- Fila técnica de INSTALLATION (max_overtime_minutes=1440, techo de
  -- generación de candidatos, no la autoridad de aprobación real — ver
  -- comentario en la migración 20260818160000).
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-INSTALL-001') and work_date = date '2026-08-17'),
    '40000000-0000-0000-0000-000000000003'
  ),
  'INSTALLATION lunes: 120 min aprobados es permitido'
);

-- 2026-08-18 martes: candidato 200, aprobar 200 -> permitido (sin tope fijo)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-18', timestamptz '2026-08-18 07:30-04', timestamptz '2026-08-18 21:10-04',
  'hash-gated-install-tue200', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-18',
  (select id from public.attendance_records where source_hash = 'hash-gated-install-tue200'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  200,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = 2)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 200, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-INSTALL-001') and work_date = date '2026-08-18'),
    '40000000-0000-0000-0000-000000000003'
  ),
  'INSTALLATION martes: 200 min aprobados (> 120) es permitido — sin límite fijo automático'
);

-- Cantidad exacta conservada.
select is(
  (select approved_minutes from public.overtime_decisions od
     join public.overtime_records ovr on ovr.id = od.overtime_record_id
     where ovr.employee_id = (select id from public.employees where external_workera_id = 'GATED-INSTALL-001')
       and ovr.work_date = date '2026-08-18' and od.is_current),
  200,
  'INSTALLATION: approved_minutes conserva la cantidad exacta decidida por el supervisor (200)'
);

-- 2026-08-22 sábado (fin de semana): candidato 250, aprobar 250 -> permitido
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-22', timestamptz '2026-08-22 08:00-04', timestamptz '2026-08-22 16:10-04',
  'hash-gated-install-sat250', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-22',
  (select id from public.attendance_records where source_hash = 'hash-gated-install-sat250'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  250,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = 6)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 250, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-INSTALL-001') and work_date = date '2026-08-22'),
    '40000000-0000-0000-0000-000000000003'
  ),
  'INSTALLATION fin de semana: 250 min aprobados es permitido'
);

-- Supervisor NO asignado (SUPERVISOR_PRODUCTION) no puede aprobar horas de INSTALLATION.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-19', timestamptz '2026-08-19 07:30-04', timestamptz '2026-08-19 19:30-04',
  'hash-gated-install-idor', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-INSTALL-001'),
  date '2026-08-19',
  (select id from public.attendance_records where source_hash = 'hash-gated-install-idor'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = 3)
);
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED-INSTALL-001') and work_date = date '2026-08-19'),
    '40000000-0000-0000-0000-000000000002'
  ),
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede aprobar horas extra de un trabajador de INSTALLATION (IDOR)'
);
reset role;

-- Trabajador autenticado sin rol no puede aprobar horas extra de nadie. El ID
-- se resuelve ANTES de cambiar de rol: un usuario sin rol falla
-- is_corporate_user(), por lo que ni siquiera podría LEER overtime_records
-- para construir la consulta (RLS deniega el SELECT, no solo el INSERT) —
-- eso probaría una condición distinta a la que este caso busca aislar.
select id as gated_install_idor_record_id from public.overtime_records
  where employee_id = (select id from public.employees where external_workera_id = 'GATED-INSTALL-001')
    and work_date = date '2026-08-19' \gset

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000004'; -- sin rol
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    :'gated_install_idor_record_id',
    '40000000-0000-0000-0000-000000000004'
  ),
  -- P0001, no 42501: validate_overtime_decision() corre SECURITY INVOKER (sin
  -- cambios respecto al original) y su propia lectura de overtime_records ya
  -- es denegada por RLS para un usuario sin rol (is_corporate_user()=false) —
  -- el trigger falla con "not found" antes de que la policy de INSERT de
  -- overtime_decisions llegue a evaluarse. Resultado igual de seguro (cero
  -- filas insertadas), código de error distinto al de un supervisor con rol
  -- válido pero fuera de dominio (ver caso IDOR anterior, sí 42501).
  'P0001',
  null,
  'un usuario autenticado sin rol asignado no puede autoaprobarse horas extra de nadie'
);
reset role;

-- ===========================================================================
-- BONO DIARIO AUTOMÁTICO (11)
-- ===========================================================================

-- Rechazo no genera bono (0 aprobado, todo rechazado).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-24', timestamptz '2026-08-24 07:30-04', timestamptz '2026-08-24 09:30-04',
  'hash-gated-bonus-0', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-24',
  (select id from public.attendance_records where source_hash = 'hash-gated-bonus-0'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
-- Gate D (segundo hardening): rechazar dentro del selector binario de
-- Producción lunes-viernes HH50 exige motivo obligatorio.
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by, reason)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-24'),
  0, 60, 'REJECTED', '40000000-0000-0000-0000-000000000002',
  'Trabajador no justificó la permanencia adicional registrada por el sistema.'
);
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-24'),
  0,
  'bono: rechazo total (0 min aprobados) no genera ningún bono'
);

-- 1 min aprobado -> $0.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-25', timestamptz '2026-08-25 07:30-04', timestamptz '2026-08-25 17:01-04',
  'hash-gated-bonus-1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-25',
  (select id from public.attendance_records where source_hash = 'hash-gated-bonus-1'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  1,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-25'),
  1, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-25'),
  0,
  'bono: 1 min aprobado no alcanza el umbral -> $0'
);

-- 60 min aprobado (candidato 60, dentro de la ventana 60-114 del selector
-- binario) -> $0. Reemplaza el fixture original de 119 min: Gate D (segundo
-- hardening) restringe approved_minutes a {0,60,120} para Producción
-- lunes-viernes HH50, así que 119 ya no es un valor de decisión válido — se
-- usa 60 (coincide exactamente con la propuesta automática, sin motivo
-- obligatorio) preservando el mismo objetivo: por debajo de 120 no hay bono.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-26', timestamptz '2026-08-26 07:30-04', timestamptz '2026-08-26 18:30-04',
  'hash-gated-bonus-119', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-26',
  (select id from public.attendance_records where source_hash = 'hash-gated-bonus-119'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 3)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-26'),
  60, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-26'),
  0,
  'bono: 60 min aprobado (< 120) -> $0'
);

-- 120 min ya aprobado en 2026-08-17 (test de límite PRODUCTION) -> $1.000.
select is(
  (select amount from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-17'),
  1000::bigint,
  'bono: 120 min aprobados -> $1.000 (automático)'
);

-- 121 min aprobado -> $1.000.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-05', timestamptz '2026-09-05 07:30-04', timestamptz '2026-09-05 19:31-04',
  'hash-gated-bonus-121', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-05',
  (select id from public.attendance_records where source_hash = 'hash-gated-bonus-121'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  121,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 6) -- 2026-09-05 es sábado
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-09-05'),
  121, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
select is(
  (select amount from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-09-05'),
  1000::bigint,
  'bono: 121 min aprobados -> $1.000 (nunca $1.000 por hora)'
);

-- 180 min aprobado -> $1.000.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-06', timestamptz '2026-09-06 07:30-04', timestamptz '2026-09-06 20:30-04',
  'hash-gated-bonus-180', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-09-06',
  (select id from public.attendance_records where source_hash = 'hash-gated-bonus-180'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  180,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 0) -- 2026-09-06 es domingo
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-09-06'),
  180, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
select is(
  (select amount from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-09-06'),
  1000::bigint,
  'bono: 180 min aprobados -> $1.000'
);

-- 360 min ya aprobado en 2026-08-22 (sábado, test de límite) -> $1.000.
select is(
  (select amount from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-22'),
  1000::bigint,
  'bono: 360 min aprobados -> $1.000 (monto fijo, no proporcional a las horas)'
);

-- Múltiples registros (versionado) que suman/alcanzan 120 -> un solo bono.
-- v1: candidato 80, aprobado 80 (< umbral, sin bono). Se supersede con v2:
-- candidato 120 (recálculo del motor, mismo patrón is_current de siempre),
-- aprobado 120 -> el bono se crea una sola vez.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-31', timestamptz '2026-08-31 07:30-04', timestamptz '2026-08-31 18:50-04',
  'hash-gated-multi-v1', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id, calculation_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-31',
  (select id from public.attendance_records where source_hash = 'hash-gated-multi-v1'),
  (select id from public.overtime_types where code = 'OVERTIME_100'), -- lunes 31 ago 2026
  80,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1),
  1, true
);
-- Gate D (segundo hardening): 2026-08-31 es lunes, PRODUCTION, HH50 (el
-- overtime_type_id propuesto arriba como OVERTIME_100 es sobrescrito por el
-- trigger overtime_records_classify_rate según la fecha real) -> selector
-- binario {0,60,120}. 80 min ya no es aprobable directamente; se usa 60
-- aprobado / 20 rechazado (PARTIALLY_APPROVED, suma = candidato 80),
-- coincide con la propuesta automática de la ventana 60-114 (sin motivo
-- obligatorio) y preserva el mismo objetivo: v1 no alcanza el umbral de
-- bono, v2 (recálculo a 120) sí.
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-31' and is_current),
  60, 20, 'PARTIALLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
-- Recálculo: v1 deja de ser vigente, v2 la reemplaza (mismo patrón ya
-- establecido en Fase 2A — un recálculo crea una fila nueva).
update public.overtime_records set is_current = false
  where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
    and work_date = date '2026-08-31' and calculation_version = 1;
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id, calculation_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-PROD-001'),
  date '2026-08-31',
  (select id from public.attendance_records where source_hash = 'hash-gated-multi-v1'),
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1),
  2, true
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-31' and is_current),
  120, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000002'
);
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-31'),
  1,
  'bono: múltiples registros versionados del mismo día (recálculo) generan exactamente un solo bono'
);

-- Corrección bajo 120 antes del cierre -> el bono se retira. ADMIN_RRHH
-- desactiva la decisión de 120 min de 2026-08-17 e inserta una corrección de
-- 60 min -> el bono automático generado antes desaparece.
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000001'; -- ADMIN_RRHH
update public.overtime_decisions set is_current = false
  where overtime_record_id = (
    select id from public.overtime_records where employee_id =
      (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-17'
  );
-- Gate D (segundo hardening): reducir una propuesta de 120 (candidato=120,
-- ventana 118-120) a 60 aprobados exige motivo obligatorio.
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by, reason)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-08-17'),
  60, 60, 'PARTIALLY_APPROVED', '40000000-0000-0000-0000-000000000001',
  'Corrección administrativa: revisión posterior determinó que solo corresponden 60 minutos.'
);
reset role;
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-PROD-001')
       and work_date = date '2026-08-17'),
  0,
  'bono: corrección bajo 120 min antes del cierre retira el bono ya otorgado'
);

-- Período cerrado -> la corrección/recomputación falla (no muta en silencio).
-- Se usa el día 2026-09-05 (bono ya otorgado, 121 min) dentro de un
-- reporting_period CLOSED.
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000001'; -- ADMIN_RRHH
insert into public.reporting_periods (period_start, period_end, status, closed_by, closed_at)
values (date '2026-09-05', date '2026-09-05', 'CLOSED', '40000000-0000-0000-0000-000000000001', now());

select throws_ok(
  $$ update public.overtime_decisions set is_current = false
       where overtime_record_id = (
         select id from public.overtime_records where employee_id =
           (select id from public.employees where external_workera_id = 'GATED-PROD-001') and work_date = date '2026-09-05'
       ) $$,
  'P0001',
  null,
  'bono: recomputación se rechaza (no muta) si el work_date cae en un reporting_period CLOSED'
);
reset role;

-- INSTALLATION recibe bono automático (120 min aprobados el 2026-08-17).
select is(
  (select amount from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-INSTALL-001')
       and work_date = date '2026-08-17'),
  1000::bigint,
  'bono: INSTALLATION también recibe el bono automático de $1.000 con 120 min aprobados'
);

-- ADMINISTRATION no recibe bono (sin regla explícita) aunque exista una
-- decisión con minutos altos referenciando una overtime_policy técnica.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED-ADMIN-001'),
  date '2026-08-17', timestamptz '2026-08-17 07:30-04', timestamptz '2026-08-17 19:30-04',
  'hash-gated-admin-nobonus', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED-ADMIN-001'),
  date '2026-08-17',
  (select id from public.attendance_records where source_hash = 'hash-gated-admin-nobonus'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED-ADMIN-001') and work_date = date '2026-08-17'),
  120, 0, 'FULLY_APPROVED', '40000000-0000-0000-0000-000000000001'
);
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED-ADMIN-001')),
  0,
  'bono: ADMINISTRATION no recibe bono automático (sin regla explícita confirmada)'
);

-- ===========================================================================
-- CÓDIGO "R" DESACTIVADO (4)
-- ===========================================================================

select is(
  (select active from public.attendance_statuses where code = 'R'),
  false,
  'attendance_statuses: el código R queda inactivo tras Gate D'
);

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values ('GATED-R-001', 'Fixture', 'RCode', 'Fixture RCode', (select id from public.employee_groups where code = 'PRODUCTION'));

select throws_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, source_hash, created_by)
       values (%L, date '2026-08-10', %L, 'manual', 'hash-gated-r-new', '40000000-0000-0000-0000-000000000001') $$,
    (select id from public.employees where external_workera_id = 'GATED-R-001'),
    (select id from public.attendance_statuses where code = 'R')
  ),
  'P0001',
  null,
  'attendance_status_records: una asignación NUEVA del código R es rechazada'
);

select is(
  (select count(*)::int from public.attendance_statuses),
  11,
  'attendance_statuses: los 11 códigos siguen existiendo (R desactivado, no eliminado)'
);

select is(
  (select category from public.attendance_statuses where code = 'R'),
  'RECOVERY',
  'attendance_statuses: el catálogo de R permanece íntegro (category=RECOVERY), FK resoluble'
);

-- ===========================================================================
-- ACL / RLS DE HOLIDAYS Y FUNCIONES INTERNAS (6)
-- ===========================================================================

set local role anon;
select throws_ok($$ select 1 from public.holidays $$, '42501', null,
  'anon: SELECT holidays es denegado (sin GRANT)');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000001'; -- ADMIN_RRHH
select lives_ok(
  $$ insert into public.holidays (holiday_date, name, created_by)
     values (date '2028-02-15', 'Feriado fixture ACL', '40000000-0000-0000-0000-000000000001') $$,
  'ADMIN_RRHH puede crear un feriado'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION
select throws_ok(
  $$ insert into public.holidays (holiday_date, name) values (date '2026-12-26', 'Intento no autorizado') $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede crear un feriado (solo ADMIN_RRHH)'
);
reset role;

select is(
  has_function_privilege('public', 'recompute_employee_daily_bonus(uuid,date)', 'EXECUTE'),
  false,
  'funciones internas: PUBLIC no tiene EXECUTE sobre recompute_employee_daily_bonus'
);

select is(
  has_table_privilege('authenticated', 'public.holidays', 'TRUNCATE'),
  false,
  'grants: authenticated NO tiene TRUNCATE sobre holidays'
);

select is(
  has_table_privilege('authenticated', 'public.holidays', 'DELETE'),
  false,
  'grants: authenticated NO tiene DELETE sobre holidays (desactivar preserva mejor el historial)'
);

select * from finish();
rollback;
