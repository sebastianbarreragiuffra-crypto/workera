-- pgTAP GESTORA EX-4: cola OCR privada, leases, reintentos y revisión humana.
create extension if not exists pgtap;

begin;
select plan(54);

select has_table('public', 'expense_ocr_jobs', 'existe la cola OCR');
select has_table('public', 'expense_ocr_reviews', 'existe el historial de revisión OCR');
select has_function('public', 'claim_expense_ocr_jobs', array['uuid','integer'], 'existe claim atómico');
select has_function('public', 'complete_expense_ocr_job', array['uuid','uuid','jsonb'], 'existe cierre controlado');
select col_has_check('public', 'expense_ocr_jobs', 'attempt', 'los intentos tienen un check');
select ok(not has_table_privilege('authenticated', 'public.expense_ocr_jobs', 'SELECT'), 'authenticated no ve la cola');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_ocr_jobs(uuid, integer)', 'EXECUTE'), 'authenticated no reclama jobs');
select ok(not has_function_privilege('authenticated', 'public.reclaim_stale_expense_ocr_jobs(integer)', 'EXECUTE'), 'authenticated no recupera leases');
select ok(has_function_privilege('service_role', 'public.claim_expense_ocr_jobs(uuid, integer)', 'EXECUTE'), 'service_role puede reclamar');
select ok(has_function_privilege('service_role', 'public.complete_expense_ocr_job(uuid, uuid, jsonb)', 'EXECUTE'), 'service_role puede completar');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled) values
  ('98000000-0000-0000-0000-000000000001', 'OCR Uno', 'OCR Uno SpA', 'ocr-uno', true, 'ONBOARDING', false),
  ('98000000-0000-0000-0000-000000000002', 'OCR Dos', 'OCR Dos SpA', 'ocr-dos', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values
  ('98000000-0000-0000-0000-000000000101', 'Rendidor OCR', null, true),
  ('98000000-0000-0000-0000-000000000102', 'Usuario otro tenant', null, true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('98000000-0000-0000-0000-000000000201', '98000000-0000-0000-0000-000000000101', '98000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('98000000-0000-0000-0000-000000000202', '98000000-0000-0000-0000-000000000102', '98000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm join public.company_roles cr on cr.company_id = cm.company_id
where cm.id in ('98000000-0000-0000-0000-000000000201','98000000-0000-0000-0000-000000000202')
  and cr.code = 'PRODUCTION_SUPERVISOR';
update public.company_modules set status = 'PILOT', enabled_at = now()
where company_id in ('98000000-0000-0000-0000-000000000001','98000000-0000-0000-0000-000000000002') and module_key = 'expenses';

insert into public.expense_reports (id, company_id, submitted_by, title) values
  ('98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000101', 'Informe OCR uno'),
  ('98000000-0000-0000-0000-000000000302', '98000000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-000000000102', 'Informe OCR dos');
insert into public.expense_items (id, company_id, report_id, expense_date, merchant_name, description, net_amount, tax_amount, currency_code) values
  ('98000000-0000-0000-0000-000000000401', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '2026-08-10', 'Comercio declarado', 'Gasto principal', 10000, 1900, 'CLP'),
  ('98000000-0000-0000-0000-000000000402', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '2026-08-11', 'Segundo comercio', 'Gasto no retryable', 2000, 380, 'CLP'),
  ('98000000-0000-0000-0000-000000000403', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '2026-08-12', 'Reemplazo', 'Gasto reemplazado', 3000, 570, 'CLP'),
  ('98000000-0000-0000-0000-000000000404', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '2026-08-13', 'Lease', 'Lease superseded', 4000, 760, 'CLP'),
  ('98000000-0000-0000-0000-000000000405', '98000000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-000000000302', '2026-08-14', 'Ajeno', 'Gasto ajeno', 5000, 950, 'CLP');

insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000501', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000401', 1, 'ocr/uno-1.pdf', 'uno.pdf', 'application/pdf', 100, repeat('a',64), '98000000-0000-0000-0000-000000000101');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/uno-1.pdf' where id = '98000000-0000-0000-0000-000000000401';

select is((select count(*)::integer from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 1, 'subir un comprobante encola automáticamente');
select ok((select attempt = 1 and status = 'QUEUED' from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 'el primer intento nace QUEUED');
select throws_ok(
  $$insert into public.expense_ocr_jobs (company_id, receipt_id, attempt) values ('98000000-0000-0000-0000-000000000001','98000000-0000-0000-0000-000000000501',2)$$,
  '23505', null, 'solo existe un job activo por comprobante'
);

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000101';
select throws_ok($$select count(*) from public.expense_ocr_jobs$$, '42501', null, 'authenticated no puede consultar la cola');
reset role;

set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000901', 1)), 1, 'el worker reclama un job');
select ok((select status = 'RUNNING' and locked_by = '98000000-0000-0000-0000-000000000901' from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 'el claim deja un lease RUNNING');
select is((select status::text from public.expense_receipts where id = '98000000-0000-0000-0000-000000000501'), 'PROCESSING', 'el comprobante refleja el análisis');
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000902', 1)), 0, 'un segundo worker no procesa el mismo job');
select lives_ok($$select public.defer_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), '98000000-0000-0000-0000-000000000901', 'https://ocr.example.test/operations/1', 5)$$, 'el worker difiere el polling');
select ok((select status = 'WAITING_PROVIDER' and provider_operation_url is not null from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 'WAITING_PROVIDER conserva Operation-Location sin lease');
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000902', 1)), 0, 'un polling futuro aún no está disponible');
reset role;

update public.expense_ocr_jobs set available_at = now() - interval '1 second' where receipt_id = '98000000-0000-0000-0000-000000000501';
set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000902', 1)), 1, 'WAITING_PROVIDER vuelve a reclamarse al vencer available_at');
reset role;
update public.expense_ocr_jobs set locked_at = now() - interval '10 minutes' where receipt_id = '98000000-0000-0000-0000-000000000501';
set local role service_role;
select is(public.reclaim_stale_expense_ocr_jobs(300), 1, 'se recupera un lease vencido');
select is((select status::text from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 'QUEUED', 'el lease vencido vuelve a QUEUED');
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000903', 1)), 1, 'el intento recuperado se reclama nuevamente');
select ok(public.fail_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501' and attempt = 1), '98000000-0000-0000-0000-000000000903', 'PROVIDER_UNAVAILABLE', 'Temporal', true, 1), 'un error retryable crea segundo intento');
select is((select max(attempt) from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 2, 'se creó el intento dos');
reset role;
update public.expense_ocr_jobs set available_at = now() - interval '1 second' where receipt_id = '98000000-0000-0000-0000-000000000501' and attempt = 2;
set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000903', 1)), 1, 'se reclama el segundo intento');
select ok(public.fail_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501' and attempt = 2), '98000000-0000-0000-0000-000000000903', 'PROVIDER_UNAVAILABLE', 'Temporal', true, 1), 'el segundo error retryable crea el tercer intento');
reset role;
update public.expense_ocr_jobs set available_at = now() - interval '1 second' where receipt_id = '98000000-0000-0000-0000-000000000501' and attempt = 3;
set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000903', 1)), 1, 'se reclama el tercer intento');
select ok(not public.fail_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501' and attempt = 3), '98000000-0000-0000-0000-000000000903', 'PROVIDER_UNAVAILABLE', 'Temporal', true, 1), 'el tercer error no crea otro intento');
select ok((select count(*) = 3 and max(attempt) = 3 from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000501'), 'el máximo absoluto es tres intentos');
reset role;

insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000502', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000402', 1, 'ocr/uno-2.pdf', 'dos.pdf', 'application/pdf', 100, repeat('b',64), '98000000-0000-0000-0000-000000000101');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/uno-2.pdf' where id = '98000000-0000-0000-0000-000000000402';
set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000904', 1)), 1, 'se reclama el job para error definitivo');
select ok(not public.fail_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000502'), '98000000-0000-0000-0000-000000000904', 'PROVIDER_REJECTED_DOCUMENT', 'Documento inválido', false, 30), 'un error no retryable no reencola');
select ok((select count(*) = 1 and bool_and(status = 'FAILED') from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000502'), 'el error definitivo conserva un único intento FAILED');
reset role;

insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000503', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000403', 1, 'ocr/uno-3.pdf', 'tres.pdf', 'application/pdf', 100, repeat('c',64), '98000000-0000-0000-0000-000000000101');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/uno-3.pdf' where id = '98000000-0000-0000-0000-000000000403';
set local role service_role;
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000905', 1)), 1, 'se reclama el comprobante que será reemplazado');
reset role;
alter table public.expense_receipts disable trigger expense_receipts_cancel_superseded_ocr;
update public.expense_receipts set is_current = false where id = '98000000-0000-0000-0000-000000000503';
insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000504', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000403', 2, 'ocr/uno-4.pdf', 'cuatro.pdf', 'application/pdf', 100, repeat('d',64), '98000000-0000-0000-0000-000000000101');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/uno-4.pdf' where id = '98000000-0000-0000-0000-000000000403';
alter table public.expense_receipts enable trigger expense_receipts_cancel_superseded_ocr;
set local role service_role;
select lives_ok($$select public.complete_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000503'), '98000000-0000-0000-0000-000000000905', '{"total":3570}'::jsonb)$$, 'completar una versión reemplazada descarta el resultado');
select ok((select status = 'CANCELLED' from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000503'), 'el job viejo termina CANCELLED');
select is((select extraction from public.expense_receipts where id = '98000000-0000-0000-0000-000000000503'), '{}'::jsonb, 'el comprobante viejo no recibe extracción');
select is((select extraction from public.expense_receipts where id = '98000000-0000-0000-0000-000000000504'), '{}'::jsonb, 'el reemplazo tampoco recibe el resultado viejo');
select is((select extraction from public.expense_items where id = '98000000-0000-0000-0000-000000000403'), '{}'::jsonb, 'el resultado viejo no llega al gasto');
select is((select count(*)::integer from public.claim_expense_ocr_jobs('98000000-0000-0000-0000-000000000906', 1)), 1, 'se reclama el comprobante vigente');
select lives_ok($$select public.complete_expense_ocr_job((select id from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000504'), '98000000-0000-0000-0000-000000000906', '{"confidence":0.91,"requiresHumanReview":true,"fields":{},"discrepancies":[]}'::jsonb)$$, 'la extracción vigente se completa');
select ok((select net_amount = 3000 and tax_amount = 570 and total_amount = 3570 from public.expense_items where id = '98000000-0000-0000-0000-000000000403'), 'OCR nunca sobrescribe montos declarados');
select ok((select r.extraction = ei.extraction and r.status = 'PROCESSED' and ei.receipt_status = 'PROCESSED' from public.expense_receipts r join public.expense_items ei on ei.id = r.item_id where r.id = '98000000-0000-0000-0000-000000000504'), 'solo complete refleja la extracción vigente en comprobante e ítem');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000101';
select throws_ok($$select public.review_expense_receipt_extraction('98000000-0000-0000-0000-000000000504', 'REJECTED', null)$$, '23514', 'Debes explicar por qué rechazas la lectura automática.', 'rechazar la sugerencia exige comentario');
select lives_ok($$select public.review_expense_receipt_extraction('98000000-0000-0000-0000-000000000504', 'REJECTED', 'No coincide con la boleta')$$, 'el usuario autorizado rechaza con comentario');
select ok((select extraction->'humanReview'->>'decision' = 'REJECTED' from public.expense_receipts where id = '98000000-0000-0000-0000-000000000504'), 'la decisión humana queda reflejada');
reset role;

insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000505', '98000000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-000000000301', '98000000-0000-0000-0000-000000000404', 1, 'ocr/uno-5.pdf', 'cinco.pdf', 'application/pdf', 100, repeat('e',64), '98000000-0000-0000-0000-000000000101');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/uno-5.pdf' where id = '98000000-0000-0000-0000-000000000404';
update public.expense_ocr_jobs set status = 'RUNNING', locked_at = now() - interval '10 minutes', locked_by = '98000000-0000-0000-0000-000000000907', started_at = now() - interval '10 minutes' where receipt_id = '98000000-0000-0000-0000-000000000505';
alter table public.expense_receipts disable trigger expense_receipts_cancel_superseded_ocr;
update public.expense_receipts set is_current = false where id = '98000000-0000-0000-0000-000000000505';
alter table public.expense_receipts enable trigger expense_receipts_cancel_superseded_ocr;
set local role service_role;
select is(public.reclaim_stale_expense_ocr_jobs(300), 1, 'reclaim también cierra el lease superseded');
select ok((select status = 'CANCELLED' and error_category = 'SUPERSEDED' from public.expense_ocr_jobs where receipt_id = '98000000-0000-0000-0000-000000000505'), 'un lease superseded no queda perdido en RUNNING');
reset role;

insert into public.expense_receipts (id, company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by) values
  ('98000000-0000-0000-0000-000000000506', '98000000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-000000000302', '98000000-0000-0000-0000-000000000405', 1, 'ocr/dos-1.pdf', 'ajeno.pdf', 'application/pdf', 100, repeat('f',64), '98000000-0000-0000-0000-000000000102');
update public.expense_items set receipt_status = 'UPLOADED', receipt_storage_path = 'ocr/dos-1.pdf' where id = '98000000-0000-0000-0000-000000000405';
set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000102';
select is((select count(*)::integer from public.expense_ocr_reviews), 0, 'otro tenant no ve revisiones OCR ajenas');
select is((select count(*)::integer from public.expense_receipts where company_id = '98000000-0000-0000-0000-000000000001'), 0, 'otro tenant no ve comprobantes ajenos');
select throws_ok($$select public.review_expense_receipt_extraction('98000000-0000-0000-0000-000000000504', 'ACCEPTED', null)$$, '42501', 'No tienes acceso a este comprobante.', 'el RPC de revisión rechaza el cruce de empresa');
reset role;
select throws_ok($$insert into public.expense_ocr_jobs (company_id, receipt_id, attempt) values ('98000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000504',2)$$, '23503', null, 'la FK compuesta impide cruzar empresa y comprobante');

select * from finish();
rollback;
