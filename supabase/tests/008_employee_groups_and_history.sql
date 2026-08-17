-- pgTAP Fase 2B: employee_groups (INSTALLATION) + employee_group_assignments
create extension if not exists pgtap;

begin;
select plan(4);

select ok(
  (select count(*) from public.employee_groups where code = 'INSTALLATION') = 1,
  'seed: INSTALLATION existe como employee_group'
);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST2B-EMP-GRP-001', 'Fixture', 'GroupHistory', 'Fixture GroupHistory');

-- 1) Primera asignación de grupo válida (enero -> PRODUCTION)
select lives_ok(
  format(
    $$ insert into public.employee_group_assignments (employee_id, employee_group_id, effective_from, effective_to)
       values (%L, %L, date '2026-01-01', date '2026-01-31') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-GRP-001'),
    (select id from public.employee_groups where code = 'PRODUCTION')
  ),
  'employee_group_assignments: PRODUCTION enero se inserta'
);

-- 2) Segunda asignación sin solapamiento (febrero -> INSTALLATION) debe funcionar
select lives_ok(
  format(
    $$ insert into public.employee_group_assignments (employee_id, employee_group_id, effective_from, effective_to)
       values (%L, %L, date '2026-02-01', null) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-GRP-001'),
    (select id from public.employee_groups where code = 'INSTALLATION')
  ),
  'employee_group_assignments: INSTALLATION febrero (sin solapar) se inserta'
);

-- 3) Un tercer rango que se solapa con el vigente (INSTALLATION, sin fin) debe rechazarse
select throws_ok(
  format(
    $$ insert into public.employee_group_assignments (employee_id, employee_group_id, effective_from, effective_to)
       values (%L, %L, date '2026-03-01', date '2026-03-31') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-GRP-001'),
    (select id from public.employee_groups where code = 'PRODUCTION')
  ),
  '23P01',
  null,
  'employee_group_assignments: solapamiento de rango es rechazado (EXCLUDE)'
);

select * from finish();
rollback;
