-- pgTAP GESTORA EX-2: configuración automática y envío de rendiciones.
create extension if not exists pgtap;

begin;
select plan(24);

select has_table('public', 'expense_report_sequences', 'existe secuencia tenant-aware de folios');
select has_column('public', 'expense_reports', 'reference_number', 'cada rendición tiene folio visible');
select has_function('public', 'submit_expense_report', array['uuid'], 'existe RPC seguro de envío');
select has_function('public', 'expense_dashboard_summary', array['uuid'], 'existe resumen agregado para el dashboard');
select ok(has_function_privilege('authenticated', 'public.submit_expense_report(uuid)', 'EXECUTE'), 'authenticated puede invocar el flujo cerrado');
select ok(not has_function_privilege('anon', 'public.submit_expense_report(uuid)', 'EXECUTE'), 'anon no puede invocar el envío');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('96000000-0000-0000-0000-000000000001', 'Rendiciones Uno', 'Rendiciones Uno SpA', 'rendiciones-uno', true, 'ONBOARDING', false),
  ('96000000-0000-0000-0000-000000000002', 'Rendiciones Dos', 'Rendiciones Dos SpA', 'rendiciones-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('96000000-0000-0000-0000-000000000101', 'Platform EX2', null, true),
  ('96000000-0000-0000-0000-000000000102', 'Rendidor Uno', null, true),
  ('96000000-0000-0000-0000-000000000103', 'Rendidor Dos', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('96000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('96000000-0000-0000-0000-000000000201', '96000000-0000-0000-0000-000000000102', '96000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('96000000-0000-0000-0000-000000000202', '96000000-0000-0000-0000-000000000103', '96000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id in ('96000000-0000-0000-0000-000000000201', '96000000-0000-0000-0000-000000000202');

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status('96000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'activar Rendiciones provisiona su configuración en la misma operación'
);
reset role;

select is((select count(*)::integer from public.expense_categories where company_id = '96000000-0000-0000-0000-000000000001'), 5, 'se crean cinco categorías iniciales');
select is((select count(*)::integer from public.expense_policies where company_id = '96000000-0000-0000-0000-000000000001'), 1, 'se crea una política general');
select is((select count(*)::integer from public.expense_categories where company_id = '96000000-0000-0000-0000-000000000002'), 0, 'la configuración no se filtra a otro tenant');

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title) values
  ('96000000-0000-0000-0000-000000000301', '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000102', 'Viaje comercial'),
  ('96000000-0000-0000-0000-000000000302', '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000102', 'Compra menor');

select is((select reference_number from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'), 'RND-2026-000001', 'el primer borrador recibe folio correlativo');
select is((select reference_number from public.expense_reports where id = '96000000-0000-0000-0000-000000000302'), 'RND-2026-000002', 'el segundo borrador recibe el folio siguiente');
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Agrega al menos un gasto con monto mayor a cero antes de enviar.',
  'no se puede enviar una rendición vacía'
);

insert into public.expense_items (
  company_id, report_id, category_id, expense_date, description, net_amount, tax_amount
)
select '96000000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000301', ec.id, current_date,
  'Almuerzo con cliente', 15000, 2850
from public.expense_categories ec
where ec.company_id = '96000000-0000-0000-0000-000000000001' and ec.code = 'ALIMENTACION';

select lives_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  'el dueño puede enviar un borrador válido'
);
select ok(
  (select status = 'SUBMITTED' and submitted_at is not null and total_amount = 17850
   from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'),
  'el envío conserva total y registra estado/fecha'
);
select ok(
  (select draft_count = 1 and review_count = 1 and approved_count = 0 and visible_total = 17850
   from public.expense_dashboard_summary('96000000-0000-0000-0000-000000000001')),
  'los KPIs se agregan en base según el alcance autorizado'
);
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Solo se puede enviar una rendición en borrador.',
  'un informe enviado no puede enviarse dos veces'
);
select throws_ok(
  $$update public.expense_reports set status = 'APPROVED' where id = '96000000-0000-0000-0000-000000000301'$$,
  '42501', null, 'el navegador no puede saltarse el flujo cambiando status directamente'
);
reset role;
select is(
  (select count(*)::integer from public.expense_audit_events
   where report_id = '96000000-0000-0000-0000-000000000301'
     and event_type = 'expense_report.status_changed'),
  1, 'el envío deja un evento de auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_reports), 0, 'otro tenant no ve los folios ni informes');
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000302')$$,
  '42501', 'Rendiciones no está habilitado para esta membresía.',
  'otro tenant no puede enviar un ID conocido'
);
reset role;

set local role anon;
select throws_ok($$select 1 from public.expense_report_sequences$$, '42501', null, 'la tabla interna de secuencias no es pública');
reset role;

select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = '96000000-0000-0000-0000-000000000001'
     and action = 'company.module.status_changed' and target_id = 'expenses'),
  1, 'la activación sigue auditándose una sola vez'
);
select ok(
  not (select workspace_enabled from public.companies where id = '96000000-0000-0000-0000-000000000001'),
  'el flujo completo no habilita el workspace laboral'
);

select * from finish();
rollback;
