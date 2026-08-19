-- pgTAP Fase 7: motor de reglas de asistencia -- exención de control
-- horario, salida anticipada + flujo médico, documento obligatorio de
-- licencia, cumpleaños, y que las columnas nuevas no relajaron RLS/grants
-- existentes.
create extension if not exists pgtap;

begin;
select plan(25);

-- ---------------------------------------------------------------------------
-- Fixtures
insert into public.profiles (id, display_name, role) values
  ('96000000-0000-0000-0000-000000000001', 'Fixture 7 RRHH', 'ADMIN_RRHH'),
  ('96000000-0000-0000-0000-000000000002', 'Fixture 7 Supervisor Prod', 'SUPERVISOR_PRODUCTION'),
  ('96000000-0000-0000-0000-000000000003', 'Fixture 7 Supervisor Install', 'SUPERVISOR_INSTALLATION');

insert into public.employees (id, external_workera_id, first_name, last_name, display_name, employee_group_id)
values
  ('96000000-0000-0000-0000-00000000a001', 'S7-PROD-001', 'Fixture', 'Prod7', 'Fixture Prod7',
    (select id from public.employee_groups where code = 'PRODUCTION')),
  ('96000000-0000-0000-0000-00000000a002', 'S7-INSTALL-001', 'Fixture', 'Install7', 'Fixture Install7',
    (select id from public.employee_groups where code = 'INSTALLATION'));

-- ---------------------------------------------------------------------------
-- 1) employee_time_control_policies
select throws_ok(
  $$ insert into public.employee_time_control_policies (employee_id, policy_code, effective_from, created_by)
     values ('96000000-0000-0000-0000-00000000a001', 'EXEMPT_FROM_TIME_CONTROL', '2026-01-01', '96000000-0000-0000-0000-000000000001') $$,
  '23514',
  null,
  'EXEMPT_FROM_TIME_CONTROL sin legal_basis es rechazado'
);

select lives_ok(
  $$ insert into public.employee_time_control_policies (employee_id, policy_code, legal_basis, effective_from, created_by)
     values ('96000000-0000-0000-0000-00000000a001', 'EXEMPT_FROM_TIME_CONTROL', 'NO_MARKING_REQUIRED', '2026-01-01', '96000000-0000-0000-0000-000000000001') $$,
  'EXEMPT_FROM_TIME_CONTROL con legal_basis es aceptado'
);

select throws_ok(
  $$ insert into public.employee_time_control_policies (employee_id, policy_code, effective_from, created_by)
     values ('96000000-0000-0000-0000-00000000a001', 'NORMAL', '2026-06-01', '96000000-0000-0000-0000-000000000001') $$,
  '23P01',
  null,
  'una segunda política vigente para el mismo trabajador en un rango solapado es rechazada (exclusion constraint)'
);

-- ---------------------------------------------------------------------------
-- 2) attendance_records + early_departure_records/decisions
insert into public.attendance_records (id, employee_id, work_date, actual_clock_in, actual_clock_out, source, source_hash)
values ('96000000-0000-0000-0000-00000000c001', '96000000-0000-0000-0000-00000000a001', '2026-08-20',
  '2026-08-20 07:30:00-04', '2026-08-20 15:00:00-04', 'manual', 'p7-hash-1');

insert into public.early_departure_records (id, employee_id, work_date, attendance_record_id, scheduled_end, actual_end, detected_minutes)
values ('96000000-0000-0000-0000-00000000d001', '96000000-0000-0000-0000-00000000a001', '2026-08-20',
  '96000000-0000-0000-0000-00000000c001', '17:00:00', '2026-08-20 15:00:00-04', 120);

select throws_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d001', 'MEDICAL', false, 0, 'NEEDS_REVIEW', '96000000-0000-0000-0000-000000000001') $$,
  null, 'reason_category=MEDICAL requiere document_required=true (PASO 18 del encargo)',
  'MEDICAL sin document_required=true es rechazado'
);

select throws_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, document_deadline, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d001', 'MEDICAL', true, '2026-08-25', 120, 'DO_NOT_DEDUCT', '96000000-0000-0000-0000-000000000001') $$,
  null, null,
  'MEDICAL DO_NOT_DEDUCT sin documento adjunto es rechazado'
);

select lives_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, document_deadline, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d001', 'MEDICAL', true, '2026-08-25', 120, 'NEEDS_REVIEW', '96000000-0000-0000-0000-000000000001') $$,
  'MEDICAL NEEDS_REVIEW (pendiente) sin documento es aceptado -- solo DO_NOT_DEDUCT lo exige'
);

