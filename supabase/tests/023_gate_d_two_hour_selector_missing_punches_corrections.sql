-- pgTAP Gate D (segundo hardening): matriz exacta del selector binario de
-- Producción (lunes-viernes, HH50), autorización exclusiva, Instalación con
-- minutos exactos, límites de fin de semana/feriado, bono no duplicado,
-- marcaciones faltantes (red flag + bloqueo de aprobación + resolución vía
-- corrección autorizada), attendance_corrections (motivo/rol/historial/
-- período cerrado/preservación del crudo), y R desactivado por UPDATE/upsert.
create extension if not exists pgtap;

begin;
select plan(49);

-- ---------------------------------------------------------------------------
-- Fixtures base
insert into public.profiles (id, display_name, role) values
  ('50000000-0000-0000-0000-000000000001', 'Fixture Admin GateD2', 'ADMIN_RRHH'),
  ('50000000-0000-0000-0000-000000000002', 'Fixture Supervisor Prod GateD2', 'SUPERVISOR_PRODUCTION'),
  ('50000000-0000-0000-0000-000000000003', 'Fixture Supervisor Install GateD2', 'SUPERVISOR_INSTALLATION'),
  ('50000000-0000-0000-0000-000000000004', 'Fixture Trabajador Sin Rol GateD2', null);

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values
  ('GATED2-PROD-001', 'Fixture', 'ProdD2', 'Fixture ProdD2', (select id from public.employee_groups where code = 'PRODUCTION')),
  ('GATED2-INSTALL-001', 'Fixture', 'InstallD2', 'Fixture InstallD2', (select id from public.employee_groups where code = 'INSTALLATION'));

-- Helper repetido para crear attendance_record + overtime_record candidato,
-- con marcación COMPLETA (necesaria para que la decisión no quede bloqueada
-- por el guard de marcación incompleta, sección G más abajo).
-- ===========================================================================
-- A. MATRIZ EXACTA DE PRODUCCIÓN LUNES-VIERNES HH50 (14)
-- ===========================================================================

-- A1: candidato 59 (< 60) -> "no inventar una hora aprobable": sin
-- constraint binario, se aprueba el valor exacto por la vía genérica.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-05', timestamptz '2026-10-05 07:30-03', timestamptz '2026-10-05 17:29-03',
  'hash-g2-59', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-05',
  (select id from public.attendance_records where source_hash = 'hash-g2-59'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  59,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 59, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-05'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'Matriz: candidato 59 min (< 60) se aprueba por la vía genérica, sin selector binario'
);
select is(
  (select system_proposed_minutes from public.overtime_decisions od
     join public.overtime_records ovr on ovr.id = od.overtime_record_id
     where ovr.employee_id = (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
       and ovr.work_date = date '2026-10-05'),
  null::integer,
  'Matriz: candidato 59 min no genera propuesta automática (NULL, no se inventa una hora aprobable)'
);

-- A2: candidato 60 -> aprobar 60 permitido, sin motivo.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-06', timestamptz '2026-10-06 07:30-03', timestamptz '2026-10-06 18:30-03',
  'hash-g2-60', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-06',
  (select id from public.attendance_records where source_hash = 'hash-g2-60'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-06'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'Matriz: candidato 60 min, aprobar 60 permitido sin motivo'
);

-- A3: candidato 60 -> intentar aprobar 120 rechazado (excede el candidato real).
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-06'),
    '50000000-0000-0000-0000-000000000001'
  ),
  'P0001', null,
  'Matriz: candidato 60 min, aprobar 120 es rechazado (excede el candidato real, no está en ventana de redondeo)'
);

-- A4: candidato 90 -> intentar aprobar 90 (no está en {0,60,120}) rechazado.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-07', timestamptz '2026-10-07 07:30-03', timestamptz '2026-10-07 19:00-03',
  'hash-g2-90', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-07',
  (select id from public.attendance_records where source_hash = 'hash-g2-90'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  90,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 3)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 90, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-07'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Matriz: 90 min no es un valor de decisión válido (solo 0, 60 o 120) para Producción lunes-viernes HH50'
);

