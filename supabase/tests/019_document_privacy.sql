-- pgTAP Fase 3: privacidad de documentos — supervisor sube pero no lee
-- contenido/storage_path; RRHH sí; anon nunca (secciones 12/13/14/39 del
-- encargo)
create extension if not exists pgtap;

begin;
select plan(7);

insert into public.profiles (id, display_name, role) values
  ('33000000-0000-0000-0000-000000000001', 'Fixture Admin Doc', 'ADMIN_RRHH'),
  ('33000000-0000-0000-0000-000000000002', 'Fixture Supervisor Doc', 'SUPERVISOR_PRODUCTION');

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-DOC-001', 'Fixture', 'Doc3', 'Fixture Doc3',
  (select id from public.employee_groups where code = 'PRODUCTION')
);

-- Fixture creado por el owner de la prueba. En runtime el supervisor reserva
-- y confirma por RPC; ya no posee INSERT directo sobre esta tabla sensible.
insert into public.supporting_documents
  (employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
values (
  (select id from public.employees where external_workera_id = 'TEST3-DOC-001'),
  'MEDICAL_CERTIFICATE', 'private/employees/fixture/cert.pdf',
  'application/pdf', 'cert.pdf', '33000000-0000-0000-0000-000000000002'
);

-- 1) SUPERVISOR_PRODUCTION no puede componer metadata saltándose el RPC.
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-000000000002';

select throws_ok(
  format(
    $$ insert into public.supporting_documents
         (employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
       values (%L, 'MEDICAL_CERTIFICATE', 'private/employees/fixture/cert.pdf', 'application/pdf', 'cert.pdf', %L) $$,
    (select id from public.employees where external_workera_id = 'TEST3-DOC-001'),
    '33000000-0000-0000-0000-000000000002'
  ),
  '42501', null,
  'SUPERVISOR_PRODUCTION confirma uploads solo por RPC, nunca INSERT directo'
);

-- 2) El mismo supervisor SÍ tiene GRANT de SELECT (necesario para el INSERT
-- anterior y para otras policies), pero la policy de SELECT es admin-only:
-- la consulta no truena, simplemente no devuelve ninguna fila.
select is_empty(
  $$ select 1 from public.supporting_documents $$,
  'SUPERVISOR_PRODUCTION no ve ninguna fila de la tabla base supporting_documents (contenido/storage_path oculto)'
);

-- 3) Pero SÍ puede leer la vista de metadata (sin storage_path).
select isnt_empty(
  $$ select 1 from public.supporting_documents_metadata $$,
  'SUPERVISOR_PRODUCTION puede leer supporting_documents_metadata (metadata sin storage_path)'
);

-- 4) La vista de metadata no expone storage_path como columna en absoluto.
select is(
  (select count(*)::int from information_schema.columns
     where table_schema = 'public' and table_name = 'supporting_documents_metadata'
       and column_name = 'storage_path'),
  0,
  'supporting_documents_metadata no tiene columna storage_path (ni siquiera oculta por RLS)'
);

reset role;

-- 5) ADMIN_RRHH SÍ puede leer la tabla base, incluido storage_path.
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-000000000001';

select isnt_empty(
  $$ select storage_path from public.supporting_documents $$,
  'ADMIN_RRHH puede leer storage_path directamente desde la tabla base'
);

reset role;

-- 6) anon no puede leer ni la tabla base ni la vista de metadata.
set local role anon;

select throws_ok(
  $$ select 1 from public.supporting_documents $$,
  '42501',
  null,
  'anon no puede leer supporting_documents (tabla base)'
);
select throws_ok(
  $$ select 1 from public.supporting_documents_metadata $$,
  '42501',
  null,
  'anon no puede leer supporting_documents_metadata (vista)'
);

reset role;
select * from finish();
rollback;
