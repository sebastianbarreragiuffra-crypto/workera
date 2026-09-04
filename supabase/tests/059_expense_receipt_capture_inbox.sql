-- pgTAP Fase 2 / bloque 2: bandeja personal de captura de comprobantes.
create extension if not exists pgtap;

begin;
select plan(38);

select has_table('public', 'expense_receipt_captures', 'existe la bandeja de capturas');
select has_column('public', 'expense_receipt_captures', 'external_message_id', 'queda una clave idempotente para canales futuros');
select has_function('public', 'can_upload_expense_capture_path', array['text'], 'existe validación de ruta de captura');
select has_function('public', 'can_read_expense_capture_path', array['text'], 'existe lectura privada de captura');
select has_function('public', 'register_expense_receipt_capture', array['uuid','uuid','text','text','text','integer','text','text'], 'existe registro seguro de captura server-only');
select has_function('public', 'attach_expense_receipt_capture', array['uuid','uuid'], 'existe asociación atómica a gasto');
select has_function('public', 'discard_expense_receipt_capture', array['uuid','uuid','uuid'], 'existe descarte controlado server-only y por empresa');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_captures', 'INSERT'), 'el navegador no inserta metadata directamente');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_captures', 'UPDATE'), 'el navegador no cambia estados directamente');
select ok(not has_function_privilege('authenticated', 'public.register_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text)', 'EXECUTE'), 'el navegador autenticado no puede inventar hashes');
select ok(not exists (
  select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'expense_captures_storage_insert' and cmd = 'INSERT'
), 'el navegador no puede subir capturas directamente a Storage');
select ok(not exists (
  select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'expense_receipts_storage_insert' and cmd = 'INSERT'
), 'toda carga de comprobantes quedó reservada al backend');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('98000000-0000-0000-0000-000000000001', 'Captura Uno', 'Captura Uno SpA', 'captura-uno', true, 'ONBOARDING', false),
  ('98000000-0000-0000-0000-000000000002', 'Captura Dos', 'Captura Dos SpA', 'captura-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('98000000-0000-0000-0000-000000000101', 'Platform Captura', null, true),
  ('98000000-0000-0000-0000-000000000102', 'Rendidor Captura', null, true),
  ('98000000-0000-0000-0000-000000000103', 'Compañero Captura', null, true),
  ('98000000-0000-0000-0000-000000000104', 'Rendidor Ajeno', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('98000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('98000000-0000-0000-0000-000000000201', '98000000-0000-0000-0000-000000000102', '98000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('98000000-0000-0000-0000-000000000202', '98000000-0000-0000-0000-000000000103', '98000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('98000000-0000-0000-0000-000000000203', '98000000-0000-0000-0000-000000000104', '98000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('98000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa uno');
select lives_ok($$select public.platform_set_company_module_status('98000000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa dos');
reset role;

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id in (
  '98000000-0000-0000-0000-000000000201',
  '98000000-0000-0000-0000-000000000202',
  '98000000-0000-0000-0000-000000000203'
);

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000102', 'Rendición con captura');
insert into public.expense_items (id, company_id, report_id, expense_date, description, net_amount)
values ('98000000-0000-0000-0000-000000000401', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', current_date, 'Taxi', 12000);

select ok(public.can_upload_expense_capture_path(
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'el dueño puede subir a su ruta de bandeja');
select ok(not public.can_upload_expense_capture_path(
  '98000000-0000-0000-0000-000000000002/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'no puede cambiar la empresa en la ruta');
select ok(not public.can_upload_expense_capture_path(
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000103/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'no puede cambiar el dueño en la ruta');

reset role;
set local role service_role;
insert into storage.objects (id, bucket_id, name, owner_id, metadata)
values (
  '98000000-0000-0000-0000-000000000501', 'expense-receipts',
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg',
  '98000000-0000-0000-0000-000000000102', '{"mimetype":"image/jpeg","size":1234}'::jsonb
);
select lives_ok($$select public.register_expense_receipt_capture(
  '98000000-0000-0000-0000-000000000102',
  '98000000-0000-0000-0000-000000000001',
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg',
  'boleta.jpg', 'image/jpeg', 1234,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'WEB_CAMERA'
)$$, 'se registra una captura después de existir el objeto privado');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
select is((select count(*)::integer from public.expense_receipt_captures where status = 'PENDING'), 1, 'la captura entra pendiente a la bandeja');
select ok(public.can_read_expense_capture_path(
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'el dueño puede abrir la captura pendiente');
reset role;

-- ID estable solo para que los intentos de IDOR siguientes no dependan de
-- descubrir la fila mediante una consulta protegida por RLS.
update public.expense_receipt_captures
set id = '98000000-0000-0000-0000-000000000502'
where storage_path like '%000000000501.jpg';

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_receipt_captures), 0, 'otro miembro de la misma empresa no ve la bandeja personal');
select throws_ok(
  $$select public.attach_expense_receipt_capture(
    '98000000-0000-0000-0000-000000000502',
    '98000000-0000-0000-0000-000000000401'
  )$$,
  '42501', 'La captura pertenece a otra persona.', 'con el UUID conocido tampoco se adjunta una captura ajena'
);
select throws_ok(
  $$select public.attach_expense_receipt_capture(
    null,
    '98000000-0000-0000-0000-000000000401'
  )$$,
  '22004', 'captura y gasto son obligatorios.', 'ids nulos se rechazan antes de mutar'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000104';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('98000000-0000-0000-0000-000000000302', '98000000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-000000000104', 'Rendición empresa dos');
insert into public.expense_items (id, company_id, report_id, expense_date, description, net_amount)
values ('98000000-0000-0000-0000-000000000402', '98000000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-000000000302', current_date, 'Taxi ajeno', 9000);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.attach_expense_receipt_capture(
    '98000000-0000-0000-0000-000000000502',
    '98000000-0000-0000-0000-000000000402'
  )$$,
  '42501', 'La captura y el gasto pertenecen a empresas distintas.', 'no se cruza una captura entre empresas'
);
select lives_ok(
  $$select public.attach_expense_receipt_capture(
    '98000000-0000-0000-0000-000000000502',
    '98000000-0000-0000-0000-000000000401'
  )$$,
  'el dueño asocia la captura a su gasto'
);
select is((select status from public.expense_receipt_captures where id = '98000000-0000-0000-0000-000000000502'), 'ATTACHED', 'la captura queda resuelta');
select ok((select attached_receipt_id is not null and attached_at is not null from public.expense_receipt_captures where id = '98000000-0000-0000-0000-000000000502'), 'se conserva trazabilidad hacia el comprobante');
select ok((select receipt_status = 'UPLOADED' from public.expense_items where id = '98000000-0000-0000-0000-000000000401'), 'el gasto activa el pipeline de comprobantes existente');
select is((select count(*)::integer from public.expense_receipts where item_id = '98000000-0000-0000-0000-000000000401' and is_current), 1, 'se crea exactamente un comprobante vigente');
select ok(not public.can_read_expense_capture_path(
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'la ruta deja de leerse como captura al asociarla');
select ok(public.can_read_expense_receipt_path(
  '98000000-0000-0000-0000-000000000001/98000000-0000-0000-0000-000000000102/inbox/98000000-0000-0000-0000-000000000501.jpg'
), 'la misma ruta sigue disponible como comprobante del gasto');
select throws_ok(
  $$select public.attach_expense_receipt_capture(
    '98000000-0000-0000-0000-000000000502',
    '98000000-0000-0000-0000-000000000401'
  )$$,
  '23514', 'La captura ya fue resuelta.', 'una captura no se asocia dos veces'
);
delete from public.expense_items where id = '98000000-0000-0000-0000-000000000401';
select is((select status from public.expense_receipt_captures where id = '98000000-0000-0000-0000-000000000502'), 'PENDING', 'al borrar el gasto, la captura vuelve a la bandeja');
select is((select count(*)::integer from public.expense_receipts where item_id = '98000000-0000-0000-0000-000000000401'), 0, 'el borrado del gasto ya no queda bloqueado por la captura');
reset role;

set local role service_role;
select throws_ok(
  $$select public.discard_expense_receipt_capture(
    '98000000-0000-0000-0000-000000000102',
    '98000000-0000-0000-0000-000000000002',
    '98000000-0000-0000-0000-000000000502'
  )$$,
  '23514', 'La captura no existe o ya fue resuelta.', 'una empresa incorrecta no puede descartar la captura'
);
select is((select status from public.expense_receipt_captures where id = '98000000-0000-0000-0000-000000000502'), 'PENDING', 'el descarte cruzado no cambia el estado');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
insert into public.expense_items (id, company_id, report_id, expense_date, description, net_amount)
values ('98000000-0000-0000-0000-000000000403', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', current_date, 'Taxi a eliminar con bandeja llena', 15000);
select public.attach_expense_receipt_capture(
  '98000000-0000-0000-0000-000000000502',
  '98000000-0000-0000-0000-000000000403'
);
reset role;

insert into public.expense_receipt_captures (
  company_id, uploaded_by, source, storage_path, original_filename,
  mime_type, file_size, checksum_sha256
)
select
  '98000000-0000-0000-0000-000000000001',
  '98000000-0000-0000-0000-000000000102',
  'WEB_UPLOAD',
  'quota/' || n::text || '.jpg',
  'quota-' || n::text || '.jpg',
  'image/jpeg', 1,
  repeat('b', 64)
from generate_series(1, 50) as n;

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
select throws_ok(
  $$delete from public.expense_items where id = '98000000-0000-0000-0000-000000000403'$$,
  '54000', 'Libera un espacio en tu bandeja de comprobantes antes de borrar este gasto.', 'la bandeja llena bloquea el borrado en vez de perder evidencia o superar el límite'
);
select ok(
  exists (select 1 from public.expense_items where id = '98000000-0000-0000-0000-000000000403')
  and (select status = 'ATTACHED' and attached_receipt_id is not null from public.expense_receipt_captures where id = '98000000-0000-0000-0000-000000000502')
  and (select count(*) = 50 from public.expense_receipt_captures where company_id = '98000000-0000-0000-0000-000000000001' and uploaded_by = '98000000-0000-0000-0000-000000000102' and status = 'PENDING'),
  'el rechazo conserva gasto, comprobante asociado y el cupo exacto'
);
reset role;

select * from finish();
rollback;