-- A5: candidato 115 (ventana de revisión obligatoria), aprobar 120 SIN
-- motivo -> rechazado.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-08', timestamptz '2026-10-08 07:30-03', timestamptz '2026-10-08 19:25-03',
  'hash-g2-115', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-08',
  (select id from public.attendance_records where source_hash = 'hash-g2-115'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  115,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 4)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-08'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Matriz: candidato 115 min, aprobar 120 sin motivo es rechazado (excepción exige motivo obligatorio)'
);

-- A6: mismo caso CON motivo -> permitido (redondeo excepcional), y marca
-- requires_manual_review = true.
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by, reason)
       values (%L, 120, 0, 'FULLY_APPROVED', %L, 'Aprobación excepcional: 115 min reales, se completan las 2 horas.') $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-08'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'Matriz: candidato 115 min, aprobar 120 CON motivo es permitido (redondeo excepcional)'
);
select is(
  (select requires_manual_review from public.overtime_decisions od
     join public.overtime_records ovr on ovr.id = od.overtime_record_id
     where ovr.employee_id = (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
       and ovr.work_date = date '2026-10-08'),
  true,
  'Matriz: candidato 115 min queda marcado requires_manual_review = true'
);

-- A7: candidato 118, aprobar 120 (coincide con la propuesta) -> permitido
-- sin motivo, requires_manual_review = false.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-09', timestamptz '2026-10-09 07:30-03', timestamptz '2026-10-09 19:28-03',
  'hash-g2-118', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-09',
  (select id from public.attendance_records where source_hash = 'hash-g2-118'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  118,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 5)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-09'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'Matriz: candidato 118 min, aprobar 120 (coincide con propuesta) permitido sin motivo'
);
select is(
  (select requires_manual_review from public.overtime_decisions od
     join public.overtime_records ovr on ovr.id = od.overtime_record_id
     where ovr.employee_id = (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
       and ovr.work_date = date '2026-10-09'),
  false,
  'Matriz: candidato 118 min NO requiere revisión obligatoria (solo 115-117)'
);

-- A8: candidato 119 (ventana 118-120, propuesta 120), aprobar 60 SIN motivo
-- -> rechazado (reduce la propuesta de 120). Registro fresco (2026-10-19,
-- lunes) para no chocar con la decisión vigente ya creada en A7.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-19', timestamptz '2026-10-19 07:30-03', timestamptz '2026-10-19 19:29-03',
  'hash-g2-119', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-19',
  (select id from public.attendance_records where source_hash = 'hash-g2-119'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  119,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 59, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-19'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Matriz: candidato 119 min, aprobar 60 sin motivo es rechazado (reduce la propuesta de 120)'
);

-- A9: candidato 121 (> 120), aprobar 120 -> permitido sin motivo (dato real
-- se conserva, máximo aprobable sigue 120).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-12', timestamptz '2026-10-12 07:30-03', timestamptz '2026-10-12 19:31-03',
  'hash-g2-121', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-12',
  (select id from public.attendance_records where source_hash = 'hash-g2-121'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  121,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 120, 1, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-12'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'Matriz: candidato 121 min (> 120), aprobar 120 permitido sin motivo (dato real conservado, tope 120)'
);
select is(
  (select candidate_minutes from public.overtime_records where employee_id =
     (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-12'),
  121,
  'Matriz: candidate_minutes conserva el dato real (121) aunque el máximo aprobable sea 120'
);

-- A10: candidato 200 (> 120), aprobar 60 SIN motivo -> rechazado (reduce la
-- propuesta de 120).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-13', timestamptz '2026-10-13 07:30-03', timestamptz '2026-10-13 21:10-03',
  'hash-g2-200', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-13',
  (select id from public.attendance_records where source_hash = 'hash-g2-200'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  200,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 140, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-13'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Matriz: candidato 200 min, aprobar 60 sin motivo es rechazado (reduce la propuesta de 120)'
);

-- ===========================================================================
-- B. AUTORIZACIÓN EXCLUSIVA (3)
-- ===========================================================================

-- B1: SUPERVISOR_INSTALLATION no puede decidir sobre un trabajador de
-- Producción (fuera de su grupo). Registro fresco (2026-10-18, domingo -> se
-- usa un candidato de 60 min sobre un día CUALQUIERA sin decisión previa;
-- el punto de la prueba es la autorización, no la matriz) para no chocar con
-- la decisión vigente ya creada en A1 sobre 2026-10-05.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-20', timestamptz '2026-10-20 07:30-03', timestamptz '2026-10-20 18:30-03',
  'hash-g2-idor', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-20',
  (select id from public.attendance_records where source_hash = 'hash-g2-idor'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 2)
);
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000003'; -- SUPERVISOR_INSTALLATION
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-20'),
    '50000000-0000-0000-0000-000000000003'
  ),
  '42501', null,
  'Autorización: SUPERVISOR_INSTALLATION no puede decidir horas extra de un trabajador de Producción'
);
reset role;

