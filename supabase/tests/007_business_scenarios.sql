-- pgTAP: casos de negocio conceptuales (fixtures ficticios, sin datos reales de
-- trabajadores ni del Excel real). Demuestra que el esquema puede representar
-- los escenarios de docs/BUSINESS_RULES_PRE_PHASE2.md — el cálculo automático
-- (motor de overtime/atrasos) es una fase futura; aquí se insertan los valores
-- ya calculados a mano, como haría ese motor, y se valida que la base los acepta
-- y aplica las constraints correctas.
create extension if not exists pgtap;

begin;
select plan(7);

insert into public.profiles (display_name, role) values ('Fixture Supervisor Escenarios', 'SUPERVISOR_PRODUCTION');

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST-SCN-PROD-001', 'Fixture', 'Produccion', 'Fixture Produccion',
  (select id from public.employee_groups where code = 'PRODUCTION')
);
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST-SCN-ADMIN-001', 'Fixture', 'Administracion', 'Fixture Administracion',
  (select id from public.employee_groups where code = 'ADMINISTRATION')
);

-- ---------------------------------------------------------------------------
-- Caso 1: Producción, salida 19:00 lunes -> candidato 120 (tope de la política)
-- raw = 19:00 - 17:00 = 120; candidate = MAX(0, MIN(120, 120)) = 120
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:00-04',
  'hash-scn-prod-1900', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-scn-prod-1900'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select is(
  (select candidate_minutes from public.overtime_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and work_date = date '2026-08-10'),
  120,
  'Producción: salida 19:00 -> candidato 120 (tope de política) se representa correctamente'
);

-- ---------------------------------------------------------------------------
-- Caso 2: Producción, salida 19:45 (real, conservada) -> candidato sigue siendo
-- 120, no 165 (docs/BUSINESS_RULES_PRE_PHASE2.md sección 7 — clock-out tardío
-- por permanecer en instalaciones no se traduce 1:1 en horas extra).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-11', timestamptz '2026-08-11 07:30-04', timestamptz '2026-08-11 19:45-04',
  'hash-scn-prod-1945', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-11',
  (select id from public.attendance_records where source_hash = 'hash-scn-prod-1945'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
select results_eq(
  $$ select actual_clock_out from public.attendance_records where source_hash = 'hash-scn-prod-1945' $$,
  $$ values (timestamptz '2026-08-11 19:45-04') $$,
  'attendance_records conserva el clock_out real (19:45) sin recortarlo'
);
select is(
  (select candidate_minutes from public.overtime_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and work_date = date '2026-08-11'),
  120,
  'overtime_records: candidato queda topado en 120 aunque clock_out real sea 19:45'
);

-- ---------------------------------------------------------------------------
-- Caso 3: Administración, salida 19:30 -> sin OvertimeRecord (no elegible)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-ADMIN-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 19:30-04',
  'hash-scn-admin-1930', 1, true
);
-- No se inserta ningún overtime_record: Administración no es elegible (sección 5).
select is(
  (select count(*)::int from public.overtime_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-ADMIN-001')),
  0,
  'Administración: clock_out 19:30 no genera ningún overtime_record'
);

-- ---------------------------------------------------------------------------
-- Caso 4: atraso justificado -> detected=15, payroll=0 (ya cubierto en detalle
-- por 005_late_arrival.sql; aquí solo se confirma el flujo end-to-end con
-- decided_by y payroll_effect coherentes).
insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-scn-prod-1900'),
  time '07:30', timestamptz '2026-08-10 07:45-04', 15,
  (select lap.id from public.late_arrival_policies lap join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'PRODUCTION' and lap.day_of_week = 1)
);
insert into public.late_arrival_decisions
  (late_arrival_record_id, justified, payroll_minutes, payroll_effect, reason, decided_by)
values (
  (select id from public.late_arrival_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and work_date = date '2026-08-10'),
  true, 0, 'DO_NOT_DEDUCT', 'Cita médica, boleta adjunta',
  (select id from public.profiles where display_name = 'Fixture Supervisor Escenarios')
);
select is(
  (select payroll_minutes from public.late_arrival_decisions lad
     join public.late_arrival_records lar on lar.id = lad.late_arrival_record_id
     where lar.employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and lar.work_date = date '2026-08-10'),
  0,
  'atraso detectado=15, justificado -> payroll_minutes=0'
);

-- ---------------------------------------------------------------------------
-- Caso 5: Workera cambia la marcación DESPUÉS de una decisión de horas extra ->
-- SYNC_CONFLICT representable sin sobrescribir la decisión original.
--   attendance v1 (19:00) -> overtime_record (120) -> overtime_decision (aprobado 120)
--   llega attendance v2 (18:30) -> v1 se preserva intacta, decision original intacta,
--   daily_review pasa a SYNC_CONFLICT.
insert into public.overtime_decisions
  (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
values (
  (select id from public.overtime_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and work_date = date '2026-08-10'),
  120, 0, 'FULLY_APPROVED',
  (select id from public.profiles where display_name = 'Fixture Supervisor Escenarios')
);

-- Workera corrige el clock_out de ese día a las 18:30 (90 min de exceso, no 120)
update public.attendance_records set is_current = false
  where source_hash = 'hash-scn-prod-1900';
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:30-04', timestamptz '2026-08-10 18:30-04',
  'hash-scn-prod-1900-v2', 2, true
);

insert into public.daily_reviews (employee_id, work_date, status)
values (
  (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001'),
  date '2026-08-10', 'SYNC_CONFLICT'
);

select is(
  (select decision_status from public.overtime_decisions od
     join public.overtime_records ovr on ovr.id = od.overtime_record_id
     where ovr.employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and ovr.work_date = date '2026-08-10'),
  'FULLY_APPROVED',
  'la OvertimeDecision original (aprobado 120) NO se modifica cuando Workera corrige la marcación después'
);
select is(
  (select status from public.daily_reviews
     where employee_id = (select id from public.employees where external_workera_id = 'TEST-SCN-PROD-001')
       and work_date = date '2026-08-10'),
  'SYNC_CONFLICT',
  'DailyReview refleja SYNC_CONFLICT cuando Workera cambia un hecho después de una decisión'
);

select * from finish();
rollback;
