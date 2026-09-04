-- pgTAP GESTORA EX-1: Rendiciones como add-on multiempresa independiente.
create extension if not exists pgtap;

begin;
select plan(30);

-- Desde la etapa F de MFA (docs/MFA_DESIGN.md sección 7), los RPC sensibles
-- llaman a `enforce_mfa_for_privileged()`. Las sesiones de esta prueba ejercen
-- operaciones privilegiadas, así que declaran el nivel que tendría una sesión
-- real después de verificar su segundo factor. No relaja nada: que la guarda
-- distinga aal1 de aal2 se prueba en 049.
set local request.jwt.claim.aal = 'aal2';

select has_table('public', 'expense_policies', 'existen políticas de rendición por empresa');
select has_table('public', 'expense_categories', 'existen categorías por empresa');
select has_table('public', 'expense_reports', 'existen informes de rendición');
select has_table('public', 'expense_items', 'existen gastos individuales');
select has_table('public', 'expense_approval_decisions', 'existe historial de aprobaciones');
select has_table('public', 'expense_audit_events', 'existe auditoría propia de Rendiciones');
select has_column('public', 'expense_reports', 'company_id', 'cada informe declara tenant');
select has_column('public', 'expense_items', 'company_id', 'cada gasto declara tenant');
select ok(exists (select 1 from public.permission_definitions where code = 'expenses.submit'), 'existe permiso para rendir');
select ok(exists (select 1 from public.permission_definitions where code = 'expenses.approve'), 'existe permiso para aprobar');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('95000000-0000-0000-0000-000000000001', 'Gastos Alpha', 'Gastos Alpha SpA', 'gastos-alpha', true, 'ONBOARDING', false),
  ('95000000-0000-0000-0000-000000000002', 'Gastos Beta', 'Gastos Beta SpA', 'gastos-beta', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('95000000-0000-0000-0000-000000000101', 'Persona Alpha', null, true),
  ('95000000-0000-0000-0000-000000000102', 'Persona Beta', null, true),
  ('95000000-0000-0000-0000-000000000103', 'Auditor Alpha', null, true),
  ('95000000-0000-0000-0000-000000000104', 'Platform Expenses', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('95000000-0000-0000-0000-000000000104', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('95000000-0000-0000-0000-000000000201', '95000000-0000-0000-0000-000000000101', '95000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('95000000-0000-0000-0000-000000000202', '95000000-0000-0000-0000-000000000102', '95000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true),
  ('95000000-0000-0000-0000-000000000203', '95000000-0000-0000-0000-000000000103', '95000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id in ('95000000-0000-0000-0000-000000000201', '95000000-0000-0000-0000-000000000202') and cr.code = 'HR_ADMIN')
   or (cm.id = '95000000-0000-0000-0000-000000000203' and cr.code = 'AUDITOR');

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000104';
select lives_ok(
  $$select public.platform_set_company_module_status('95000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'el dashboard puede agregar Rendiciones a una empresa con workspace cerrado'
);
select lives_ok(
  $$select public.platform_set_company_module_status('0a4c0000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'Rendiciones también puede agregarse a ARCOTEX sin cambiar el workspace laboral'
);
select throws_ok(
  $$select public.platform_set_company_module_status('0a4c0000-0000-0000-0000-000000000001', 'payroll', 'DISABLED')$$,
  '23514',
  'Los módulos de un workspace operativo no se pueden cambiar hasta completar los gates backend y RLS de MT-3D.',
  'los demás módulos laborales continúan protegidos'
);
reset role;

select ok(not (select workspace_enabled from public.companies where id = '95000000-0000-0000-0000-000000000001'), 'activar Rendiciones no abre el workspace laboral');
select ok(public.company_has_module('95000000-0000-0000-0000-000000000001', 'expenses'), 'PILOT habilita solo el entitlement de Rendiciones');
select ok(not public.company_has_module('95000000-0000-0000-0000-000000000002', 'expenses'), 'el segundo cliente conserva su módulo deshabilitado');

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000101';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('95000000-0000-0000-0000-000000000301', '95000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000101', 'Visita a cliente');
select is((select count(*)::integer from public.expense_reports), 1, 'el miembro autorizado crea y ve su borrador');
insert into public.expense_items (
  id, company_id, report_id, expense_date, description, net_amount, tax_amount
) values (
  '95000000-0000-0000-0000-000000000401', '95000000-0000-0000-0000-000000000001',
  '95000000-0000-0000-0000-000000000301', current_date, 'Traslado', 10000, 1900
);
select is((select total_amount from public.expense_reports where id = '95000000-0000-0000-0000-000000000301'), 11900.00::numeric, 'el total se deriva de los ítems en base de datos');
select throws_ok(
  $$update public.expense_reports set total_amount = 1 where id = '95000000-0000-0000-0000-000000000301'$$,
  '42501', null, 'el navegador no puede sobrescribir el total derivado'
);
select is((select count(*)::integer from public.expense_audit_events where report_id = '95000000-0000-0000-0000-000000000301'), 2, 'creación y cambio de total quedan auditados');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_reports), 1, 'el auditor de la misma empresa puede leer informes');
select throws_ok(
  $$insert into public.expense_reports (company_id, submitted_by, title)
    values ('95000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000103', 'Gasto auditor')$$,
  '42501', null, 'un rol sin expenses.submit no puede crear rendiciones'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000102';
select is((select count(*)::integer from public.expense_reports), 0, 'otro tenant no descubre la rendición');
select is((select count(*)::integer from public.expense_items), 0, 'otro tenant tampoco descubre sus gastos');
select throws_ok(
  $$insert into public.expense_reports (company_id, submitted_by, title)
    values ('95000000-0000-0000-0000-000000000002', '95000000-0000-0000-0000-000000000102', 'Módulo apagado')$$,
  '42501', null, 'un tenant con el módulo apagado no puede escribir'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000104';
select is((select count(*)::integer from public.expense_reports), 0, 'administrar la plataforma no concede acceso a gastos de clientes');
reset role;

select throws_ok(
  $$insert into public.expense_items (company_id, report_id, expense_date, description, net_amount)
    values ('95000000-0000-0000-0000-000000000002', '95000000-0000-0000-0000-000000000301', current_date, 'Cruce', 1)$$,
  '23503', null, 'la FK compuesta rechaza cruces entre empresas'
);

select ok(not has_table_privilege('authenticated', 'public.expense_audit_events', 'INSERT'), 'la auditoría es append-only para usuarios autenticados');

set local role anon;
select throws_ok($$select 1 from public.expense_reports$$, '42501', null, 'anon no accede a Rendiciones');
reset role;

select ok(
  exists (
    select 1 from public.company_role_permissions crp
    join public.company_roles cr on cr.id = crp.role_id and cr.company_id = crp.company_id
    where cr.company_id = '95000000-0000-0000-0000-000000000001'
      and cr.code = 'PRODUCTION_SUPERVISOR' and crp.permission_code = 'expenses.submit'
  ),
  'las empresas creadas después de la migración provisionan el permiso de rendir'
);

select * from finish();
rollback;
