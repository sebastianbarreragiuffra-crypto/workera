-- pgTAP GESTORA Rendiciones EX-8 (parte 1): columna distance_km.
create extension if not exists pgtap;
begin;
select plan(4);

select has_column('public', 'expense_items', 'distance_km', 'expense_items registra kilómetros recorridos');
select col_is_nullable('public', 'expense_items', 'distance_km', 'distance_km es opcional -- no todo ítem es kilometraje');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values ('11000000-0000-0000-0000-000000000001', 'Gastos Km', 'Gastos Km SpA', 'gastos-km', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values ('11000000-0000-0000-0000-000000000101', 'Submitter EX8', null, true);
insert into public.company_memberships (id, user_id, company_id, role, active)
values ('11000000-0000-0000-0000-000000000201', '11000000-0000-0000-0000-000000000101', '11000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true);
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('11000000-0000-0000-0000-000000000301', '11000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000101', 'Ruta de terreno');

select lives_ok(
  $$ insert into public.expense_items (company_id, report_id, expense_date, description, net_amount, distance_km)
     values ('11000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000301', current_date, 'Kilometraje visita cliente', 15000, 42.5) $$,
  'un ítem con distance_km positivo se inserta'
);
select throws_ok(
  $$ insert into public.expense_items (company_id, report_id, expense_date, description, net_amount, distance_km)
     values ('11000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000301', current_date, 'Kilometraje inválido', 0, 0) $$,
  '23514', null,
  'distance_km debe ser positivo, no cero ni negativo'
);

select * from finish();
rollback;
