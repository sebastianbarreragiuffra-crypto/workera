-- pgTAP GESTORA EX-6: conciliación de rendiciones aprobadas.
create extension if not exists pgtap;

begin;
select plan(18);

-- Desde la etapa F de MFA (docs/MFA_DESIGN.md sección 7), los RPC sensibles
-- llaman a `enforce_mfa_for_privileged()`. Las sesiones de esta prueba ejercen
-- operaciones privilegiadas, así que declaran el nivel que tendría una sesión
-- real después de verificar su segundo factor. No relaja nada: que la guarda
-- distinga aal1 de aal2 se prueba en 049.
set local request.jwt.claim.aal = 'aal2';

select has_column('public', 'expense_reports', 'paid_at', 'la rendición registra cuándo se concilió');
select has_column('public', 'expense_reports', 'paid_by', 'la rendición registra quién concilió');
select has_column('public', 'expense_reports', 'payment_reference', 'la rendición registra la referencia de pago');
select has_function('public', 'reconcile_expense_report', array['uuid','text'], 'existe RPC seguro de conciliación');
select ok(has_function_privilege('authenticated', 'public.reconcile_expense_report(uuid, text)', 'EXECUTE'), 'authenticated puede invocar la conciliación');
select ok(not has_function_privilege('anon', 'public.reconcile_expense_report(uuid, text)', 'EXECUTE'), 'anon no puede conciliar');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('99000000-0000-0000-0000-000000000001', 'Gastos Conciliados', 'Gastos Conciliados SpA', 'gastos-conciliados', true, 'ONBOARDING', false),
  ('99000000-0000-0000-0000-000000000002', 'Gastos Conciliados Ajeno', 'Gastos Conciliados Ajeno SpA', 'gastos-conciliados-ajeno', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('99000000-0000-0000-0000-000000000101', 'Platform EX6', null, true),
  ('99000000-0000-0000-0000-000000000102', 'Rendidor EX6', null, true),
  ('99000000-0000-0000-0000-000000000103', 'Finanzas EX6', null, true),
  ('99000000-0000-0000-0000-000000000104', 'Ajeno EX6', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('99000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('99000000-0000-0000-0000-000000000201', '99000000-0000-0000-0000-000000000102', '99000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('99000000-0000-0000-0000-000000000202', '99000000-0000-0000-0000-000000000103', '99000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('99000000-0000-0000-0000-000000000203', '99000000-0000-0000-0000-000000000104', '99000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = '99000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('99000000-0000-0000-0000-000000000202','99000000-0000-0000-0000-000000000203') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('99000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones');
reset role;

-- HR_ADMIN ya recibe expenses.reconcile automáticamente vía
-- provision_expense_role_permissions() -- este role recién se crea al
-- provisionar la empresa, después de que la migración de EX-6 ya agregó el
-- permiso al catálogo.
select ok(
  exists (
    select 1 from public.company_role_permissions crp
    join public.company_roles cr on cr.id = crp.role_id
    where cr.company_id = '99000000-0000-0000-0000-000000000001' and cr.code = 'HR_ADMIN' and crp.permission_code = 'expenses.reconcile'
  ),
  'HR_ADMIN recibe expenses.reconcile al provisionarse'
);

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('99000000-0000-0000-0000-000000000301', '99000000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000102', 'Viaje a conciliar');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select '99000000-0000-0000-0000-000000000401', '99000000-0000-0000-0000-000000000001',
  '99000000-0000-0000-0000-000000000301', ec.id, current_date, 'Pasajes', 40000
from public.expense_categories ec
where ec.company_id = '99000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
select lives_ok($$select public.submit_expense_report('99000000-0000-0000-0000-000000000301')$$, 'se envía la rendición a revisión');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000103';
-- El chequeo de estado se prueba con quien SÍ tiene expenses.reconcile --
-- de lo contrario el rechazo por permiso llega antes y nunca se ejercita
-- la validación de estado.
select throws_ok(
  $$select public.reconcile_expense_report('99000000-0000-0000-0000-000000000301', 'TRANSF-001')$$,
  '23514', 'Solo se puede conciliar una rendición aprobada.',
  'no se puede conciliar una rendición todavía en revisión'
);
select lives_ok(
  $$select public.decide_expense_report('99000000-0000-0000-0000-000000000301', 'APPROVED', null)$$,
  'finanzas aprueba la rendición'
);
select throws_ok(
  $$select public.reconcile_expense_report('99000000-0000-0000-0000-000000000301', '   ')$$,
  '23514', 'Debes indicar una referencia de pago o asiento contable.',
  'una referencia vacía no concilia nada'
);
select lives_ok(
  $$select public.reconcile_expense_report('99000000-0000-0000-0000-000000000301', 'TRANSF-001')$$,
  'con referencia real, la misma persona que aprobó puede conciliar'
);
select ok(
  (select status = 'PAID' and paid_at is not null and paid_by = '99000000-0000-0000-0000-000000000103'
     and payment_reference = 'TRANSF-001'
   from public.expense_reports where id = '99000000-0000-0000-0000-000000000301'),
  'la conciliación registra referencia, quién y cuándo'
);
select throws_ok(
  $$select public.reconcile_expense_report('99000000-0000-0000-0000-000000000301', 'TRANSF-002')$$,
  '23514', 'Solo se puede conciliar una rendición aprobada.',
  'una rendición ya pagada no se vuelve a conciliar'
);
select throws_ok(
  $$update public.expense_reports set status = 'APPROVED', paid_at = null, payment_reference = null where id = '99000000-0000-0000-0000-000000000301'$$,
  '42501', null, 'el navegador no puede deshacer una conciliación escribiendo directo'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000104';
select throws_ok(
  $$select public.reconcile_expense_report('99000000-0000-0000-0000-000000000301', 'TRANSF-003')$$,
  '42501', 'Tu rol no permite conciliar rendiciones.',
  'otro tenant no puede conciliar un folio ajeno'
);
reset role;

select is(
  (select count(*)::integer from public.expense_audit_events
   where report_id = '99000000-0000-0000-0000-000000000301'
     and event_type = 'expense_report.status_changed' and metadata->>'status' = 'PAID'),
  1, 'la conciliación queda auditada como cambio de estado, sin trabajo adicional'
);

select * from finish();
rollback;
