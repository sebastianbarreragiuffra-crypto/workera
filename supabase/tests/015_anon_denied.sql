-- pgTAP Fase 3: anon nunca accede a datos de negocio (deny-by-default)
--
-- anon no tiene NINGÚN GRANT sobre estas tablas (migración 23,
-- grants_lockdown) — un intento de SELECT falla con "permission denied"
-- (42501) antes incluso de que RLS entre a evaluarse. Esto es más estricto
-- (y más correcto) que "SELECT devuelve 0 filas": la ausencia total de
-- privilegio es la primera línea de defensa, RLS es la segunda.
create extension if not exists pgtap;

begin;
select plan(8);

insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values (
  'TEST3-ANON-001', 'Fixture', 'Anon', 'Fixture Anon',
  (select id from public.employee_groups where code = 'PRODUCTION')
);

set local role anon;

select throws_ok($$ select 1 from public.employees $$, '42501', null,
  'anon: SELECT employees es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.attendance_records $$, '42501', null,
  'anon: SELECT attendance_records es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.overtime_records $$, '42501', null,
  'anon: SELECT overtime_records es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.absence_records $$, '42501', null,
  'anon: SELECT absence_records es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.supporting_documents $$, '42501', null,
  'anon: SELECT supporting_documents (tabla base) es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.reporting_periods $$, '42501', null,
  'anon: SELECT reporting_periods es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.employee_groups $$, '42501', null,
  'anon: SELECT employee_groups (catálogo) es denegado (sin GRANT)');
select throws_ok($$ select 1 from public.audit_log $$, '42501', null,
  'anon: SELECT audit_log es denegado (sin GRANT)');

reset role;
select * from finish();
rollback;
