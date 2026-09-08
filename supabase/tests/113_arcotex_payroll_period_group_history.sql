-- pgTAP: la evidencia externa del período sólo puede extender la asignación
-- inicial Workera de ARCOTEX y nunca una ficha provisional.
create extension if not exists pgtap;

begin;
select plan(5);

select has_function(
  'private',
  'extend_arcotex_initial_group_from_roster_period',
  array['uuid', 'date'],
  'existe el helper privado de evidencia del período'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.extend_arcotex_initial_group_from_roster_period(uuid,date)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.extend_arcotex_initial_group_from_roster_period(uuid,date)',
    'EXECUTE'
  ),
  'la aplicación no puede retrotraer grupos arbitrariamente'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id, source, active
) values
(
  'a7130000-0000-4000-8000-000000000101',
  '0a4c0000-0000-0000-0000-000000000001',
  'WORKERA-PERIOD-113', 'Periodo', 'Workera', 'Periodo Workera',
  (
    select id from public.employee_groups
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and code = 'PRODUCTION'
  ),
  'workera', true
),
(
  'a7130000-0000-4000-8000-000000000102',
  '0a4c0000-0000-0000-0000-000000000001',
  'LOCAL-PROVISIONAL:PERIOD-113', 'Periodo', 'Local', 'Periodo Local',
  (
    select id from public.employee_groups
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and code = 'ADMINISTRATION'
  ),
  'local_provisional', true
);

update public.employee_group_assignments
set effective_from = date '2097-02-01'
where employee_id in (
  'a7130000-0000-4000-8000-000000000101',
  'a7130000-0000-4000-8000-000000000102'
);

select is(
  private.extend_arcotex_initial_group_from_roster_period(
    'a7130000-0000-4000-8000-000000000101',
    date '2097-01-01'
  ),
  true,
  'extiende una asignación inicial Workera de ARCOTEX'
);

select is(
  (
    select effective_from
    from public.employee_group_assignments
    where employee_id = 'a7130000-0000-4000-8000-000000000101'
  ),
  date '2097-01-01',
  'la fecha efectiva queda alineada con la evidencia del período'
);

select is(
  private.extend_arcotex_initial_group_from_roster_period(
    'a7130000-0000-4000-8000-000000000102',
    date '2097-01-01'
  ),
  false,
  'una ficha provisional nunca se retrotrae como si fuera Workera'
);

select * from finish();
rollback;