insert into public.supporting_documents (employee_id, early_departure_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
values ('96000000-0000-0000-0000-00000000a001', '96000000-0000-0000-0000-00000000d001', 'MEDICAL_CERTIFICATE',
  'x/y.pdf', 'application/pdf', 'doc.pdf', '96000000-0000-0000-0000-000000000001');

update public.early_departure_decisions set is_current = false where early_departure_record_id = '96000000-0000-0000-0000-00000000d001';

select lives_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, document_deadline, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d001', 'MEDICAL', true, '2026-08-25', 120, 'DO_NOT_DEDUCT', '96000000-0000-0000-0000-000000000001') $$,
  'MEDICAL DO_NOT_DEDUCT con documento adjunto es aceptado'
);

insert into public.early_departure_records (id, employee_id, work_date, attendance_record_id, scheduled_end, actual_end, detected_minutes, calculation_version)
values ('96000000-0000-0000-0000-00000000d002', '96000000-0000-0000-0000-00000000a001', '2026-08-21',
  '96000000-0000-0000-0000-00000000c001', '17:00:00', '2026-08-21 16:50:00-04', 10, 1);

select throws_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d002', 'UNJUSTIFIED', false, 11, 'DEDUCT', '96000000-0000-0000-0000-000000000001') $$,
  null, null,
  'payroll_minutes no puede exceder detected_minutes'
);

select throws_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d002', 'BIRTHDAY_AUTHORIZED', false, 0, 'DEDUCT', '96000000-0000-0000-0000-000000000001') $$,
  null, 'reason_category=BIRTHDAY_AUTHORIZED debe tener payroll_effect=DO_NOT_DEDUCT (PASO 31: deduction=0)',
  'BIRTHDAY_AUTHORIZED exige payroll_effect=DO_NOT_DEDUCT'
);

select lives_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d002', 'BIRTHDAY_AUTHORIZED', false, 0, 'DO_NOT_DEDUCT', '96000000-0000-0000-0000-000000000001') $$,
  'BIRTHDAY_AUTHORIZED con DO_NOT_DEDUCT y payroll_minutes=0 es aceptado'
);

-- ---------------------------------------------------------------------------
-- 3) absence_decisions: documento obligatorio de licencia
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by)
values ('96000000-0000-0000-0000-00000000b001', '96000000-0000-0000-0000-00000000a001',
  (select id from public.absence_types where code = 'MEDICAL_LEAVE'), '2026-08-20', '2026-08-22', 'manual', 'p7-abs-1', '96000000-0000-0000-0000-000000000001');

select lives_ok(
  $$ insert into public.absence_decisions (absence_record_id, decision_status, document_required, document_deadline, decided_by)
     values ('96000000-0000-0000-0000-00000000b001', 'PENDING_DOCUMENT', true, '2026-08-25', '96000000-0000-0000-0000-000000000001') $$,
  'PENDING_DOCUMENT sin documento adjunto es aceptado (estado intermedio esperado)'
);

update public.absence_decisions set is_current = false where absence_record_id = '96000000-0000-0000-0000-00000000b001';

select throws_ok(
  $$ insert into public.absence_decisions (absence_record_id, decision_status, document_required, document_deadline, decided_by)
     values ('96000000-0000-0000-0000-00000000b001', 'CONFIRMED', true, '2026-08-25', '96000000-0000-0000-0000-000000000001') $$,
  null, null,
  'CONFIRMED con document_required=true sin documento adjunto es rechazado (PASO 22: nunca cerrar licencia sin respaldo)'
);

insert into public.supporting_documents (employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
values ('96000000-0000-0000-0000-00000000a001', '96000000-0000-0000-0000-00000000b001', 'MEDICAL_CERTIFICATE',
  'x/z.pdf', 'application/pdf', 'doc2.pdf', '96000000-0000-0000-0000-000000000001');

select lives_ok(
  $$ insert into public.absence_decisions (absence_record_id, decision_status, document_required, document_deadline, decided_by)
     values ('96000000-0000-0000-0000-00000000b001', 'CONFIRMED', true, '2026-08-25', '96000000-0000-0000-0000-000000000001') $$,
  'CONFIRMED con documento ya adjunto es aceptado'
);

-- ---------------------------------------------------------------------------
-- 4) employee_birthdays
select throws_ok(
  $$ insert into public.employee_birthdays (employee_id, birth_month, birth_day)
     values ('96000000-0000-0000-0000-00000000a002', 2, 30) $$,
  '23514',
  null,
  '29 de febrero es el máximo válido -- 30/31 de febrero se rechaza'
);
select lives_ok(
  $$ insert into public.employee_birthdays (employee_id, birth_month, birth_day)
     values ('96000000-0000-0000-0000-00000000a002', 2, 29) $$,
  'el 29 de febrero SÍ es válido (año de nacimiento deliberadamente no se almacena, PASO 28)'
);
select throws_ok(
  $$ insert into public.employee_birthdays (employee_id, birth_month, birth_day)
     values ('96000000-0000-0000-0000-00000000a001', 13, 1) $$,
  '23514',
  null,
  'birth_month fuera de 1-12 es rechazado'
);

