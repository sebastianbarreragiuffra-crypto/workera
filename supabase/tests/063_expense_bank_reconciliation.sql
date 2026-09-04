-- pgTAP GESTORA Fase 3: importación bancaria y conciliación humana.
create extension if not exists pgtap;

begin;
select plan(56);

select has_table('public', 'expense_bank_imports', 'existe el encabezado de importación bancaria');
select has_table('public', 'expense_bank_import_usage_windows', 'existe cuota durable de intentos y bytes');
select has_table('public', 'expense_bank_transactions', 'existen movimientos bancarios mínimos');
select has_table('public', 'expense_reconciliation_events', 'existe auditoría de conciliación');
select has_function('public', 'import_expense_bank_statement', array['uuid','uuid','text','jsonb'], 'existe importación atómica solo para backend');
select has_function('public', 'claim_expense_bank_upload', array['uuid','uuid','bigint'], 'existe reserva de cuota previa al streaming HTTP');
select has_function('public', 'list_expense_reconciliation_candidates', array['uuid','uuid'], 'existen sugerencias deterministas');
select has_function('public', 'match_expense_bank_transaction', array['uuid','uuid','text'], 'existe confirmación humana atómica');
select has_function('public', 'ignore_expense_bank_transaction', array['uuid','text'], 'existe resolución por descarte');
select ok(not has_function_privilege('authenticated', 'public.import_expense_bank_statement(uuid,uuid,text,jsonb)', 'EXECUTE'), 'el navegador no puede enviar JSON directo al RPC');
select ok(has_function_privilege('service_role', 'public.import_expense_bank_statement(uuid,uuid,text,jsonb)', 'EXECUTE'), 'solo el backend puede invocar la importación');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_bank_upload(uuid,uuid,bigint)', 'EXECUTE'), 'el navegador no puede reservar cuota fingiendo otro actor');
select ok(has_function_privilege('service_role', 'public.claim_expense_bank_upload(uuid,uuid,bigint)', 'EXECUTE'), 'solo el backend puede reservar la carga');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('a1000000-0000-0000-0000-000000000001', 'Banco Uno', 'Banco Uno SpA', 'banco-uno', true, 'ONBOARDING', false),
  ('a1000000-0000-0000-0000-000000000002', 'Banco Dos', 'Banco Dos SpA', 'banco-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('a1000000-0000-0000-0000-000000000101', 'Plataforma F3', null, true),
  ('a1000000-0000-0000-0000-000000000102', 'Rendidor F3', null, true),
  ('a1000000-0000-0000-0000-000000000103', 'Finanzas F3', null, true),
  ('a1000000-0000-0000-0000-000000000104', 'Finanzas Ajena F3', null, true);
insert into public.platform_memberships (user_id, role, active)
values ('a1000000-0000-0000-0000-000000000101', 'ADMIN', true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('a1000000-0000-0000-0000-000000000201', 'a1000000-0000-0000-0000-000000000102', 'a1000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('a1000000-0000-0000-0000-000000000202', 'a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('a1000000-0000-0000-0000-000000000203', 'a1000000-0000-0000-0000-000000000104', 'a1000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = 'a1000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('a1000000-0000-0000-0000-000000000202','a1000000-0000-0000-0000-000000000203') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('a1000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones para empresa uno');
select lives_ok($$select public.platform_set_company_module_status('a1000000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$, 'se activa Rendiciones para empresa dos');
reset role;

set local role service_role;
select lives_ok(
  $$select public.claim_expense_bank_upload('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 2097152)$$,
  'el backend descuenta cuota antes de leer el CSV'
);
select throws_ok(
  $$select public.claim_expense_bank_upload('a1000000-0000-0000-0000-000000000104', 'a1000000-0000-0000-0000-000000000001', 2097152)$$,
  '42501', 'Tu rol no permite importar cartolas.', 'otro tenant no puede reservar una carga ajena'
);
reset role;
select is(
  (select count(*)::integer from public.expense_bank_import_usage_windows where scope_key like 'INGRESS:%'),
  2, 'la reserva crea contadores separados por empresa y actor'
);

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code) values
  ('a1000000-0000-0000-0000-000000000301', 'a1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000102', 'Viaje exacto', 'CLP'),
  ('a1000000-0000-0000-0000-000000000302', 'a1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000102', 'Viaje distinto', 'CLP'),
  ('a1000000-0000-0000-0000-000000000303', 'a1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000102', 'Viaje antiguo', 'CLP');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'a1000000-0000-0000-0000-000000000401', 'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000301', ec.id, current_date - 2, 'Pasaje exacto', 40000
from public.expense_categories ec where ec.company_id = 'a1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'a1000000-0000-0000-0000-000000000403', 'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000303', ec.id, current_date - 62, 'Pasaje antiguo', 40000
from public.expense_categories ec where ec.company_id = 'a1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select 'a1000000-0000-0000-0000-000000000402', 'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000302', ec.id, current_date - 2, 'Pasaje distinto', 50000
from public.expense_categories ec where ec.company_id = 'a1000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
select lives_ok($$select public.submit_expense_report('a1000000-0000-0000-0000-000000000301')$$, 'se envía la rendición exacta');
select lives_ok($$select public.submit_expense_report('a1000000-0000-0000-0000-000000000302')$$, 'se envía la rendición de monto distinto');
select public.submit_expense_report('a1000000-0000-0000-0000-000000000303');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000103';
select lives_ok($$select public.decide_expense_report('a1000000-0000-0000-0000-000000000301', 'APPROVED', null)$$, 'finanzas aprueba la exacta');
select lives_ok($$select public.decide_expense_report('a1000000-0000-0000-0000-000000000302', 'APPROVED', null)$$, 'finanzas aprueba la distinta');
select public.decide_expense_report('a1000000-0000-0000-0000-000000000303', 'APPROVED', null);
reset role;
update public.expense_reports set created_at = now() - interval '60 days', submitted_at = now() - interval '60 days'
where id = 'a1000000-0000-0000-0000-000000000303';
set local role service_role;

select ok(
  public.import_expense_bank_statement(
    'a1000000-0000-0000-0000-000000000103',
    'a1000000-0000-0000-0000-000000000001', 'WEB_CSV',
    jsonb_build_array(
      jsonb_build_object('date', current_date::text, 'amount', '40000', 'currency', 'CLP', 'reference', 'TRX-001', 'description', 'Reembolso'),
      jsonb_build_object('date', current_date::text, 'amount', '999', 'currency', 'CLP', 'reference', 'TRX-002', 'description', 'Movimiento ajeno'),
      jsonb_build_object('date', current_date::text, 'amount', '40000', 'currency', 'CLP', 'reference', 'TRX-003', 'description', 'Reembolso antiguo')
    )
  ) is not null,
  'se importa una cartola válida'
);
select is((select count(*)::integer from public.expense_bank_transactions where company_id = 'a1000000-0000-0000-0000-000000000001'), 3, 'la importación es completa');
select ok((select bool_and(status = 'UNMATCHED') from public.expense_bank_transactions where company_id = 'a1000000-0000-0000-0000-000000000001'), 'los movimientos parten sin resolver');
select is(
  public.import_expense_bank_statement(
    'a1000000-0000-0000-0000-000000000103',
    'a1000000-0000-0000-0000-000000000001', 'BANK_API',
    jsonb_build_array(
      jsonb_build_object('reference', 'TRX-003', 'currency', 'CLP', 'amount', '40000', 'date', current_date::text, 'description', 'Reembolso antiguo'),
      jsonb_build_object('reference', 'TRX-001', 'currency', 'CLP', 'amount', '40000', 'date', current_date::text, 'description', 'Reembolso'),
      jsonb_build_object('reference', 'TRX-002', 'currency', 'CLP', 'amount', '999', 'date', current_date::text, 'description', 'Movimiento ajeno')
    )
  ),
  (select id from public.expense_bank_imports where company_id = 'a1000000-0000-0000-0000-000000000001'),
  'el digest canónico detecta el mismo contenido aunque cambien fuente y orden'
);
select is((select count(*)::integer from public.expense_bank_transactions where company_id = 'a1000000-0000-0000-0000-000000000001'), 3, 'el reintento no duplica movimientos');
select is(
  public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-99-99","amount":"1","currency":"CLP","reference":"X"}]'::jsonb),
  null::uuid, 'una fecha imposible aborta toda la importación y consume cuota'
);
select is(
  public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', null),
  null::uuid, 'un payload nulo falla cerrado y consume un intento'
);
select is(
  public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"X","account_number":"123"}]'::jsonb),
  null::uuid, 'el RPC rechaza campos bancarios no contemplados'
);
select is(
  public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":{"value":"X"}}]'::jsonb),
  null::uuid, 'los campos bancarios deben ser escalares de texto'
);
select is(
  public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"ABC\u202edef"}]'::jsonb),
  null::uuid, 'se rechazan controles bidi que podrían falsear la referencia visible'
);
select throws_ok(
  $$select public.import_expense_bank_statement(
    'a1000000-0000-0000-0000-000000000103',
    'a1000000-0000-0000-0000-000000000001', 'WEB_CSV',
    jsonb_build_array(jsonb_build_object(
      'date','2026-09-01','amount','1','currency','CLP','reference','X','description',
      (select string_agg(md5(i::text), '') from generate_series(1,70000) i)
    ))
  )$$,
  '54000', 'El payload de la cartola supera 2 MB.', 'el RPC conserva el código operativo del tope aunque se omita la ruta HTTP'
);
set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000103';
select throws_ok(
  $$ select count(*) from public.expense_bank_import_usage_windows $$,
  '42501',
  null,
  'las cuotas internas no son legibles desde el navegador'
);
reset role;
select ok(
  (select attempt_count >= 7 from public.expense_bank_import_usage_windows
   where company_id = 'a1000000-0000-0000-0000-000000000001' and scope_key = 'COMPANY'),
  'duplicados y payloads de validación rechazados conservan consumo de cuota'
);
set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000103';

select is(
  (select count(*)::integer from public.list_expense_reconciliation_candidates(
    'a1000000-0000-0000-0000-000000000001',
    (select id from public.expense_bank_transactions where bank_reference = 'TRX-001')
  )), 1,
  'las reglas sugieren solo monto y moneda exactos'
);
select is(
  (select report_id from public.list_expense_reconciliation_candidates(
    'a1000000-0000-0000-0000-000000000001',
    (select id from public.expense_bank_transactions where bank_reference = 'TRX-001')
  )), 'a1000000-0000-0000-0000-000000000301'::uuid,
  'la sugerencia apunta a la rendición correcta'
);
select ok(
  (select score >= 100 from public.list_expense_reconciliation_candidates(
    'a1000000-0000-0000-0000-000000000001',
    (select id from public.expense_bank_transactions where bank_reference = 'TRX-001')
  )), 'la puntuación determinista queda visible'
);
select throws_ok(
  $$select public.match_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-001'), 'a1000000-0000-0000-0000-000000000302', 'MANUAL')$$,
  '23514', 'Monto o moneda no coinciden.', 'no se puede confirmar un monto diferente'
);
select throws_ok(
  $$select public.match_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-001'), 'a1000000-0000-0000-0000-000000000301', null)$$,
  '23514', 'Método inválido.', 'un método nulo nunca se acepta implícitamente'
);
select lives_ok(
  $$select public.match_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-001'), 'a1000000-0000-0000-0000-000000000301', 'SUGGESTED')$$,
  'la persona confirma la sugerencia'
);
select ok((select status = 'PAID' and payment_reference = 'BANCO TRX-001' from public.expense_reports where id = 'a1000000-0000-0000-0000-000000000301'), 'confirmar marca la rendición pagada');
select ok((select status = 'MATCHED' and matched_report_id = 'a1000000-0000-0000-0000-000000000301' and match_method = 'SUGGESTED' from public.expense_bank_transactions where bank_reference = 'TRX-001'), 'confirmar enlaza el movimiento');
select is((select count(*)::integer from public.expense_reconciliation_events where event_type = 'MATCHED'), 1, 'la confirmación queda auditada');
select throws_ok(
  $$select public.match_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-001'), 'a1000000-0000-0000-0000-000000000301', 'MANUAL')$$,
  '23514', 'El movimiento ya fue resuelto.', 'el mismo movimiento no se confirma dos veces'
);
reset role;
set local role service_role;
select public.import_expense_bank_statement(
  'a1000000-0000-0000-0000-000000000103',
  'a1000000-0000-0000-0000-000000000001', 'BANK_API',
  jsonb_build_array(jsonb_build_object(
    'date', current_date::text, 'amount', '40000', 'currency', 'CLP',
    'reference', 'TRX-001', 'description', 'Duplicado lógico'
  ))
);
reset role;
set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000103';
select throws_ok(
  $$select public.match_expense_bank_transaction(
    (select id from public.expense_bank_transactions where description = 'Duplicado lógico'),
    'a1000000-0000-0000-0000-000000000303', 'MANUAL'
  )$$,
  '23514', 'Este pago bancario ya fue conciliado.', 'una copia lógica del mismo pago no puede pagar otra rendición'
);
select lives_ok(
  $$select public.ignore_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-002'), 'No corresponde a una rendición')$$,
  'finanzas puede descartar un movimiento ajeno'
);
select ok((select status = 'IGNORED' and ignored_reason is not null from public.expense_bank_transactions where bank_reference = 'TRX-002'), 'el descarte conserva motivo y estado');
select lives_ok(
  $$select public.match_expense_bank_transaction((select id from public.expense_bank_transactions where bank_reference='TRX-003'), 'a1000000-0000-0000-0000-000000000303', 'SUGGESTED')$$,
  'una rendición antigua aún se puede conciliar manualmente'
);
select ok(
  (select match_method = 'MANUAL' from public.expense_bank_transactions where bank_reference = 'TRX-003'),
  'el servidor deriva MANUAL y no permite falsificar una sugerencia fuera de 45 días'
);
select throws_ok(
  $$update public.expense_bank_transactions set status = 'UNMATCHED' where bank_reference = 'TRX-002'$$,
  '42501', null, 'el navegador no puede reescribir conciliaciones directamente'
);
reset role;

-- Las cuotas se evalúan dentro de un lock por empresa. Se preparan cinco
-- importaciones históricas y se prueban por separado el límite del actor y el
-- máximo de pendientes.
insert into public.expense_bank_imports (
  id, company_id, uploaded_by, source_channel, content_checksum_sha256, row_count, imported_at
)
select ('a2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'a1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000103',
  'WEB_CSV', md5('cuota-a-' || i) || md5('cuota-b-' || i), 2000, now()
from generate_series(1, 5) i;
set local role service_role;
select throws_ok(
  $$select public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"X"}]'::jsonb)$$,
  '54000', 'Superaste el máximo de 10.000 movimientos importados en 24 horas.', 'el RPC limita volumen por actor y conserva el código operativo'
);
reset role;
update public.expense_bank_imports set imported_at = now() - interval '2 days'
where id::text like 'a2000000-0000-0000-0000-%';
insert into public.expense_bank_transactions (
  company_id, import_id, source_row_number, transaction_date, amount, currency_code,
  bank_reference, description, match_fingerprint
)
select 'a1000000-0000-0000-0000-000000000001', i.id, g.n, current_date, 1, 'CLP',
  'CAP-' || i.id::text || '-' || g.n, null,
  md5(i.id::text || ':' || g.n) || md5('b:' || i.id::text || ':' || g.n)
from public.expense_bank_imports i
cross join lateral generate_series(1, 2000) g(n)
where i.id::text like 'a2000000-0000-0000-0000-%';
set local role service_role;
select throws_ok(
  $$select public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"X"}]'::jsonb)$$,
  '54000', 'Resuelve movimientos pendientes antes de importar otra cartola.', 'el RPC limita el backlog y conserva el código operativo'
);
reset role;
delete from public.expense_bank_transactions where import_id::text like 'a2000000-0000-0000-0000-%';
delete from public.expense_bank_imports where id::text like 'a2000000-0000-0000-0000-%';
update public.expense_bank_import_usage_windows set attempt_count = 100
where company_id = 'a1000000-0000-0000-0000-000000000001' and scope_key = 'COMPANY';
set local role service_role;
select throws_ok(
  $$select public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000103', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"CUOTA"}]'::jsonb)$$,
  '54000', 'La empresa superó la cuota horaria de importación bancaria.', 'la cuota empresarial corta antes del procesamiento costoso'
);
reset role;
delete from public.expense_bank_import_usage_windows where company_id = 'a1000000-0000-0000-0000-000000000001';

set local role service_role;
select throws_ok(
  $$select public.import_expense_bank_statement('a1000000-0000-0000-0000-000000000104', 'a1000000-0000-0000-0000-000000000001', 'WEB_CSV', '[{"date":"2026-09-01","amount":"1","currency":"CLP","reference":"X"}]'::jsonb)$$,
  '42501', 'Tu rol no permite importar cartolas.', 'otro tenant no puede importar en la empresa ajena'
);
reset role;
set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000104';
select is((select count(*)::integer from public.expense_bank_transactions where company_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'RLS oculta los movimientos del otro tenant');
reset role;

select * from finish();
rollback;
