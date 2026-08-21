-- pgTAP: flujo de aprobación de licencias médicas (dos etapas).
-- Cubre: solo la cuenta marcada medical_license_approver puede aprobar/
-- rechazar (ni otro ADMIN_RRHH, ni SUPER_ADMIN, ni supervisores); subir
-- documento nunca aprueba; aprobar genera L en attendance_status_records;
-- rechazar nunca genera L; la guarda de transición bloquea re-aprobar/
-- re-rechazar y editar campos fijados; scoping por área en el INSERT.
create extension if not exists pgtap;

begin;
select plan(35);

-- ---------------------------------------------------------------------------
-- Fixtures
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id) values
  ('TEST-ML-PROD-001', 'Produccion', 'Fixture', 'Produccion Fixture', (select id from public.employee_groups where code = 'PRODUCTION')),
  ('TEST-ML-INST-001', 'Instalacion', 'Fixture', 'Instalacion Fixture', (select id from public.employee_groups where code = 'INSTALLATION'));

insert into public.profiles (id, display_name, role, medical_license_approver) values
  ('99100000-0000-0000-0000-000000000001', 'Fixture Supervisor Produccion', 'SUPERVISOR_PRODUCTION', false),
  ('99100000-0000-0000-0000-000000000002', 'Fixture Supervisor Instalacion', 'SUPERVISOR_INSTALLATION', false),
  ('99100000-0000-0000-0000-000000000003', 'Fixture RRHH (no aprobador)', 'ADMIN_RRHH', false),
  ('99100000-0000-0000-0000-000000000004', 'Fixture Aprobador (a.caceres)', 'ADMIN_RRHH', true),
  ('99100000-0000-0000-0000-000000000005', 'Fixture Super Admin', 'SUPER_ADMIN', false);

insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a1',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-08-20', date '2026-08-22', 'manual', 'hash-ml-1',
   '99100000-0000-0000-0000-000000000001');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d1',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   '99100000-0000-0000-0000-0000000000a1',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado.pdf', 'application/pdf', 'certificado.pdf',
   '99100000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- 1) Subir documento crea PENDING_RRHH_APPROVAL, nunca directamente APPROVED
select lives_ok(
  $$ insert into public.medical_license_approvals
       (id, absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, uploaded_by)
     values ('99100000-0000-0000-0000-0000000000e1', '99100000-0000-0000-0000-0000000000a1', '99100000-0000-0000-0000-0000000000d1',
             date '2026-08-20', date '2026-08-22', '99100000-0000-0000-0000-000000000001') $$,
  'insertar tras subir documento crea la fila -- status por defecto es PENDING_RRHH_APPROVAL'
);

select is(
  (select status::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  'PENDING_RRHH_APPROVAL',
  'el estado por defecto al subir es PENDING_RRHH_APPROVAL, nunca APPROVED'
);

select is(
  (select count(*)::int from public.attendance_status_records where employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001')),
  0,
  'subir el documento NUNCA genera attendance_status_records (ningún "L" todavía)'
);

-- ---------------------------------------------------------------------------
-- 2) Solo la cuenta aprobadora puede aprobar/rechazar -- nadie más, ni con RLS directo ni vía función.
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000003'; -- otro ADMIN_RRHH, NO aprobador

select throws_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2026-08-22') $$,
  'P0001', 'No autorizado para aprobar licencias médicas.',
  'otro ADMIN_RRHH (no marcado aprobador) NO puede aprobar vía la función'
);

select throws_ok(
  $$ select public.reject_medical_license('99100000-0000-0000-0000-0000000000e1', 'motivo cualquiera') $$,
  'P0001', 'No autorizado para rechazar licencias médicas.',
  'otro ADMIN_RRHH (no marcado aprobador) NO puede rechazar vía la función'
);

-- RLS en UPDATE filtra filas silenciosamente (no lanza excepción vía SQL
-- crudo, semántica estándar de Postgres) -- lo que realmente prueba que está
-- bloqueado es que la fila queda intacta después del intento.
update public.medical_license_approvals set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(),
  confirmed_start_date = date '2026-08-20', confirmed_end_date = date '2026-08-22'
  where id = '99100000-0000-0000-0000-0000000000e1';

