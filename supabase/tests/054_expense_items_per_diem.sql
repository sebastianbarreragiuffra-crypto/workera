-- pgTAP GESTORA Rendiciones EX-8 (parte 2): columna per_diem_days.
create extension if not exists pgtap;
begin;
select plan(5);

select has_column('public', 'expense_items', 'per_diem_days', 'expense_items registra días de viático');
select col_is_nullable('public', 'expense_items', 'per_diem_days', 'per_diem_days es opcional -- no todo ítem es viático');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values ('12000000-0000-0000-0000-000000000001', 'Gastos Viaticos', 'Gastos Viaticos SpA', 'gastos-viaticos', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values ('12000000-0000-0000-0000-000000000101', 'Submitter EX8b', null, true);
insert into public.company_memberships (id, user_id, company_id, role, active)
values ('12000000-0000-0000-0000-000000000201', '12000000-0000-0000-0000-000000000101', '12000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true);
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('12000000-0000-0000-0000-000000000301', '12000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000101', 'Viaje con viáticos');

select lives_ok(
  $$ insert into public.expense_items (company_id, report_id, expense_date, description, net_amount, per_diem_days)
     values ('12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000301', current_date, 'Viático 3 días', 90000, 3) $$,
  'un ítem con per_diem_days positivo se inserta'
);
select throws_ok(
  $$ insert into public.expense_items (company_id, report_id, expense_date, description, net_amount, per_diem_days)
     values ('12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000301', current_date, 'Viático inválido', 0, 0) $$,
  '23514', null,
  'per_diem_days debe ser positivo, no cero ni negativo'
);
select throws_ok(
  $$ insert into public.expense_items (company_id, report_id, expense_date, description, net_amount, distance_km, per_diem_days)
     values ('12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000301', current_date, 'No puede ser ambos', 10000, 40, 2) $$,
  '23514', null,
  'un mismo ítem no puede ser kilometraje y viático a la vez'
);

select * from finish();
rollback;
