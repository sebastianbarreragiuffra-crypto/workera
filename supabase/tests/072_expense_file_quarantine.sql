-- pgTAP P0-A: los archivos externos no salen de cuarentena sin veredicto.
create extension if not exists pgtap;

begin;
set local request.jwt.claim.aal = 'aal2';
select plan(38);

select has_type('public', 'expense_file_security_status', 'existe el estado de seguridad de archivo');
select has_column('public', 'expense_receipt_captures', 'security_status', 'capturas registran cuarentena');
select has_column('public', 'expense_receipts', 'security_status', 'comprobantes conservan procedencia de seguridad');
select has_function('public', 'claim_expense_file_scans', array['uuid','integer'], 'existe claim SKIP LOCKED');
select has_function('public', 'complete_expense_file_scan', array['uuid','uuid','text','text','text'], 'existe cierre fenced');
select has_function('public', 'fail_expense_file_scan', array['uuid','uuid','text','text','boolean','integer'], 'existe retry acotado');
select has_function('public', 'reclaim_stale_expense_file_scans', array['integer'], 'existe recuperación de leases');
select has_trigger('public', 'expense_receipt_captures', 'expense_receipt_captures_initialize_security', 'el origen define la cuarentena en base');
select has_trigger('public', 'expense_receipts', 'expense_receipts_initialize_security', 'un adjunto hereda el veredicto');
select has_trigger('public', 'expense_reports', 'expense_reports_require_released_receipts', 'el envío falla cerrado');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_file_scans(uuid,integer)', 'EXECUTE'), 'un navegador no reclama archivos');
select ok(not has_function_privilege('authenticated', 'public.complete_expense_file_scan(uuid,uuid,text,text,text)', 'EXECUTE'), 'un navegador no inventa CLEAN');
select ok(has_function_privilege('service_role', 'public.claim_expense_file_scans(uuid,integer)', 'EXECUTE'), 'solo el worker privilegiado reclama');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values ('e3000000-0000-0000-0000-000000000001', 'Quarantine Uno', 'Quarantine Uno SpA', 'quarantine-uno', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active)
values ('e3000000-0000-0000-0000-000000000101', 'Rendidor Quarantine', null, true);
insert into public.company_memberships (id, user_id, company_id, role, active)
values ('e3000000-0000-0000-0000-000000000201', 'e3000000-0000-0000-0000-000000000101', 'e3000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id = 'e3000000-0000-0000-0000-000000000201';
update public.company_modules set status = 'PILOT', enabled_at = now()
where company_id = 'e3000000-0000-0000-0000-000000000001' and module_key = 'expenses';

insert into public.expense_categories (id, company_id, code, name, requires_receipt)
values ('e3000000-0000-0000-0000-000000000301', 'e3000000-0000-0000-0000-000000000001', 'TEST', 'Prueba', true);
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('e3000000-0000-0000-0000-000000000401', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'Rendición cuarentena');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
values ('e3000000-0000-0000-0000-000000000501', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000401', 'e3000000-0000-0000-0000-000000000301', current_date, 'Traslado', 1000);

insert into storage.objects (id, bucket_id, name, owner_id, metadata) values
  ('e3000000-0000-0000-0000-000000000601', 'expense-receipts', 'quarantine/web.pdf', 'e3000000-0000-0000-0000-000000000101', '{"mimetype":"application/pdf","size":100}'::jsonb),
  ('e3000000-0000-0000-0000-000000000602', 'expense-receipts', 'quarantine/email.pdf', 'e3000000-0000-0000-0000-000000000101', '{"mimetype":"application/pdf","size":100}'::jsonb),
  ('e3000000-0000-0000-0000-000000000603', 'expense-receipts', 'quarantine/rejected.pdf', 'e3000000-0000-0000-0000-000000000101', '{"mimetype":"application/pdf","size":100}'::jsonb),
  ('e3000000-0000-0000-0000-000000000604', 'expense-receipts', 'quarantine/retry.pdf', 'e3000000-0000-0000-0000-000000000101', '{"mimetype":"application/pdf","size":100}'::jsonb),
  ('e3000000-0000-0000-0000-000000000605', 'expense-receipts', 'quarantine/stale.pdf', 'e3000000-0000-0000-0000-000000000101', '{"mimetype":"application/pdf","size":100}'::jsonb);

set local role service_role;
insert into public.expense_receipt_captures (
  id, company_id, uploaded_by, source, storage_path, original_filename, mime_type, file_size, checksum_sha256, external_message_id
) values
  ('e3000000-0000-0000-0000-000000000701', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'WEB_UPLOAD', 'quarantine/web.pdf', 'web.pdf', 'application/pdf', 100, repeat('a',64), null),
  ('e3000000-0000-0000-0000-000000000702', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'EMAIL', 'quarantine/email.pdf', 'email.pdf', 'application/pdf', 100, repeat('b',64), 'email-1');
reset role;

select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000701'), 'VALIDATED_INTERNAL', 'web conserva validación interna sin fingir antimalware');
select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000702'), 'PENDING_SCAN', 'correo entra siempre en cuarentena');

set local role authenticated;
set local request.jwt.claim.sub = 'e3000000-0000-0000-0000-000000000101';
select ok(public.can_read_expense_capture_path('quarantine/web.pdf'), 'el archivo web validado sigue disponible en el piloto interno');
select ok(not public.can_read_expense_capture_path('quarantine/email.pdf'), 'Storage no entrega bytes pendientes de scan');
reset role;

set local role service_role;
create temporary table first_scan as
select * from public.claim_expense_file_scans('e3000000-0000-0000-0000-000000000801', 1);
select is((select count(*)::integer from first_scan), 1, 'claim toma un archivo externo');
select is((select capture_id from first_scan), 'e3000000-0000-0000-0000-000000000702'::uuid, 'web nunca entra al worker de antimalware');
select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000702'), 'SCANNING', 'claim deja lease visible');
select throws_ok(
  $$select public.complete_expense_file_scan(
    'e3000000-0000-0000-0000-000000000702', 'e3000000-0000-0000-0000-000000000899',
    'CLEAN', 'scanner-test', 'OK'
  )$$,
  '40001', 'Lease de escaneo inexistente o vencida.', 'otro worker no puede inventar un veredicto'
);
select is(
  public.complete_expense_file_scan(
    'e3000000-0000-0000-0000-000000000702', 'e3000000-0000-0000-0000-000000000801',
    'CLEAN', 'scanner-test', 'OK'
  )::text,
  'CLEAN', 'la lease vigente libera el archivo'
);
select ok((select security_scanned_at is not null and security_scanner = 'scanner-test' from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000702'), 'queda evidencia mínima del veredicto');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'e3000000-0000-0000-0000-000000000101';
select ok(public.can_read_expense_capture_path('quarantine/email.pdf'), 'Storage permite leer solo después de CLEAN');
reset role;

select lives_ok($$
  insert into public.expense_receipts (
    id, company_id, report_id, item_id, version, storage_path, original_filename,
    mime_type, file_size, checksum_sha256, uploaded_by
  ) values (
    'e3000000-0000-0000-0000-000000000901', 'e3000000-0000-0000-0000-000000000001',
    'e3000000-0000-0000-0000-000000000401', 'e3000000-0000-0000-0000-000000000501', 1,
    'quarantine/email.pdf', 'email.pdf', 'application/pdf', 100, repeat('b',64),
    'e3000000-0000-0000-0000-000000000101'
  )
$$, 'un CLEAN puede convertirse en comprobante');
select is((select security_status::text from public.expense_receipts where id = 'e3000000-0000-0000-0000-000000000901'), 'CLEAN', 'el comprobante hereda CLEAN y su evidencia');
select is((select count(*)::integer from public.expense_ocr_jobs where receipt_id = 'e3000000-0000-0000-0000-000000000901'), 1, 'OCR se encola recién después de la liberación');

insert into public.expense_receipt_captures (
  id, company_id, uploaded_by, source, storage_path, original_filename, mime_type, file_size, checksum_sha256, external_message_id
) values ('e3000000-0000-0000-0000-000000000703', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'WHATSAPP', 'quarantine/rejected.pdf', 'wa.pdf', 'application/pdf', 100, repeat('c',64), 'wa-1');
select throws_ok($$
  insert into public.expense_receipts (
    company_id, report_id, item_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, uploaded_by
  ) values (
    'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000401',
    'e3000000-0000-0000-0000-000000000501', 2, 'quarantine/rejected.pdf', 'wa.pdf',
    'application/pdf', 100, repeat('c',64), 'e3000000-0000-0000-0000-000000000101'
  )
$$, '23514', 'El archivo permanece en cuarentena.', 'ni un insert privilegiado adjunta un archivo pendiente');

set local role service_role;
create temporary table rejected_scan as
select * from public.claim_expense_file_scans('e3000000-0000-0000-0000-000000000802', 1);
select is(public.complete_expense_file_scan(
  'e3000000-0000-0000-0000-000000000703', 'e3000000-0000-0000-0000-000000000802',
  'REJECTED', 'scanner-test', 'MALWARE'
)::text, 'REJECTED', 'el escáner puede bloquear sin exponer detalle sensible');
select is((select security_result_code from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000703'), 'MALWARE', 'el código sanitizado permite operar el incidente');
select ok(not public.can_read_expense_capture_path('quarantine/rejected.pdf'), 'un REJECTED nunca se entrega');

insert into public.expense_receipt_captures (
  id, company_id, uploaded_by, source, storage_path, original_filename, mime_type, file_size, checksum_sha256, external_message_id
) values ('e3000000-0000-0000-0000-000000000704', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'EMAIL', 'quarantine/retry.pdf', 'retry.pdf', 'application/pdf', 100, repeat('d',64), 'email-2');
create temporary table retry_scan as
select * from public.claim_expense_file_scans('e3000000-0000-0000-0000-000000000803', 1);
select is(public.fail_expense_file_scan(
  'e3000000-0000-0000-0000-000000000704', 'e3000000-0000-0000-0000-000000000803',
  'scanner-test', 'TIMEOUT', true, 1
), true, 'un fallo transitorio vuelve a cola');
select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000704'), 'PENDING_SCAN', 'el retry no libera el archivo');
update public.expense_receipt_captures set scan_available_at = now() - interval '1 second'
where id = 'e3000000-0000-0000-0000-000000000704';
create temporary table terminal_scan as
select * from public.claim_expense_file_scans('e3000000-0000-0000-0000-000000000804', 1);
select is(public.fail_expense_file_scan(
  'e3000000-0000-0000-0000-000000000704', 'e3000000-0000-0000-0000-000000000804',
  'scanner-test', 'ENGINE_ERROR', false, 1
), false, 'un fallo terminal no se reintenta');
select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000704'), 'SCAN_FAILED', 'el fallo terminal queda bloqueado y trazable');

insert into public.expense_receipt_captures (
  id, company_id, uploaded_by, source, storage_path, original_filename, mime_type, file_size, checksum_sha256, external_message_id
) values ('e3000000-0000-0000-0000-000000000705', 'e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000101', 'EMAIL', 'quarantine/stale.pdf', 'stale.pdf', 'application/pdf', 100, repeat('e',64), 'email-3');
create temporary table stale_scan as
select * from public.claim_expense_file_scans('e3000000-0000-0000-0000-000000000805', 1);
update public.expense_receipt_captures set scan_locked_at = now() - interval '10 minutes'
where id = 'e3000000-0000-0000-0000-000000000705';
select is(public.reclaim_stale_expense_file_scans(300), 1, 'un worker caído no deja cuarentena bloqueada');
select is((select security_status::text from public.expense_receipt_captures where id = 'e3000000-0000-0000-0000-000000000705'), 'PENDING_SCAN', 'la lease vencida vuelve a cola sin quedar CLEAN');

reset role;
update public.expense_receipts
set security_status = 'PENDING_SCAN', security_scanned_at = null,
    security_scanner = null, security_result_code = null
where id = 'e3000000-0000-0000-0000-000000000901';
select throws_ok(
  $$update public.expense_reports
    set status = 'SUBMITTED', submitted_at = now()
    where id = 'e3000000-0000-0000-0000-000000000401'$$,
  '23514', 'Un comprobante obligatorio permanece en cuarentena.',
  'una rendición no se envía usando un archivo no liberado'
);
reset role;

select * from finish();
rollback;