-- ---------------------------------------------------------------------------
-- 5) Grants: authenticated tiene lo esperado en las tablas nuevas (no ninguno, no todo).
select ok(
  has_table_privilege('authenticated', 'public.early_departure_records', 'SELECT'),
  'authenticated puede leer early_departure_records (hecho calculado, lectura amplia)'
);
select ok(
  not has_table_privilege('authenticated', 'public.early_departure_records', 'INSERT'),
  'authenticated NO puede escribir early_departure_records directamente (solo el motor server-only)'
);
select ok(
  has_table_privilege('authenticated', 'public.early_departure_decisions', 'INSERT'),
  'authenticated puede insertar early_departure_decisions (scoped por RLS a can_manage_employee)'
);
select ok(
  has_table_privilege('authenticated', 'public.employee_birthdays', 'SELECT'),
  'authenticated puede leer employee_birthdays'
);
select ok(
  not has_table_privilege('anon', 'public.employee_birthdays', 'SELECT'),
  'anon no tiene ningún privilegio sobre employee_birthdays'
);

-- ---------------------------------------------------------------------------
-- 6) RLS: un supervisor de Producción no puede escribir una decisión de un
--    trabajador de Instalación (área scoping aplicado a nivel de escritura,
--    mismo patrón ya establecido desde Fase 3 para late_arrival_decisions).
insert into public.attendance_records (id, employee_id, work_date, actual_clock_in, actual_clock_out, source, source_hash)
values ('96000000-0000-0000-0000-00000000c002', '96000000-0000-0000-0000-00000000a002', '2026-08-20',
  '2026-08-20 07:30:00-04', '2026-08-20 15:00:00-04', 'manual', 'p7-hash-2');
insert into public.early_departure_records (id, employee_id, work_date, attendance_record_id, scheduled_end, actual_end, detected_minutes)
values ('96000000-0000-0000-0000-00000000d003', '96000000-0000-0000-0000-00000000a002', '2026-08-20',
  '96000000-0000-0000-0000-00000000c002', '17:00:00', '2026-08-20 16:00:00-04', 60);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000002'; -- SUPERVISOR_PRODUCTION

select throws_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d003', 'UNJUSTIFIED', false, 60, 'DEDUCT', '96000000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede crear una early_departure_decision para un trabajador de INSTALLATION'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000003'; -- SUPERVISOR_INSTALLATION

select lives_ok(
  $$ insert into public.early_departure_decisions (early_departure_record_id, reason_category, document_required, payroll_minutes, payroll_effect, decided_by)
     values ('96000000-0000-0000-0000-00000000d003', 'UNJUSTIFIED', false, 60, 'DEDUCT', '96000000-0000-0000-0000-000000000003') $$,
  'SUPERVISOR_INSTALLATION SÍ puede crear una early_departure_decision para su propio trabajador de INSTALLATION'
);

-- ---------------------------------------------------------------------------
-- 7) Inmutabilidad: is_current es la única columna mutable en las tablas
--    nuevas. early_departure_records no tiene NINGÚN grant de escritura para
--    `authenticated` (ni siquiera ADMIN_RRHH) -- se prueba directamente
--    contra service_role, la única vía de escritura, para llegar realmente
--    al trigger de inmutabilidad (mismo patrón que 025 con
--    workera_attendance_events).
reset role;
set local role service_role;

select throws_ok(
  $$ update public.early_departure_records set detected_minutes = 999 where id = '96000000-0000-0000-0000-00000000d001' $$,
  'P0001',
  null,
  'early_departure_records es inmutable salvo is_current, incluso para service_role'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000001'; -- ADMIN_RRHH

select throws_ok(
  $$ update public.early_departure_decisions set payroll_minutes = 0 where early_departure_record_id = '96000000-0000-0000-0000-00000000d001' and is_current $$,
  'P0001',
  null,
  'early_departure_decisions es inmutable salvo is_current'
);

select * from finish();
rollback;