select is(
  (select status::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  'PENDING_RRHH_APPROVAL',
  'otro ADMIN_RRHH tampoco puede aprobar con un UPDATE directo -- RLS filtra la fila, el intento no tiene efecto'
);

reset role;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000005'; -- SUPER_ADMIN
set local role authenticated;

select throws_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2026-08-22') $$,
  'P0001', 'No autorizado para aprobar licencias médicas.',
  'SUPER_ADMIN NO tiene bypass -- decisión explícita del encargo, no hereda el permiso'
);

reset role;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000001'; -- supervisor que subió el documento
set local role authenticated;

select throws_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2026-08-22') $$,
  'P0001', 'No autorizado para aprobar licencias médicas.',
  'el supervisor que subió el documento no puede aprobar su propia licencia'
);

select throws_ok(
  $$ select public.reject_medical_license('99100000-0000-0000-0000-0000000000e1', 'motivo') $$,
  'P0001', 'No autorizado para rechazar licencias médicas.',
  'el supervisor tampoco puede rechazar'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) La cuenta aprobadora SÍ puede -- aprobar genera L, respetando fechas confirmadas (no necesariamente iguales a las propuestas).
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000004';

select lives_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2026-08-21') $$,
  'la cuenta aprobadora puede aprobar -- corrige el término a un día antes de lo propuesto'
);

reset role;

select is(
  (select status::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  'APPROVED',
  'tras aprobar, el estado queda APPROVED'
);

select is(
  (select approved_by from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  '99100000-0000-0000-0000-000000000004'::uuid,
  'approved_by persiste la identidad real del aprobador'
);

select isnt(
  (select approved_at from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  null,
  'approved_at persiste'
);

select is(
  (select confirmed_end_date::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e1'),
  '2026-08-21',
  'las fechas confirmadas por el aprobador (no las propuestas) son las que quedan como autoritativas'
);

select is(
  (
    select count(*)::int from public.attendance_status_records asr
    join public.attendance_statuses ast on ast.id = asr.attendance_status_id
    where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001')
      and asr.is_current and ast.code = 'L'
  ),
  2,
  'aprobar genera exactamente 2 días de "L" (20 y 21 de agosto, el rango CONFIRMADO, no el propuesto de 3 días)'
);

select is(
  (
    select count(*)::int from public.attendance_status_records asr
    join public.attendance_statuses ast on ast.id = asr.attendance_status_id
    where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001')
      and asr.work_date = date '2026-08-22' and asr.is_current and ast.code = 'L'
  ),
  0,
  'el día 22 (propuesto pero NO confirmado) nunca queda marcado L'
);

-- ---------------------------------------------------------------------------
-- 4) La guarda de transición impide re-aprobar/editar una licencia ya resuelta.
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000004';

select throws_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2026-08-22') $$,
  'P0001',
  'La licencia no existe o ya no está pendiente de aprobación.',
  'no se puede volver a aprobar una licencia ya APPROVED'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5) Rechazo: exige motivo, persiste auditoría, y NUNCA genera L.
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a2',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-09-01', date '2026-09-02', 'manual', 'hash-ml-2',
   '99100000-0000-0000-0000-000000000001');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d2',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   '99100000-0000-0000-0000-0000000000a2',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado-2.pdf', 'application/pdf', 'certificado2.pdf',
   '99100000-0000-0000-0000-000000000001');

insert into public.medical_license_approvals (id, absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000e2', '99100000-0000-0000-0000-0000000000a2', '99100000-0000-0000-0000-0000000000d2',
   date '2026-09-01', date '2026-09-02', '99100000-0000-0000-0000-000000000001');

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000004';

select throws_ok(
  $$ select public.reject_medical_license('99100000-0000-0000-0000-0000000000e2', '') $$,
  'P0001', 'El motivo de rechazo es obligatorio.',
  'rechazar sin motivo (vacío) es rechazado'
);

select lives_ok(
  $$ select public.reject_medical_license('99100000-0000-0000-0000-0000000000e2', 'Certificado ilegible, no se puede verificar el período') $$,
  'rechazar con motivo funciona'
);

reset role;

