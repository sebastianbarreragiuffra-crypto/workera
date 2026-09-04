-- pgTAP GESTORA Rendiciones EX-13 (parte 2): indicadores agregados y señales
-- de riesgo aisladas por empresa.
create extension if not exists pgtap;

begin;
select plan(22);

select has_function(
  'public', 'get_expense_indicators', array['uuid', 'integer'],
  'existe el agregado seguro de indicadores de Rendiciones'
);
select ok(
  not has_function_privilege('anon', 'public.get_expense_indicators(uuid, integer)', 'EXECUTE'),
  'anon nunca consulta indicadores financieros'
);
select ok(
  has_function_privilege('authenticated', 'public.get_expense_indicators(uuid, integer)', 'EXECUTE'),
  'authenticated puede invocar el RPC y queda sujeto a sus controles'
);
select has_index(
  'public', 'expense_reports', 'expense_reports_company_resolved_idx',
  'las rendiciones resueltas tienen un índice alineado con la ventana temporal'
);
select has_index(
  'public', 'expense_reports', 'expense_reports_company_active_created_idx',
  'las rendiciones no canceladas tienen un índice alineado con la ventana temporal'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled) values
  ('13000000-0000-0000-0000-000000000001', 'Indicadores Uno', 'Indicadores Uno SpA', 'indicadores-uno', true, 'ONBOARDING', false),
  ('13000000-0000-0000-0000-000000000002', 'Indicadores Dos', 'Indicadores Dos SpA', 'indicadores-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('13000000-0000-0000-0000-000000000101', 'Platform EX13', null, true),
  ('13000000-0000-0000-0000-000000000102', 'Rendidor EX13', null, true),
  ('13000000-0000-0000-0000-000000000103', 'Gestor EX13', null, true),
  ('13000000-0000-0000-0000-000000000104', 'Ajeno EX13', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('13000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('13000000-0000-0000-0000-000000000201', '13000000-0000-0000-0000-000000000102', '13000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('13000000-0000-0000-0000-000000000202', '13000000-0000-0000-0000-000000000103', '13000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('13000000-0000-0000-0000-000000000203', '13000000-0000-0000-0000-000000000104', '13000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = '13000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('13000000-0000-0000-0000-000000000202', '13000000-0000-0000-0000-000000000203') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status('13000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'se activa Rendiciones para la empresa consultada'
);
select lives_ok(
  $$select public.platform_set_company_module_status('13000000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$,
  'se activa Rendiciones para el tenant de control'
);
reset role;

update public.expense_policies ep
set rules = ep.rules || pg_catalog.jsonb_build_object(
  'categoryLimits', pg_catalog.jsonb_build_object(
    (
      select ec.id::text
      from public.expense_categories ec
      where ec.company_id = ep.company_id and ec.code = 'ALIMENTACION'
    ), 1000,
    (
      select ec.id::text
      from public.expense_categories ec
      where ec.company_id = ep.company_id and ec.code = 'OTROS'
    ), 500
  )
)
where ep.company_id = '13000000-0000-0000-0000-000000000001' and ep.active;

select throws_ok(
  $$update public.expense_policies ep
    set rules = pg_catalog.jsonb_set(
      ep.rules,
      array['categoryLimits', (
        select ec.id::text from public.expense_categories ec
        where ec.company_id = ep.company_id and ec.code = 'ALIMENTACION'
      )],
      pg_catalog.to_jsonb(('1' || repeat('0', 100000))::text)
    )
    where ep.company_id = '13000000-0000-0000-0000-000000000001' and ep.active$$,
  '23514', null,
  'la política rechaza límites sobredimensionados antes de que afecten los indicadores'
);

insert into public.expense_reports (
  id, company_id, submitted_by, policy_id, title, status, submitted_at, resolved_at, created_at
)
select report.id, '13000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000102',
  ep.id, report.title, report.status::public.expense_report_status,
  case when report.status = 'DRAFT' then null else pg_catalog.clock_timestamp() - interval '20 hours' end,
  case when report.status = 'DRAFT' then null else pg_catalog.clock_timestamp() - interval '10 hours' end,
  pg_catalog.clock_timestamp() - interval '2 days'
from (values
  ('13000000-0000-0000-0000-000000000301'::uuid, 'Aprobada EX13', 'APPROVED'),
  ('13000000-0000-0000-0000-000000000302'::uuid, 'Rechazada EX13', 'REJECTED'),
  ('13000000-0000-0000-0000-000000000303'::uuid, 'Respaldo faltante', 'DRAFT'),
  ('13000000-0000-0000-0000-000000000304'::uuid, 'OCR por revisar', 'DRAFT'),
  ('13000000-0000-0000-0000-000000000305'::uuid, 'OCR fallido', 'DRAFT'),
  ('13000000-0000-0000-0000-000000000306'::uuid, 'Comprobante duplicado', 'DRAFT')
) as report(id, title, status)
cross join lateral (
  select id from public.expense_policies
  where company_id = '13000000-0000-0000-0000-000000000001' and active
  order by version desc limit 1
) ep;

insert into public.expense_items (
  id, company_id, report_id, category_id, expense_date, description, net_amount
)
select item.id, '13000000-0000-0000-0000-000000000001', item.report_id,
  ec.id, current_date, item.description, item.amount
from (values
  ('13000000-0000-0000-0000-000000000401'::uuid, '13000000-0000-0000-0000-000000000301'::uuid, 'OTROS', 'Compra aprobada', 1000::numeric),
  ('13000000-0000-0000-0000-000000000402'::uuid, '13000000-0000-0000-0000-000000000302'::uuid, 'OTROS', 'Compra rechazada', 900::numeric),
  ('13000000-0000-0000-0000-000000000403'::uuid, '13000000-0000-0000-0000-000000000303'::uuid, 'ALIMENTACION', 'Sobre límite y sin respaldo', 2000::numeric),
  ('13000000-0000-0000-0000-000000000404'::uuid, '13000000-0000-0000-0000-000000000304'::uuid, 'ALIMENTACION', 'Revisión OCR', 500::numeric),
  ('13000000-0000-0000-0000-000000000405'::uuid, '13000000-0000-0000-0000-000000000305'::uuid, 'ALIMENTACION', 'Falla OCR', 500::numeric),
  ('13000000-0000-0000-0000-000000000406'::uuid, '13000000-0000-0000-0000-000000000306'::uuid, 'ALIMENTACION', 'Duplicado', 500::numeric)
) as item(id, report_id, category_code, description, amount)
join public.expense_categories ec
  on ec.company_id = '13000000-0000-0000-0000-000000000001' and ec.code = item.category_code;

insert into public.expense_receipts (
  id, company_id, report_id, item_id, version, storage_path, original_filename,
  mime_type, file_size, checksum_sha256, uploaded_by, status, extraction, duplicate_of_receipt_id
) values
  ('13000000-0000-0000-0000-000000000501', '13000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000304', '13000000-0000-0000-0000-000000000404', 1, 'ex13/review.pdf', 'review.pdf', 'application/pdf', 100, repeat('a', 64), '13000000-0000-0000-0000-000000000102', 'PROCESSED', '{"requiresHumanReview":true}'::jsonb, null),
  ('13000000-0000-0000-0000-000000000502', '13000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000305', '13000000-0000-0000-0000-000000000405', 1, 'ex13/failed.pdf', 'failed.pdf', 'application/pdf', 100, repeat('b', 64), '13000000-0000-0000-0000-000000000102', 'FAILED', '{}'::jsonb, null),
  ('13000000-0000-0000-0000-000000000503', '13000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000306', '13000000-0000-0000-0000-000000000406', 1, 'ex13/duplicate.pdf', 'duplicate.pdf', 'application/pdf', 100, repeat('a', 64), '13000000-0000-0000-0000-000000000102', 'PROCESSED', '{"requiresHumanReview":false}'::jsonb, '13000000-0000-0000-0000-000000000501');

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-0000-0000-000000000103';
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) ->> 'windowDays')::integer, 90, 'conserva la ventana solicitada');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) ->> 'resolvedCount')::integer, 2, 'cuenta rendiciones resueltas');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) ->> 'approvedCount')::integer, 1, 'cuenta aprobadas sin incluir rechazadas');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) ->> 'rejectedCount')::integer, 1, 'cuenta rechazadas');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{categoryBreakdown,0,itemCount}')::integer, 1, 'el gasto por categoría excluye rendiciones rechazadas');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,duplicateReceipts}')::integer, 1, 'detecta comprobantes duplicados vigentes');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,missingRequiredReceipts}')::integer, 1, 'detecta respaldos obligatorios faltantes');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,ocrReviewPending}')::integer, 1, 'detecta sugerencias OCR pendientes de revisión humana');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,ocrFailures}')::integer, 1, 'detecta fallos de procesamiento OCR');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,policyLimitExceededItems}')::integer, 1, 'detecta ítems abiertos sobre el límite sin incluir la rendición aprobada');
select is((public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90) #>> '{riskSignals,receiptCoveragePercent}')::numeric, 75::numeric, 'calcula cobertura de respaldos obligatorios');
set local request.jwt.claim.sub = '13000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90)$$,
  '42501', 'Tu rol no permite ver indicadores de esta empresa.',
  'quien solo rinde gastos no ve agregados de toda la empresa'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-0000-0000-000000000104';
select throws_ok(
  $$select public.get_expense_indicators('13000000-0000-0000-0000-000000000001', 90)$$,
  '42501', 'Tu rol no permite ver indicadores de esta empresa.',
  'otro tenant no puede consultar indicadores ajenos'
);
select throws_ok(
  $$select public.get_expense_indicators('13000000-0000-0000-0000-000000000002', 0)$$,
  '22023', 'La ventana de indicadores debe estar entre 1 y 365 días.',
  'la ventana inválida se rechaza antes de calcular'
);
reset role;

select * from finish();
rollback;
