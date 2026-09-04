-- pgTAP GESTORA Fase 4: outbox contable multiempresa e idempotente.
create extension if not exists pgtap;

begin;
set local request.jwt.claim.aal = 'aal2';
select plan(43);

select has_table('public', 'expense_accounting_exports', 'existe outbox contable');
select has_table('public', 'expense_accounting_export_events', 'existe bitácora contable');
select has_function('public', 'queue_expense_accounting_export', array['uuid','uuid'], 'existe encolado humano');
select has_function('public', 'list_expense_accounting_ready_reports', array['uuid'], 'existe bandeja contable mínima');
select has_function('public', 'claim_expense_accounting_exports', array['integer'], 'existe claim con lease');
select has_function('public', 'complete_expense_accounting_export', array['uuid','uuid','boolean','text','text','text','boolean'], 'existe cierre con fencing');
select ok(has_function_privilege('authenticated', 'public.queue_expense_accounting_export(uuid,uuid)', 'EXECUTE'), 'finanzas puede encolar vía RPC');
select ok(has_function_privilege('authenticated', 'public.list_expense_accounting_ready_reports(uuid)', 'EXECUTE'), 'finanzas puede listar la bandeja mínima');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_accounting_exports(integer)', 'EXECUTE'), 'el navegador no puede reclamar trabajos');
select ok(not has_function_privilege('authenticated', 'public.complete_expense_accounting_export(uuid,uuid,boolean,text,text,text,boolean)', 'EXECUTE'), 'el navegador no puede cerrar trabajos');
select ok(has_function_privilege('service_role', 'public.claim_expense_accounting_exports(integer)', 'EXECUTE'), 'el worker puede reclamar trabajos');
select is(
  (select count(*)::integer from regexp_matches(
    pg_get_functiondef('public.queue_expense_accounting_export(uuid,uuid)'::regprocedure),
    'company_has_module\(p_company_id', 'g'
  )),
  2,
  'encolado revalida autorización después de esperar el advisory lock'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('b1000000-0000-0000-0000-000000000001', 'Contable Uno', 'Contable Uno SpA', 'contable-uno', true, 'ONBOARDING', false),
  ('b1000000-0000-0000-0000-000000000002', 'Contable Dos', 'Contable Dos SpA', 'contable-dos', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values
  ('b1000000-0000-0000-0000-000000000101', 'Plataforma F4', null, true),
  ('b1000000-0000-0000-0000-000000000102', 'Rendidor F4', null, true),
  ('b1000000-0000-0000-0000-000000000103', 'Finanzas F4', null, true),
  ('b1000000-0000-0000-0000-000000000104', 'Finanzas Ajena F4', null, true);
insert into public.platform_memberships (user_id, role, active)
values ('b1000000-0000-0000-0000-000000000101', 'ADMIN', true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('b1000000-0000-0000-0000-000000000201', 'b1000000-0000-0000-0000-000000000102', 'b1000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('b1000000-0000-0000-0000-000000000202', 'b1000000-0000-0000-0000-000000000103', 'b1000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('b1000000-0000-0000-0000-000000000203', 'b1000000-0000-0000-0000-000000000104', 'b1000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = 'b1000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('b1000000-0000-0000-0000-000000000202','b1000000-0000-0000-0000-000000000203') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000101';
select public.platform_set_company_module_status('b1000000-0000-0000-0000-000000000001', 'expenses', 'PILOT');
select public.platform_set_company_module_status('b1000000-0000-0000-0000-000000000002', 'expenses', 'PILOT');
reset role;
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id = 'b1000000-0000-0000-0000-000000000001' and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code) values
  ('b1000000-0000-0000-0000-000000000301', 'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000102', 'Taxi pagado', 'CLP'),
  ('b1000000-0000-0000-0000-000000000302', 'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000102', 'Almuerzo borrador', 'CLP'),
  ('b1000000-0000-0000-0000-000000000303', 'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000102', 'Hotel pagado', 'CLP');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, merchant_name, description, net_amount, tax_amount)
select 'b1000000-0000-0000-0000-000000000401', 'b1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000301', ec.id, current_date, '=Proveedor', '+Taxi seguro', 10000, 1900
from public.expense_categories ec where ec.company_id = 'b1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'b1000000-0000-0000-0000-000000000403', 'b1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000303', ec.id, current_date, 'Alojamiento', 50000
from public.expense_categories ec where ec.company_id = 'b1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
select public.submit_expense_report('b1000000-0000-0000-0000-000000000301');
select public.submit_expense_report('b1000000-0000-0000-0000-000000000303');
select throws_ok(
  $$select public.queue_expense_accounting_export('b1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000301')$$,
  '42501', 'Tu rol no permite preparar salidas contables.', 'un rendidor no puede encolar salidas'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000103';
select public.decide_expense_report('b1000000-0000-0000-0000-000000000301', 'APPROVED', null);
select public.decide_expense_report('b1000000-0000-0000-0000-000000000303', 'APPROVED', null);
select public.reconcile_expense_report('b1000000-0000-0000-0000-000000000301', 'PAGO-F4-1');
select public.reconcile_expense_report('b1000000-0000-0000-0000-000000000303', 'PAGO-F4-2');
select is(
  (select count(*)::integer from public.list_expense_accounting_ready_reports('b1000000-0000-0000-0000-000000000001')),
  2,
  'finanzas ve las rendiciones pagadas pendientes en la bandeja mínima'
);
select throws_ok(
  $$select public.queue_expense_accounting_export('b1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000302')$$,
  '23514', 'Solo una rendición pagada puede enviarse a contabilidad.', 'un borrador nunca entra al outbox'
);
select ok(
  public.queue_expense_accounting_export('b1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000301') is not null,
  'finanzas encola una rendición pagada'
);
select is(
  public.queue_expense_accounting_export('b1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000301'),
  (select id from public.expense_accounting_exports where report_id = 'b1000000-0000-0000-0000-000000000301'),
  'repetir el comando devuelve la misma salida'
);
select is((select count(*)::integer from public.expense_accounting_exports), 1, 'idempotencia evita filas duplicadas');
select is(
  (select count(*)::integer from public.list_expense_accounting_ready_reports('b1000000-0000-0000-0000-000000000001')),
  1,
  'la bandeja deja de ofrecer cualquier rendición que ya tenga salida'
);
select is((select count(*)::integer from public.expense_accounting_export_events where event_type = 'QUEUED'), 1, 'idempotencia evita eventos duplicados');
select is((select status::text from public.expense_accounting_exports), 'QUEUED', 'el trabajo parte pendiente');
select is((select jsonb_array_length(payload->'lines') from public.expense_accounting_exports), 1, 'snapshot contiene sus líneas');
select ok((select payload ? 'company' and payload ? 'report' from public.expense_accounting_exports), 'snapshot identifica empresa y rendición');
select ok((select payload::text not like '%receipt_storage_path%' and payload::text not like '%extraction%' from public.expense_accounting_exports), 'snapshot no contiene comprobantes ni OCR');
select is((select char_length(idempotency_key) from public.expense_accounting_exports), 64, 'idempotencia usa SHA-256');
select is((select char_length(payload_sha256) from public.expense_accounting_exports), 64, 'snapshot lleva digest SHA-256');
select throws_ok(
  $$update public.expense_accounting_exports set status = 'SUCCEEDED'$$,
  '42501', null, 'el navegador no puede mutar el outbox directamente'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000104';
select is((select count(*)::integer from public.expense_accounting_exports), 0, 'RLS oculta salidas de otra empresa');
select throws_ok(
  $$select public.queue_expense_accounting_export('b1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000301')$$,
  '42501', 'Tu rol no permite preparar salidas contables.', 'otro tenant no puede encolar la rendición ajena'
);
select throws_ok(
  $$select * from public.list_expense_accounting_ready_reports('b1000000-0000-0000-0000-000000000001')$$,
  '42501', 'Tu rol no permite ver salidas contables.', 'otro tenant no puede listar la bandeja ajena'
);
reset role;

set local role service_role;
create temporary table f4_first_claim as select * from public.claim_expense_accounting_exports(10);
select is((select count(*)::integer from f4_first_claim), 1, 'worker reclama una salida');
reset role;
select is((select status::text from public.expense_accounting_exports), 'PROCESSING', 'claim activa el lease');
select is((select attempt_count from f4_first_claim), 1, 'claim incrementa intento');
select ok((select lease_token is not null from f4_first_claim) and (select lease_expires_at > now() from public.expense_accounting_exports), 'lease tiene token y vencimiento');
set local role service_role;
select is((select count(*)::integer from public.claim_expense_accounting_exports(10)), 0, 'SKIP LOCKED no reclama el trabajo en curso');
select throws_ok(
  $$select public.complete_expense_accounting_export((select export_id from f4_first_claim), gen_random_uuid(), true, 'X')$$,
  '23514', 'Lease contable inválido o vencido.', 'un token falso no puede cerrar el trabajo'
);

select is(
  public.complete_expense_accounting_export(
    (select export_id from f4_first_claim),
    (select lease_token from f4_first_claim),
    false, null, 'RATE_LIMIT', 'El proveedor rechazó temporalmente la solicitud.', true
  )::text,
  'RETRY', 'un error transitorio programa reintento'
);
reset role;
select ok((select available_at > now() and status = 'RETRY' from public.expense_accounting_exports), 'retry aplica backoff y libera lease');
update public.expense_accounting_exports set available_at = now() - interval '1 second';
set local role service_role;
create temporary table f4_claim as select * from public.claim_expense_accounting_exports(10);
select is((select attempt_count from f4_claim), 2, 'segundo claim incrementa el intento');
select is(
  public.complete_expense_accounting_export(
    (select export_id from f4_claim), (select lease_token from f4_claim), true, 'DRYRUN-F4-001'
  )::text,
  'SUCCEEDED', 'el adapter cierra con referencia externa'
);
reset role;
select ok((select status = 'SUCCEEDED' and exported_at is not null and external_reference = 'DRYRUN-F4-001' from public.expense_accounting_exports), 'éxito queda terminal y auditable');
select is((select count(*)::integer from public.expense_accounting_export_events where event_type = 'SUCCEEDED'), 1, 'éxito registra evento');

set local role postgres;
select ok(
  (select count(*) = 1 from public.expense_accounting_exports where company_id = 'b1000000-0000-0000-0000-000000000001'),
  'solo existe la salida del tenant esperado'
);
reset role;

select * from finish();
rollback;