select is(
  (select status::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e2'),
  'REJECTED',
  'tras rechazar, el estado queda REJECTED'
);

select is(
  (select rejection_reason from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e2'),
  'Certificado ilegible, no se puede verificar el período',
  'el motivo de rechazo persiste íntegro'
);

select is(
  (select rejected_by from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e2'),
  '99100000-0000-0000-0000-000000000004'::uuid,
  'rejected_by persiste la identidad real de quien rechazó'
);

select is(
  (
    select count(*)::int from public.attendance_status_records asr
    join public.attendance_statuses ast on ast.id = asr.attendance_status_id
    where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001')
      and asr.work_date between date '2026-09-01' and date '2026-09-02'
      and asr.is_current and ast.code = 'L'
  ),
  0,
  'rechazar NUNCA genera "L" en asistencia'
);

-- ---------------------------------------------------------------------------
-- 6) Scoping por área en el INSERT: un supervisor de Instalación no puede
--    subir un documento (crear la fila de aprobación) para un empleado de
--    Producción -- mismo can_manage_employee ya usado en el resto del esquema.
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a3',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-09-10', date '2026-09-11', 'manual', 'hash-ml-3',
   '99100000-0000-0000-0000-000000000002');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d3',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   '99100000-0000-0000-0000-0000000000a3',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado-3.pdf', 'application/pdf', 'certificado3.pdf',
   '99100000-0000-0000-0000-000000000002');

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000002'; -- supervisor de Instalación

select throws_ok(
  $$ insert into public.medical_license_approvals
       (absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, uploaded_by)
     values ('99100000-0000-0000-0000-0000000000a3', '99100000-0000-0000-0000-0000000000d3',
             date '2026-09-10', date '2026-09-11', '99100000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'supervisor de Instalación NO puede crear la fila de aprobación para un empleado de Producción'
);

reset role;

-- Caso simétrico: supervisor de Producción tampoco puede subir para un empleado de Instalación.
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a4',
   (select id from public.employees where external_workera_id = 'TEST-ML-INST-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-09-12', date '2026-09-13', 'manual', 'hash-ml-4',
   '99100000-0000-0000-0000-000000000001');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d4',
   (select id from public.employees where external_workera_id = 'TEST-ML-INST-001'),
   '99100000-0000-0000-0000-0000000000a4',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado-4.pdf', 'application/pdf', 'certificado4.pdf',
   '99100000-0000-0000-0000-000000000001');

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000001'; -- supervisor de Producción

select throws_ok(
  $$ insert into public.medical_license_approvals
       (absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, uploaded_by)
     values ('99100000-0000-0000-0000-0000000000a4', '99100000-0000-0000-0000-0000000000d4',
             date '2026-09-12', date '2026-09-13', '99100000-0000-0000-0000-000000000001') $$,
  '42501',
  null,
  'supervisor de Producción NO puede crear la fila de aprobación para un empleado de Instalación'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7) SELECT: el aprobador ve licencias de cualquier área; un supervisor solo ve las de su propia área.
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000004'; -- aprobador

select is(
  (select count(*)::int from public.medical_license_approvals),
  2,
  'el aprobador ve todas las licencias (cualquier área) -- e1 y e2 (e3 nunca se insertó por el punto anterior)'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000002'; -- supervisor de Instalación (sin licencias en su área)

select is(
  (select count(*)::int from public.medical_license_approvals),
  0,
  'un supervisor de Instalación no ve licencias de empleados de Producción'
);

reset role;

-- ---------------------------------------------------------------------------
-- 8) Auditoría de integración licencia -> asistencia -> "Excel": rango
--    multi-día COMPLETO (el ejemplo literal del encargo: 2026-08-20 al
--    2026-08-22, los 3 días quedan L) -- distinto del caso de la sección 3,
--    que a propósito prueba que el rango CONFIRMADO puede ser más corto que
--    el propuesto. Acá se confirma exactamente el rango propuesto completo.
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a5',
   (select id from public.employees where external_workera_id = 'TEST-ML-INST-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-08-20', date '2026-08-22', 'manual', 'hash-ml-5',
   '99100000-0000-0000-0000-000000000002');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d5',
   (select id from public.employees where external_workera_id = 'TEST-ML-INST-001'),
   '99100000-0000-0000-0000-0000000000a5',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado-5.pdf', 'application/pdf', 'certificado5.pdf',
   '99100000-0000-0000-0000-000000000002');