-- B2: RRHH SÍ puede decidir sobre Producción (control positivo).
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-14', timestamptz '2026-10-14 07:30-03', timestamptz '2026-10-14 18:30-03',
  'hash-g2-rrhh', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-14',
  (select id from public.attendance_records where source_hash = 'hash-g2-rrhh'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 3)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-14'),
    '50000000-0000-0000-0000-000000000001'
  ),
  'Autorización: ADMIN_RRHH puede decidir horas extra de Producción'
);

-- B3: trabajador sin rol no puede autoaprobarse.
select id as gated2_selfapprove_record_id from public.overtime_records
  where employee_id = (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
    and work_date = date '2026-10-14' \gset
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000004'; -- sin rol
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    :'gated2_selfapprove_record_id',
    '50000000-0000-0000-0000-000000000004'
  ),
  'P0001', null,
  'Autorización: un trabajador sin rol no puede autoaprobarse horas extra'
);
reset role;

-- ===========================================================================
-- C. INSTALACIÓN — MINUTOS EXACTOS, SIN SELECTOR BINARIO (1)
-- ===========================================================================
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-INSTALL-001'),
  date '2026-10-05', timestamptz '2026-10-05 07:30-03', timestamptz '2026-10-05 09:47-03',
  'hash-g2-install-137', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-INSTALL-001'),
  date '2026-10-05',
  (select id from public.attendance_records where source_hash = 'hash-g2-install-137'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  137,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = 1)
);
select lives_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 137, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-INSTALL-001') and work_date = date '2026-10-05'),
    '50000000-0000-0000-0000-000000000003'
  ),
  'Instalación: 137 min aprobados exactos (> 120) es permitido — nunca reducido al selector binario'
);

-- ===========================================================================
-- D. SÁBADO HH50 (2)
-- ===========================================================================
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-10', timestamptz '2026-10-10 08:00-03', timestamptz '2026-10-10 14:40-03',
  'hash-g2-sat400', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-10',
  (select id from public.attendance_records where source_hash = 'hash-g2-sat400'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  400,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 6)
);
select is(
  public.classify_overtime_type_id(date '2026-10-10'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  'Sábado 2026-10-10 (sin feriado) clasifica HH50'
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 361, 39, 'PARTIALLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-10'),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Producción sábado: máximo aprobable de 6 horas (360 min) — 361 es rechazado'
);

-- ===========================================================================
-- E. DOMINGO HH100 Y FERIADO ADMINISTRATIVO HH100 (2)
-- ===========================================================================
select is(
  public.classify_overtime_type_id(date '2026-10-11'), -- domingo
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'Domingo 2026-10-11 clasifica HH100'
);

set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000001';
insert into public.holidays (holiday_date, name, created_by) values
  (date '2026-10-14', 'Feriado fixture GateD2 (miércoles)', '50000000-0000-0000-0000-000000000001');
reset role;
select is(
  public.classify_overtime_type_id(date '2026-10-14'),
  (select id from public.overtime_types where code = 'OVERTIME_100'),
  'Feriado administrativo (miércoles 2026-10-14) clasifica HH100 aunque sea día de semana'
);

