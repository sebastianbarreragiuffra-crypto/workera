-- pgTAP GESTORA Fase 6: asistente estructurado, tenant-aware y de solo lectura.
create extension if not exists pgtap;

begin;
select plan(60);

select has_table('public', 'expense_assistant_queries', 'existe bitácora mínima del asistente');
select has_type('public', 'expense_assistant_intent', 'las preguntas están allowlisted en un enum');
select has_function(
  'public', 'run_expense_readonly_assistant',
  array['uuid','expense_assistant_intent','integer'],
  'existe un único RPC estructurado'
);
select has_function(
  'public', 'purge_expired_expense_assistant_queries', array[]::text[],
  'existe una purga global independiente de la actividad del usuario'
);
select has_column('public', 'expense_assistant_queries', 'result', 'la respuesta estructurada queda verificable');
select has_column('public', 'expense_assistant_queries', 'result_sha256', 'cada respuesta lleva digest');
select hasnt_column('public', 'expense_assistant_queries', 'prompt', 'nunca se almacena texto libre');
select hasnt_column('public', 'expense_assistant_queries', 'message', 'nunca se almacena conversación');
select ok(
  has_function_privilege('authenticated', 'public.run_expense_readonly_assistant(uuid,public.expense_assistant_intent,integer)', 'EXECUTE'),
  'usuarios autorizados ejecutan solo el RPC'
);
select ok(
  not has_function_privilege('anon', 'public.run_expense_readonly_assistant(uuid,public.expense_assistant_intent,integer)', 'EXECUTE'),
  'anon no puede ejecutar el asistente'
);
select ok(
  has_function_privilege('service_role', 'public.purge_expired_expense_assistant_queries()', 'EXECUTE'),
  'solo el job interno puede ejecutar la purga global'
);
select ok(
  not has_function_privilege('authenticated', 'public.purge_expired_expense_assistant_queries()', 'EXECUTE'),
  'un usuario autenticado no puede borrar historiales'
);
select ok(has_table_privilege('authenticated', 'public.expense_assistant_queries', 'SELECT'), 'authenticated puede leer bajo RLS');
select ok(not has_table_privilege('authenticated', 'public.expense_assistant_queries', 'INSERT'), 'el navegador no inserta resultados');
select is(
  (select count(*)::integer from regexp_matches(
    pg_get_functiondef('public.run_expense_readonly_assistant(uuid,public.expense_assistant_intent,integer)'::regprocedure),
    'company_has_module\(p_company_id', 'g'
  )),
  2,
  'la autorización se revalida después del advisory lock'
);
select ok(
  pg_get_functiondef('public.run_expense_readonly_assistant(uuid,public.expense_assistant_intent,integer)'::regprocedure)
    !~* 'update[[:space:]]+public[.]expense_(reports|items|receipts|bank_transactions|accounting_exports)',
  'el RPC no contiene mutaciones de datos financieros'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('c1000000-0000-0000-0000-000000000001', 'Asistente Uno', 'Asistente Uno SpA', 'asistente-uno', true, 'ONBOARDING', false),
  ('c1000000-0000-0000-0000-000000000002', 'Asistente Dos', 'Asistente Dos SpA', 'asistente-dos', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values
  ('c1000000-0000-0000-0000-000000000101', 'Plataforma F6', null, true),
  ('c1000000-0000-0000-0000-000000000102', 'Rendidor F6', null, true),
  ('c1000000-0000-0000-0000-000000000103', 'Analista F6', null, true),
  ('c1000000-0000-0000-0000-000000000104', 'Analista Dos F6', null, true),
  ('c1000000-0000-0000-0000-000000000105', 'Colega F6', null, true),
  ('c1000000-0000-0000-0000-000000000106', 'Auditor F6', null, true);
insert into public.platform_memberships (user_id, role, active)
values ('c1000000-0000-0000-0000-000000000101', 'ADMIN', true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('c1000000-0000-0000-0000-000000000201', 'c1000000-0000-0000-0000-000000000102', 'c1000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('c1000000-0000-0000-0000-000000000202', 'c1000000-0000-0000-0000-000000000103', 'c1000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('c1000000-0000-0000-0000-000000000203', 'c1000000-0000-0000-0000-000000000104', 'c1000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true),
  ('c1000000-0000-0000-0000-000000000204', 'c1000000-0000-0000-0000-000000000105', 'c1000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('c1000000-0000-0000-0000-000000000205', 'c1000000-0000-0000-0000-000000000106', 'c1000000-0000-0000-0000-000000000001', 'SUPER_ADMIN', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = 'c1000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('c1000000-0000-0000-0000-000000000202','c1000000-0000-0000-0000-000000000203','c1000000-0000-0000-0000-000000000204') and cr.code = 'HR_ADMIN')
   or (cm.id = 'c1000000-0000-0000-0000-000000000205' and cr.code = 'AUDITOR');

set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status('c1000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'se habilita Rendiciones para la primera empresa'
);
select lives_ok(
  $$select public.platform_set_company_module_status('c1000000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$,
  'se habilita Rendiciones para la segunda empresa'
);
reset role;

-- Fixtures financieros. Se insertan como dueño del esquema para poder fijar
-- estados y fechas sin probar aquí los flujos ya cubiertos por EX-1..Fase 4.
insert into public.expense_reports (
  id, company_id, submitted_by, policy_id, title, currency_code,
  status, submitted_at, resolved_at, paid_at, paid_by, payment_reference
)
select 'c1000000-0000-0000-0000-000000000301', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000102', ep.id, 'Pendiente F6', 'CLP',
  'DRAFT', null, null, null, null, null
from public.expense_policies ep where ep.company_id = 'c1000000-0000-0000-0000-000000000001' and ep.active limit 1;
insert into public.expense_reports (
  id, company_id, submitted_by, policy_id, title, currency_code, status
)
select 'c1000000-0000-0000-0000-000000000302', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000102', ep.id, 'Borrador F6', 'CLP', 'DRAFT'
from public.expense_policies ep where ep.company_id = 'c1000000-0000-0000-0000-000000000001' and ep.active limit 1;
insert into public.expense_reports (
  id, company_id, submitted_by, title, currency_code, status, submitted_at, resolved_at
) values (
  'c1000000-0000-0000-0000-000000000303', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000102', 'Aprobada F6', 'CLP', 'DRAFT', null, null
);
insert into public.expense_reports (
  id, company_id, submitted_by, title, currency_code, status, submitted_at,
  resolved_at, paid_at, paid_by, payment_reference
) values
  ('c1000000-0000-0000-0000-000000000304', 'c1000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000102', 'Pagada con salida F6', 'CLP', 'DRAFT',
   null, null, null, null, null),
  ('c1000000-0000-0000-0000-000000000305', 'c1000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000102', 'Pagada sin salida F6', 'CLP', 'DRAFT',
   null, null, null, null, null),
  ('c1000000-0000-0000-0000-000000000306', 'c1000000-0000-0000-0000-000000000002',
   'c1000000-0000-0000-0000-000000000104', 'Rendición ajena F6', 'CLP', 'DRAFT',
   null, null, null, null, null);

insert into public.expense_items (
  id, company_id, report_id, category_id, expense_date, description, net_amount
)
select 'c1000000-0000-0000-0000-000000000401', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000301', ec.id, current_date - 2, 'Pendiente con respaldo', 10000
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000001' and ec.code = 'ALIMENTACION';
insert into public.expense_items (
  id, company_id, report_id, category_id, expense_date, description, net_amount
)
select 'c1000000-0000-0000-0000-000000000402', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000302', ec.id, current_date - 1, 'Sobre límite sin respaldo', 20000
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000001' and ec.code = 'ALIMENTACION';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'c1000000-0000-0000-0000-000000000403', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000303', ec.id, current_date - 2, 'Aprobado', 30000
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'c1000000-0000-0000-0000-000000000404', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000304', ec.id, current_date - 2, 'Pagado con salida', 40000
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'c1000000-0000-0000-0000-000000000405', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000305', ec.id, current_date - 2, 'Pagado sin salida', 50000
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'c1000000-0000-0000-0000-000000000406', 'c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000306', ec.id, current_date - 1, 'Dato de otra empresa', 999999
from public.expense_categories ec where ec.company_id = 'c1000000-0000-0000-0000-000000000002' and ec.code = 'OTROS';

update public.expense_policies ep
set rules = jsonb_build_object('categoryLimits', jsonb_build_object(
  (select ec.id::text from public.expense_categories ec
   where ec.company_id = ep.company_id and ec.code = 'ALIMENTACION'), 15000
))
where ep.company_id = 'c1000000-0000-0000-0000-000000000001' and ep.active;

insert into public.expense_receipts (
  id, company_id, report_id, item_id, version, storage_path, original_filename,
  mime_type, file_size, checksum_sha256, uploaded_by, status, extraction
) values (
  'c1000000-0000-0000-0000-000000000501', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000303', 'c1000000-0000-0000-0000-000000000403', 1,
  'f6/base.pdf', 'base.pdf', 'application/pdf', 100, repeat('a', 64),
  'c1000000-0000-0000-0000-000000000102', 'PROCESSED', '{}'::jsonb
);
insert into public.expense_receipts (
  id, company_id, report_id, item_id, version, storage_path, original_filename,
  mime_type, file_size, checksum_sha256, uploaded_by, status, extraction,
  duplicate_of_receipt_id
) values (
  'c1000000-0000-0000-0000-000000000502', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000301', 'c1000000-0000-0000-0000-000000000401', 1,
  'f6/duplicado.pdf', 'duplicado.pdf', 'application/pdf', 100, repeat('a', 64),
  'c1000000-0000-0000-0000-000000000102', 'FAILED', '{}'::jsonb,
  'c1000000-0000-0000-0000-000000000501'
);

update public.expense_reports
set status = 'SUBMITTED', submitted_at = now() - interval '2 days'
where id = 'c1000000-0000-0000-0000-000000000301';
update public.expense_reports
set status = 'APPROVED', submitted_at = now() - interval '3 days',
    resolved_at = now() - interval '2 days'
where id = 'c1000000-0000-0000-0000-000000000303';
update public.expense_reports
set status = 'PAID', submitted_at = now() - interval '4 days',
    resolved_at = now() - interval '3 days', paid_at = now() - interval '1 day',
    paid_by = 'c1000000-0000-0000-0000-000000000103', payment_reference = 'PAGO-F6-1'
where id = 'c1000000-0000-0000-0000-000000000304';
update public.expense_reports
set status = 'PAID', submitted_at = now() - interval '4 days',
    resolved_at = now() - interval '3 days', paid_at = now() - interval '1 day',
    paid_by = 'c1000000-0000-0000-0000-000000000103', payment_reference = 'PAGO-F6-2'
where id = 'c1000000-0000-0000-0000-000000000305';
update public.expense_reports
set status = 'SUBMITTED', submitted_at = now() - interval '1 day'
where id = 'c1000000-0000-0000-0000-000000000306';

insert into public.expense_bank_imports (
  id, company_id, uploaded_by, source_channel, content_checksum_sha256, row_count
) values (
  'c1000000-0000-0000-0000-000000000601', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000103', 'WEB_CSV', repeat('b', 64), 1
);
insert into public.expense_bank_transactions (
  id, company_id, import_id, source_row_number, transaction_date, amount,
  currency_code, bank_reference, match_fingerprint
) values (
  'c1000000-0000-0000-0000-000000000602', 'c1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000601', 1, current_date, 12345,
  'CLP', 'BANCO-SECRETO-F6', repeat('c', 64)
);

create temporary table f6_business_snapshot as
select 'reports'::text as kind, count(*)::bigint as row_count,
       md5(string_agg(id::text || ':' || status::text || ':' || total_amount::text, ',' order by id)) as digest
from public.expense_reports
union all
select 'items', count(*), md5(string_agg(id::text || ':' || total_amount::text, ',' order by id))
from public.expense_items
union all
select 'receipts', count(*), md5(string_agg(id::text || ':' || status::text, ',' order by id))
from public.expense_receipts;

set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'ACTION_REQUIRED', 30)$$,
  '42501', 'Tu rol no permite usar el asistente de esta empresa.',
  'un rendidor no recibe agregados de toda la empresa'
);
reset role;

-- Un auditor tiene lectura agregada, pero no puede cruzar la frontera de
-- conciliación. Incluso un resultado histórico de pagos queda oculto si su
-- permiso vigente ya no autoriza esa intención.
insert into public.expense_assistant_queries (
  company_id, actor_id, intent, window_days, result, result_sha256, citation_count
) values (
  'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000106',
  'PAYMENT_STATUS', 30,
  '{"schemaVersion":1,"intent":"PAYMENT_STATUS","windowDays":30,"generatedAt":"2026-01-01T00:00:00Z","summary":{},"citations":[]}',
  repeat('f', 64), 0
);
set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000106';
select lives_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'ACTION_REQUIRED', 30)$$,
  'un auditor puede consultar alertas agregadas'
);
select throws_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'PAYMENT_STATUS', 30)$$,
  '42501', 'Tu rol no permite usar el asistente de esta empresa.',
  'un auditor sin conciliación no puede resumir bancos ni contabilidad'
);
select is(
  (select count(*)::integer from public.expense_assistant_queries),
  1, 'RLS oculta también un resultado histórico de una intención revocada'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000103';
create temporary table f6_queries (intent text primary key, query_id uuid not null);
insert into f6_queries values (
  'ACTION_REQUIRED',
  public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'ACTION_REQUIRED', 30)
);
select ok((select query_id is not null from f6_queries where intent = 'ACTION_REQUIRED'), 'el analista obtiene una consulta identificable');
select is((select count(*)::integer from public.expense_assistant_queries), 1, 'la consulta crea una sola bitácora propia');
select is((select intent::text from public.expense_assistant_queries), 'ACTION_REQUIRED', 'la intención queda tipada');
select is((select window_days::integer from public.expense_assistant_queries), 30, 'la ventana queda registrada');
select ok((select result_sha256 = encode(extensions.digest(result::text::bytea, 'sha256'), 'hex') from public.expense_assistant_queries), 'el digest corresponde a la respuesta');
select ok((select citation_count = jsonb_array_length(result->'citations') from public.expense_assistant_queries), 'el contador corresponde a las citas');
select is((select (result->'summary'->>'pendingApprovalReports')::integer from public.expense_assistant_queries), 1, 'detecta la rendición pendiente de aprobación');
select is((select (result->'summary'->>'missingRequiredReceiptItems')::integer from public.expense_assistant_queries), 1, 'detecta el respaldo obligatorio faltante');
select is((select (result->'summary'->>'duplicateReceipts')::integer from public.expense_assistant_queries), 1, 'detecta el comprobante repetido');
select is((select (result->'summary'->>'ocrFailures')::integer from public.expense_assistant_queries), 1, 'el mismo comprobante también conserva su fallo OCR');
select is((select (result->'summary'->>'policyLimitExceededItems')::integer from public.expense_assistant_queries), 1, 'detecta el ítem sobre límite');
select ok((select citation_count between 1 and 12 from public.expense_assistant_queries), 'las citas quedan acotadas');
select ok(
  (select result::text not like '%999999%' and result::text not like '%Dato de otra empresa%' from public.expense_assistant_queries),
  'la respuesta no mezcla datos del segundo tenant'
);
select ok(
  (select result::text not like '%Rendidor F6%' and result::text not like '%BANCO-SECRETO-F6%' and result::text not like '%.pdf%' from public.expense_assistant_queries),
  'la respuesta no conserva nombres, referencias bancarias ni archivos'
);
select throws_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'SPEND_SUMMARY', 8)$$,
  '22023', 'La ventana debe ser 7, 30 o 90 días.', 'una ventana arbitraria falla cerrada'
);

