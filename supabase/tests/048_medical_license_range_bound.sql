-- pgTAP: cota al rango confirmado en approve_medical_license.
--
-- La función escribe UNA FILA POR DÍA en attendance_status_records. Sin cota,
-- confirmar un rango de siglos era una amplificación de escritura sobre el
-- historial de asistencia, alcanzable con un simple error de tipeo del
-- aprobador (2926 en vez de 2026) en el panel que le deja editar el rango.
create extension if not exists pgtap;

begin;
select plan(6);

-- ---------------------------------------------------------------------------
-- Fixtures: un trabajador, la cuenta aprobadora y una licencia pendiente.
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id) values
  ('TEST-MLB-PROD-001', 'Rango', 'Fixture', 'Rango Fixture', (select id from public.employee_groups where code = 'PRODUCTION'));

insert into public.profiles (id, display_name, role, medical_license_approver) values
  ('99200000-0000-0000-0000-000000000001', 'Fixture Supervisor Rango', 'SUPERVISOR_PRODUCTION', false),
  ('99200000-0000-0000-0000-000000000004', 'Fixture Aprobador Rango', 'ADMIN_RRHH', true);

insert into public.absence_records (id, employee_id, absence_type_id, start_date, end_date, source, source_hash, created_by) values
  ('99200000-0000-0000-0000-0000000000a1',
   (select id from public.employees where external_workera_id = 'TEST-MLB-PROD-001'),
   (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
   date '2026-08-20', date '2026-08-22', 'manual', 'hash-mlb-1',
   '99200000-0000-0000-0000-000000000001');

insert into public.supporting_documents (id, employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by) values
  ('99200000-0000-0000-0000-0000000000d1',
   (select id from public.employees where external_workera_id = 'TEST-MLB-PROD-001'),
   '99200000-0000-0000-0000-0000000000a1',
   'MEDICAL_CERTIFICATE', 'test-only/fixture-rango.pdf', 'application/pdf', 'certificado.pdf',
   '99200000-0000-0000-0000-000000000001');

insert into public.medical_license_approvals
  (id, absence_record_id, supporting_document_id, proposed_start_date, proposed_end_date, uploaded_by) values
  ('99200000-0000-0000-0000-0000000000e1', '99200000-0000-0000-0000-0000000000a1', '99200000-0000-0000-0000-0000000000d1',
   date '2026-08-20', date '2026-08-22', '99200000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000004'; -- la cuenta aprobadora

-- 1) El caso que motivó la cota: un rango de siglos se rechaza.
select throws_ok(
  $$ select public.approve_medical_license('99200000-0000-0000-0000-0000000000e1', date '1900-01-01', date '2999-12-31') $$,
  'P0001',
  null,
  'un rango de siglos se rechaza en vez de escribir cientos de miles de filas'
);

-- 2) El typo realista (2926 en vez de 2026) también.
select throws_ok(
  $$ select public.approve_medical_license('99200000-0000-0000-0000-0000000000e1', date '2026-08-20', date '2926-08-22') $$,
  'P0001',
  null,
  'un año mal tecleado se rechaza -- es el error probable, no el ataque'
);

-- 3) Rechazar el rango no debe dejar NADA escrito: ni "L", ni la aprobación.
select is(
  (select count(*) from public.attendance_status_records
    where employee_id = (select id from public.employees where external_workera_id = 'TEST-MLB-PROD-001')),
  0::bigint,
  'un rango rechazado no deja ninguna fila de asistencia a medio escribir'
);

select is(
  (select status::text from public.medical_license_approvals where id = '99200000-0000-0000-0000-0000000000e1'),
  'PENDING_RRHH_APPROVAL',
  'la licencia sigue pendiente tras el rechazo del rango'
);

-- 4) Justo en el límite (366 días) sí se acepta: la cota no rompe una licencia
--    prolongada de un año completo.
select lives_ok(
  $$ select public.approve_medical_license('99200000-0000-0000-0000-0000000000e1', date '2026-01-01', date '2026-12-31') $$,
  '365 días (año completo) sigue siendo válido -- la cota no estorba el caso real'
);

select is(
  (select count(*) from public.attendance_status_records
    where employee_id = (select id from public.employees where external_workera_id = 'TEST-MLB-PROD-001')
      and is_current),
  365::bigint,
  'se escribió exactamente una fila vigente por día del rango aprobado'
);

select * from finish();
rollback;