-- ===========================================================================
-- F. BONO — NO DUPLICADO BAJO REINTENTO (1)
-- ===========================================================================
-- La decisión de 120 min de A7 (candidato 118, 2026-10-09) ya generó un bono
-- automático. Reintentar recompute_employee_daily_bonus manualmente para el
-- mismo trabajador+fecha (idempotencia, sin nuevo INSERT/UPDATE en
-- overtime_decisions) no debe duplicar el bono.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000001';
select throws_ok(
  format(
    $$ select public.recompute_employee_daily_bonus(%L, date '2026-10-09') $$,
    (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
  ),
  '42501', null,
  'Bono: recompute_employee_daily_bonus no es invocable directamente por authenticated (sin GRANT, PUBLIC no tiene EXECUTE)'
);
reset role;
select is(
  (select count(*)::int from public.employee_daily_bonuses
     where employee_id = (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
       and work_date = date '2026-10-09'),
  1,
  'Bono: exactamente un bono para 2026-10-09 (idempotencia confirmada, sin duplicados)'
);

-- ===========================================================================
-- G. MARCACIONES FALTANTES (14)
-- ===========================================================================

-- G1: MISSING_CLOCK_IN -> flag creada automáticamente.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-15', null, timestamptz '2026-10-15 17:30-03',
  'hash-g2-missing-in', 1, true
);
select is(
  (select missing_type from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-in')),
  'MISSING_CLOCK_IN'::public.missing_punch_type,
  'Marcación faltante: clock_in nulo genera flag MISSING_CLOCK_IN automáticamente'
);
select is(
  (select status from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-in')),
  'PENDING_CONTACT'::public.missing_punch_status,
  'Marcación faltante: estado inicial es PENDING_CONTACT'
);

-- G2: MISSING_CLOCK_OUT -> flag creada.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-16', timestamptz '2026-10-16 07:30-03', null,
  'hash-g2-missing-out', 1, true
);
select is(
  (select missing_type from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  'MISSING_CLOCK_OUT'::public.missing_punch_type,
  'Marcación faltante: clock_out nulo genera flag MISSING_CLOCK_OUT automáticamente'
);

-- G3: MISSING_BOTH -> flag creada.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-17', null, null,
  'hash-g2-missing-both', 1, true
);
select is(
  (select missing_type from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-both')),
  'MISSING_BOTH'::public.missing_punch_type,
  'Marcación faltante: ambos nulos genera flag MISSING_BOTH automáticamente'
);

-- G4: no se genera flag para una marcación completa.
select is(
  (select count(*)::int from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-60')),
  0,
  'Marcación faltante: una marcación completa NO genera ninguna flag'
);

-- G5: aprobar horas extra sobre una marcación incompleta es bloqueado.
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-16',
  (select id from public.attendance_records where source_hash = 'hash-g2-missing-out'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'PRODUCTION' and op.day_of_week = 5)
);
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id =
       (select id from public.employees where external_workera_id = 'GATED2-PROD-001') and work_date = date '2026-10-16'
       and attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
    '50000000-0000-0000-0000-000000000002'
  ),
  'P0001', null,
  'Marcación faltante: aprobar horas extra sobre un clock_out faltante es bloqueado'
);

-- G6: trabajador sin rol / supervisor incorrecto no puede corregir.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000003'; -- SUPERVISOR_INSTALLATION, no maneja Producción
select throws_ok(
  format(
    $$ insert into public.attendance_corrections
         (attendance_record_id, employee_id, work_date, corrected_clock_out, reason)
       values (%L, %L, date '2026-10-16', timestamptz '2026-10-16 18:15-03', 'Corrección no autorizada') $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-missing-out'),
    (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
  ),
  '42501', null,
  'Corrección: SUPERVISOR_INSTALLATION no puede corregir una marcación de Producción'
);
reset role;

-- G7: motivo vacío es rechazado.
select throws_ok(
  format(
    $$ insert into public.attendance_corrections
         (attendance_record_id, employee_id, work_date, corrected_clock_out, reason)
       values (%L, %L, date '2026-10-16', timestamptz '2026-10-16 18:15-03', '   ') $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-missing-out'),
    (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
  ),
  '23514', null,
  'Corrección: motivo en blanco es rechazado (CHECK reason no vacío)'
);

-- G8: corrección autorizada resuelve la marcación faltante.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION
insert into public.attendance_corrections
  (attendance_record_id, employee_id, work_date, corrected_clock_out, reason)
values (
  (select id from public.attendance_records where source_hash = 'hash-g2-missing-out'),
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-16', timestamptz '2026-10-16 18:30-03',
  'Trabajador confirmó salida a las 18:30, marcación no quedó registrada en Workera.'
);
reset role;
select is(
  (select status from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  'RESOLVED'::public.missing_punch_status,
  'Corrección: una corrección autorizada que completa el dato resuelve la flag automáticamente'
);
select is(
  (select correction_type from public.attendance_corrections
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  'SALIDA',
  'Corrección: correction_type se deriva correctamente como SALIDA (solo corrigió clock_out)'
);
select is(
  (select corrected_by_role from public.attendance_corrections
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  'SUPERVISOR_PRODUCTION'::public.app_role,
  'Corrección: corrected_by_role registra el rol real del autor al momento de corregir'
);

-- G9: el dato crudo original NUNCA se sobrescribe.
select is(
  (select actual_clock_out from public.attendance_records where source_hash = 'hash-g2-missing-out'),
  null::timestamptz,
  'Corrección: attendance_records.actual_clock_out crudo permanece NULL — la corrección nunca sobrescribe el original'
);
select is(
  (select effective_clock_out from public.attendance_effective_punches
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  timestamptz '2026-10-16 18:30-03',
  'Corrección: attendance_effective_punches.effective_clock_out refleja la corrección vigente'
);

-- G10: segunda corrección sobre el mismo hecho requiere que ADMIN_RRHH
-- invalide la vigente primero — el historial se preserva (ninguna se borra).
-- Nota: una policy RLS de UPDATE con solo USING (sin WITH CHECK que se
-- viole) no lanza excepción sobre filas que no matchean — simplemente las
-- excluye del UPDATE (mismo comportamiento ya documentado en
-- 018_admin_override_and_period_security.sql, "el UPDATE no truena, 0 filas
-- afectadas por RLS"). Se verifica con lives_ok + comprobación de que
-- is_current sigue en true, no con throws_ok.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION, no puede invalidar
select lives_ok(
  format(
    $$ update public.attendance_corrections set is_current = false where attendance_record_id = %L $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')
  ),
  'Corrección: el UPDATE de un supervisor no autorizado no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select is_current from public.attendance_corrections
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  true,
  'Corrección: la corrección vigente NO fue invalidada por el intento no autorizado (RLS la excluyó del UPDATE)'
);

set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000001'; -- ADMIN_RRHH
update public.attendance_corrections set is_current = false
  where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out');
insert into public.attendance_corrections
  (attendance_record_id, employee_id, work_date, corrected_clock_out, reason)
values (
  (select id from public.attendance_records where source_hash = 'hash-g2-missing-out'),
  (select id from public.employees where external_workera_id = 'GATED2-PROD-001'),
  date '2026-10-16', timestamptz '2026-10-16 18:45-03',
  'Corrección administrativa: hora exacta confirmada con el jefe de turno, 18:45.'
);
reset role;
select is(
  (select count(*)::int from public.attendance_corrections
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')),
  2,
  'Corrección: el historial completo se preserva (2 filas: la superseded y la vigente), ninguna se borra'
);
select is(
  (select corrected_clock_out from public.attendance_corrections
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-out')
       and is_current),
  timestamptz '2026-10-16 18:45-03',
  'Corrección: la corrección vigente es la más reciente (18:45)'
);

-- G11: período cerrado bloquea una corrección nueva.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000001';
insert into public.reporting_periods (period_start, period_end, status, closed_by, closed_at)
values (date '2026-10-17', date '2026-10-17', 'CLOSED', '50000000-0000-0000-0000-000000000001', now());
select throws_ok(
  format(
    $$ insert into public.attendance_corrections
         (attendance_record_id, employee_id, work_date, corrected_clock_in, corrected_clock_out, reason)
       values (%L, %L, date '2026-10-17', timestamptz '2026-10-17 07:30-03', timestamptz '2026-10-17 17:00-03', 'Corrección tardía sobre período ya cerrado') $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-missing-both'),
    (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
  ),
  'P0001', null,
  'Corrección: se rechaza (no muta) si work_date cae en un reporting_period CLOSED'
);
reset role;

-- G12: corrección bloqueada si ya existe una decisión vigente con minutos
-- aprobados > 0 sobre el mismo hecho (conflicto controlado, sin mutar la
-- decisión existente).
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000002';
select throws_ok(
  format(
    $$ insert into public.attendance_corrections
         (attendance_record_id, employee_id, work_date, corrected_clock_out, reason)
       values (%L, %L, date '2026-10-06', timestamptz '2026-10-06 18:45-03', 'Intento de corregir con decisión activa') $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-60'),
    (select id from public.employees where external_workera_id = 'GATED2-PROD-001')
  ),
  'P0001', null,
  'Corrección: bloqueada por conflicto controlado si el hecho ya tiene una decisión vigente con minutos aprobados'
);
reset role;

-- G13: actor no autorizado no puede avanzar el estado de una flag. Igual que
-- G10, una policy RLS de UPDATE con solo USING no truena sobre filas
-- excluidas: se verifica con lives_ok + comprobación de que el estado no
-- cambió.
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000003'; -- SUPERVISOR_INSTALLATION
select lives_ok(
  format(
    $$ update public.attendance_missing_punch_flags set status = 'CONTACTED' where attendance_record_id = %L $$,
    (select id from public.attendance_records where source_hash = 'hash-g2-missing-in')
  ),
  'Marcación faltante: el UPDATE de un supervisor no autorizado no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select status from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-in')),
  'PENDING_CONTACT'::public.missing_punch_status,
  'Marcación faltante: el estado NO cambió por el intento no autorizado (RLS lo excluyó del UPDATE)'
);

-- G14: actor autorizado SÍ puede avanzar el estado, y contacted_by/at se
-- fuerzan al actor real (nunca un valor de cliente).
set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION
update public.attendance_missing_punch_flags
set status = 'CONTACTED', contacted_by = '50000000-0000-0000-0000-000000000001' -- valor de cliente, debe ignorarse
where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-in');
reset role;
select is(
  (select contacted_by from public.attendance_missing_punch_flags
     where attendance_record_id = (select id from public.attendance_records where source_hash = 'hash-g2-missing-in')),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'Marcación faltante: contacted_by se fuerza al actor real (auth.uid()), ignora el valor enviado por el cliente'
);

-- ===========================================================================
-- H. CÓDIGO "R" — UPDATE Y UPSERT, NO SOLO INSERT (3)
-- ===========================================================================
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values ('GATED2-R-001', 'Fixture', 'RCodeD2', 'Fixture RCodeD2', (select id from public.employee_groups where code = 'PRODUCTION'));

insert into public.attendance_status_records
  (employee_id, work_date, attendance_status_id, source, source_hash, created_by)
values (
  (select id from public.employees where external_workera_id = 'GATED2-R-001'),
  date '2026-10-05',
  (select id from public.attendance_statuses where code = 'P'),
  'manual', 'hash-g2-r-original', '50000000-0000-0000-0000-000000000001'
);

-- H1: UPDATE directo del attendance_status_id hacia R es bloqueado (columna
-- inmutable salvo is_current, protección estructural independiente de R).
select throws_ok(
  format(
    $$ update public.attendance_status_records set attendance_status_id = %L
         where source_hash = 'hash-g2-r-original' $$,
    (select id from public.attendance_statuses where code = 'R')
  ),
  'P0001', null,
  'Código R: UPDATE directo de attendance_status_id hacia R es bloqueado (columna inmutable)'
);

-- H2: UPSERT (INSERT ... ON CONFLICT ... DO UPDATE) hacia R también es
-- bloqueado — la rama INSERT del upsert pasa por el mismo guard de
-- INSERT que un INSERT directo.
select throws_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, source_hash, created_by)
       values (%L, date '2026-10-05', %L, 'manual', 'hash-g2-r-upsert', '50000000-0000-0000-0000-000000000001')
       on conflict (employee_id, work_date) where is_current
       do update set source_hash = excluded.source_hash $$,
    (select id from public.employees where external_workera_id = 'GATED2-R-001'),
    (select id from public.attendance_statuses where code = 'R')
  ),
  'P0001', null,
  'Código R: un upsert que intenta asignar R también es bloqueado'
);

-- H3: el registro histórico original permanece intacto.
select is(
  (select attendance_status_id from public.attendance_status_records where source_hash = 'hash-g2-r-original'),
  (select id from public.attendance_statuses where code = 'P'),
  'Código R: el registro histórico original (P) permanece intacto tras los intentos bloqueados'
);

select * from finish();
rollback;
