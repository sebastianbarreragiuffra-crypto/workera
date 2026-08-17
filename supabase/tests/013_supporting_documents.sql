-- pgTAP Fase 2B: supporting_documents (metadata, sin binarios)
create extension if not exists pgtap;

begin;
select plan(4);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST2B-EMP-DOC-001', 'Fixture', 'Doc', 'Fixture Doc');
insert into public.profiles (display_name, role) values ('Fixture Uploader', 'supervisor');

insert into public.absence_records (employee_id, absence_type_id, start_date, end_date, source, source_hash)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
  (select id from public.absence_types where code = 'MEDICAL_LEAVE'),
  date '2026-08-10', date '2026-08-15', 'manual', 'hash-doc-abs-1'
);

-- 1) Metadata válida ligada a una absence_record se inserta
select lives_ok(
  format(
    $$ insert into public.supporting_documents
         (employee_id, absence_record_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
       values (%L, %L, 'MEDICAL_CERTIFICATE', 'private/employees/fixture/2026-08-10-certificado.pdf',
               'application/pdf', 'certificado.pdf', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
    (select id from public.absence_records where source_hash = 'hash-doc-abs-1'),
    (select id from public.profiles where display_name = 'Fixture Uploader')
  ),
  'supporting_documents: metadata válida ligada a absence_record se inserta'
);

-- 2) document_type inválido debe rechazarse
select throws_ok(
  format(
    $$ insert into public.supporting_documents
         (employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
       values (%L, 'X-RAY', 'private/employees/fixture/foo.pdf', 'application/pdf', 'foo.pdf', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
    (select id from public.profiles where display_name = 'Fixture Uploader')
  ),
  '23514',
  null,
  'supporting_documents: document_type fuera del catálogo permitido es rechazado'
);

-- 3) Documento sin relación puntual (solo employee_id) es válido
select lives_ok(
  format(
    $$ insert into public.supporting_documents
         (employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
       values (%L, 'IDENTIFICATION', 'private/employees/fixture/cedula.jpg', 'image/jpeg', 'cedula.jpg', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
    (select id from public.profiles where display_name = 'Fixture Uploader')
  ),
  'supporting_documents: documento sin absence/late_arrival/attendance_status asociado es válido'
);

-- 4) Documento ligado a más de una entidad a la vez debe rechazarse (CHECK num_nonnulls)
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
  date '2026-08-20', timestamptz '2026-08-20 07:45-04', timestamptz '2026-08-20 17:00-04',
  'hash-doc-att-1', 1, true
);
insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
  date '2026-08-20',
  (select id from public.attendance_records where source_hash = 'hash-doc-att-1'),
  time '07:30', timestamptz '2026-08-20 07:45-04', 15,
  (select lap.id from public.late_arrival_policies lap join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'PRODUCTION' and lap.day_of_week = 4)
);
insert into public.late_arrival_decisions (late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by)
values (
  (select id from public.late_arrival_records where detected_minutes = 15 and work_date = date '2026-08-20'),
  false, 15, 'DEDUCT',
  (select id from public.profiles where display_name = 'Fixture Uploader')
);

select throws_ok(
  format(
    $$ insert into public.supporting_documents
         (employee_id, absence_record_id, late_arrival_decision_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
       values (%L, %L, %L, 'OTHER', 'private/employees/fixture/doble.pdf', 'application/pdf', 'doble.pdf', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-DOC-001'),
    (select id from public.absence_records where source_hash = 'hash-doc-abs-1'),
    (select lad.id from public.late_arrival_decisions lad join public.late_arrival_records lar on lar.id = lad.late_arrival_record_id
       where lar.detected_minutes = 15 and lar.work_date = date '2026-08-20'),
    (select id from public.profiles where display_name = 'Fixture Uploader')
  ),
  '23514',
  null,
  'supporting_documents: ligar el documento a dos entidades a la vez es rechazado'
);

select * from finish();
rollback;