insert into f6_queries values (
  'SPEND_SUMMARY',
  public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'SPEND_SUMMARY', 30)
);
select is(
  (select (q.result->'summary'->>'reportCount')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id = q.id where x.intent = 'SPEND_SUMMARY'),
  3, 'el resumen de gasto cuenta aprobadas y pagadas'
);
select is(
  (select (q.result->'summary'->>'approvedReports')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id = q.id where x.intent = 'SPEND_SUMMARY'),
  1, 'separa aprobadas'
);
select is(
  (select (q.result->'summary'->>'paidReports')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id = q.id where x.intent = 'SPEND_SUMMARY'),
  2, 'separa pagadas'
);
select is(
  (select (totals.value->>'totalAmount')::numeric
   from public.expense_assistant_queries q join f6_queries x on x.query_id = q.id
   cross join lateral jsonb_array_elements(q.result->'summary'->'totals') totals
   where x.intent = 'SPEND_SUMMARY' and totals.value->>'currencyCode' = 'CLP'),
  120000::numeric, 'el total monetario se calcula en base, nunca en el navegador'
);

-- La salida contable de una de las dos pagadas permite distinguir lo que aún
-- no ha ingresado al outbox.
select ok(
  public.queue_expense_accounting_export(
    'c1000000-0000-0000-0000-000000000001',
    'c1000000-0000-0000-0000-000000000304'
  ) is not null,
  'se prepara una salida contable para el fixture'
);
insert into f6_queries values (
  'PAYMENT_STATUS',
  public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'PAYMENT_STATUS', 30)
);
select is(
  (select (q.result->'summary'->>'approvedAwaitingPayment')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  1, 'detecta aprobadas que esperan pago'
);
select is(
  (select (q.result->'summary'->>'paidInWindow')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  2, 'detecta pagos de la ventana'
);
select is(
  (select (q.result->'summary'->>'unmatchedBankTransactions')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  1, 'detecta movimientos bancarios pendientes sin exponerlos'
);
select is(
  (select (q.result->'summary'->>'paidWithoutAccountingExport')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  1, 'detecta pagadas aún no enviadas a contabilidad'
);
select is(
  (select (q.result->'summary'->>'accountingInProgress')::integer from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  1, 'detecta la salida contable en curso'
);
select ok(
  (select jsonb_array_length(q.result->'citations') >= 3 from public.expense_assistant_queries q join f6_queries x on x.query_id=q.id where x.intent='PAYMENT_STATUS'),
  'el estado de pagos incluye evidencia navegable'
);

select throws_ok(
  $$update public.expense_assistant_queries set window_days = 90$$,
  '42501', null, 'el navegador no altera la bitácora'
);
select throws_ok(
  $$delete from public.expense_assistant_queries$$,
  '42501', null, 'el navegador no borra la bitácora'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000105';
select is((select count(*)::integer from public.expense_assistant_queries), 0, 'un colega del mismo tenant solo ve sus propias consultas');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000104';
select is((select count(*)::integer from public.expense_assistant_queries), 0, 'RLS oculta consultas del otro tenant');
select throws_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'ACTION_REQUIRED', 30)$$,
  '42501', 'Tu rol no permite usar el asistente de esta empresa.', 'otro tenant no puede consultar la empresa ajena'
);
reset role;

-- Ninguna de las tres preguntas pudo modificar el dominio financiero.
select is(
  (select md5(string_agg(id::text || ':' || status::text || ':' || total_amount::text, ',' order by id)) from public.expense_reports),
  (select digest from f6_business_snapshot where kind = 'reports'),
  'las rendiciones quedan byte-a-byte en el mismo estado lógico'
);
select is(
  (select md5(string_agg(id::text || ':' || total_amount::text, ',' order by id)) from public.expense_items),
  (select digest from f6_business_snapshot where kind = 'items'),
  'los ítems no cambian'
);
select is(
  (select md5(string_agg(id::text || ':' || status::text, ',' order by id)) from public.expense_receipts),
  (select digest from f6_business_snapshot where kind = 'receipts'),
  'los comprobantes no cambian'
);

insert into public.expense_assistant_queries (
  company_id, actor_id, intent, window_days, result, result_sha256,
  citation_count, created_at
) values
  (
    'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000103',
    'ACTION_REQUIRED', 30,
    '{"schemaVersion":1,"intent":"ACTION_REQUIRED","windowDays":30,"generatedAt":"2026-01-01T00:00:00Z","summary":{},"citations":[]}',
    repeat('d', 64), 0, now() - interval '91 days'
  ),
  (
    'c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000104',
    'ACTION_REQUIRED', 30,
    '{"schemaVersion":1,"intent":"ACTION_REQUIRED","windowDays":30,"generatedAt":"2026-01-01T00:00:00Z","summary":{},"citations":[]}',
    repeat('d', 64), 0, now() - interval '91 days'
  );
set local role service_role;
select is(
  public.purge_expired_expense_assistant_queries(), 2,
  'el job interno purga historiales inactivos de todas las empresas'
);
reset role;
select is(
  (select count(*)::integer from public.expense_assistant_queries where created_at < now() - interval '90 days'),
  0, 'las respuestas sanitizadas expiran a los 90 días'
);

-- Completa la cuota bajo el mismo lock lógico y comprueba que el intento 31
-- falla antes de calcular o insertar otra respuesta.
insert into public.expense_assistant_queries (
  company_id, actor_id, intent, window_days, result, result_sha256, citation_count
)
select
  'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000103',
  'ACTION_REQUIRED', 30,
  '{"schemaVersion":1,"intent":"ACTION_REQUIRED","windowDays":30,"generatedAt":"2026-01-01T00:00:00Z","summary":{},"citations":[]}',
  repeat('e', 64), 0
from generate_series(
  1,
  30 - (select count(*)::integer from public.expense_assistant_queries
        where company_id = 'c1000000-0000-0000-0000-000000000001'
          and actor_id = 'c1000000-0000-0000-0000-000000000103'
          and created_at >= now() - interval '1 hour')
);
set local role authenticated;
set local request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000103';
select throws_ok(
  $$select public.run_expense_readonly_assistant('c1000000-0000-0000-0000-000000000001', 'ACTION_REQUIRED', 30)$$,
  '54000', 'Superaste el máximo de consultas del asistente por hora.', 'la cuota durable evita abuso'
);
select ok(
  (select bool_and(pg_column_size(result) <= 65536 and citation_count <= 12) from public.expense_assistant_queries),
  'todas las respuestas respetan límites de tamaño y evidencia'
);
reset role;

select * from finish();
rollback;
