-- pgTAP GESTORA: integridad temporal y acíclica del organigrama.
create extension if not exists pgtap;

begin;
select plan(9);

select has_index(
  'public', 'reporting_lines', 'reporting_lines_primary_no_overlap',
  'las jefaturas principales no pueden solaparse'
);
select has_trigger(
  'public', 'reporting_lines', 'reporting_lines_prevent_cycle',
  'el organigrama tiene guardia contra ciclos'
);

insert into public.employees (id, company_id, external_workera_id, first_name, last_name, display_name) values
  ('f2000000-0000-0000-0000-000000000101', '0a4c0000-0000-0000-0000-000000000001', 'ORG-SAFE-101', 'Ana', 'Uno', 'Ana Uno'),
  ('f2000000-0000-0000-0000-000000000102', '0a4c0000-0000-0000-0000-000000000001', 'ORG-SAFE-102', 'Beto', 'Dos', 'Beto Dos'),
  ('f2000000-0000-0000-0000-000000000103', '0a4c0000-0000-0000-0000-000000000001', 'ORG-SAFE-103', 'Caro', 'Tres', 'Caro Tres'),
  ('f2000000-0000-0000-0000-000000000104', '0a4c0000-0000-0000-0000-000000000001', 'ORG-SAFE-104', 'Dani', 'Cuatro', 'Dani Cuatro');

select lives_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000101', 'f2000000-0000-0000-0000-000000000102', '2026-01-01', '2026-06-30')$$,
  'se registra una jefatura principal válida'
);
select throws_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000101', 'f2000000-0000-0000-0000-000000000103', '2026-06-01', '2026-12-31')$$,
  '23P01', null,
  'se rechazan dos jefaturas principales simultáneas'
);
select lives_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000101', 'f2000000-0000-0000-0000-000000000103', '2026-07-01', '2026-12-31')$$,
  'se permite cambiar de jefatura sin solapar vigencias'
);
select lives_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000102', 'f2000000-0000-0000-0000-000000000103', '2026-01-01', '2026-06-30')$$,
  'se extiende una cadena válida de jefaturas'
);
select throws_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000103', 'f2000000-0000-0000-0000-000000000101', '2026-03-01', '2026-03-31')$$,
  '23514', 'La línea de reporte formaría un ciclo en el organigrama.',
  'se rechaza un ciclo con vigencia común'
);
select lives_ok(
  $$insert into public.reporting_lines (company_id, employee_id, manager_employee_id, effective_from, effective_to, is_primary)
    values ('0a4c0000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000101', 'f2000000-0000-0000-0000-000000000104', '2026-01-01', '2026-12-31', false)$$,
  'una línea secundaria explícita puede coexistir'
);
select is(
  (select count(*)::integer from public.reporting_lines where company_id = '0a4c0000-0000-0000-0000-000000000001'
     and employee_id in ('f2000000-0000-0000-0000-000000000101','f2000000-0000-0000-0000-000000000102','f2000000-0000-0000-0000-000000000103','f2000000-0000-0000-0000-000000000104')),
  4,
  'solo persistieron las cuatro relaciones válidas'
);

select * from finish();
rollback;