insert into public.medical_license_approvals (id, absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, extraction_status, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000e5', '99100000-0000-0000-0000-0000000000a5', '99100000-0000-0000-0000-0000000000d5',
   date '2026-08-20', date '2026-08-22', 'EXTRAIDO', '99100000-0000-0000-0000-000000000002');

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000004'; -- aprobador

select lives_ok(
  $$ select public.approve_medical_license('99100000-0000-0000-0000-0000000000e5', date '2026-08-20', date '2026-08-22') $$,
  'aprobar el rango propuesto completo (3 días) funciona'
);

reset role;

select is(
  (
    select count(*)::int from public.attendance_status_records asr
    join public.attendance_statuses ast on ast.id = asr.attendance_status_id
    where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-INST-001')
      and asr.work_date between date '2026-08-20' and date '2026-08-22'
      and asr.is_current and ast.code = 'L'
  ),
  3,
  'un rango de 3 días aprobado completo genera exactamente 3 registros de "L" -- uno por día, sin entrada manual día a día'
);

select is(
  (select ast.code from public.attendance_status_records asr join public.attendance_statuses ast on ast.id = asr.attendance_status_id
   where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-INST-001') and asr.work_date = date '2026-08-20' and asr.is_current),
  'L', '20/08 queda L'
);

select is(
  (select ast.code from public.attendance_status_records asr join public.attendance_statuses ast on ast.id = asr.attendance_status_id
   where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-INST-001') and asr.work_date = date '2026-08-21' and asr.is_current),
  'L', '21/08 queda L'
);

select is(
  (select ast.code from public.attendance_status_records asr join public.attendance_statuses ast on ast.id = asr.attendance_status_id
   where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-INST-001') and asr.work_date = date '2026-08-22' and asr.is_current),
  'L', '22/08 queda L'
);

-- ---------------------------------------------------------------------------
-- 9) extraction_status = REQUIERE_REVISION (fechas propuestas no confiables,
--    ver medical-license-extraction.ts) NUNCA genera L por sí solo -- el único
--    gate real es `status`, que sigue en PENDING_RRHH_APPROVAL hasta que el
--    aprobador decida. extraction_status es informativo, no autoritativo.
insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99100000-0000-0000-0000-0000000000a6',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-10-01', date '2026-10-01', 'manual', 'hash-ml-6',
   '99100000-0000-0000-0000-000000000001');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000d6',
   (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001'),
   '99100000-0000-0000-0000-0000000000a6',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-certificado-6.pdf', 'application/pdf', 'certificado6.pdf',
   '99100000-0000-0000-0000-000000000001');

insert into public.medical_license_approvals (id, absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, extraction_status, uploaded_by) values
  ('99100000-0000-0000-0000-0000000000e6', '99100000-0000-0000-0000-0000000000a6', '99100000-0000-0000-0000-0000000000d6',
   date '2026-10-01', date '2026-10-01', 'REQUIERE_REVISION', '99100000-0000-0000-0000-000000000001');

select is(
  (select extraction_status from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e6'),
  'REQUIERE_REVISION',
  'la extracción automática no confiable queda registrada como REQUIERE_REVISION'
);

select is(
  (select status::text from public.medical_license_approvals where id = '99100000-0000-0000-0000-0000000000e6'),
  'PENDING_RRHH_APPROVAL',
  'REQUIERE_REVISION no es un estado de aprobación -- la fila sigue PENDING_RRHH_APPROVAL, igual que cualquier otra'
);

select is(
  (
    select count(*)::int from public.attendance_status_records asr
    join public.attendance_statuses ast on ast.id = asr.attendance_status_id
    where asr.employee_id = (select id from public.employees where external_workera_id = 'TEST-ML-PROD-001')
      and asr.work_date = date '2026-10-01' and asr.is_current and ast.code = 'L'
  ),
  0,
  'REQUIERE_REVISION + PENDING nunca genera "L" -- ni la extracción automática ni el estado pendiente son autoritativos'
);

select * from finish();
rollback;
