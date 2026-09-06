-- pgTAP: reglas canónicas de HE y autoridad exclusiva de RR. HH.
-- Ejecutar solo en una Supabase aislada compatible con esta rama.
create extension if not exists pgtap;

begin;
select plan(19);

select is(public.max_approvable_overtime_minutes(
  'PRODUCTION', date '2026-11-02', (select id from public.overtime_types where code = 'OVERTIME_50')
), 120, 'Producción lunes HH50: tope 120');
select is(public.max_approvable_overtime_minutes(
  'PRODUCTION', date '2026-11-07', (select id from public.overtime_types where code = 'OVERTIME_50')
), 120, 'Producción sábado HH50: tope 120');
select is(public.max_approvable_overtime_minutes(
  'PRODUCTION', date '2026-11-02', (select id from public.overtime_types where code = 'OVERTIME_100')
), 360, 'Producción feriado HH100: tope 360');
select is(public.max_approvable_overtime_minutes(
  'PRODUCTION', date '2026-11-08', (select id from public.overtime_types where code = 'OVERTIME_100')
), 0, 'Producción domingo: bloqueado');
select is(public.max_approvable_overtime_minutes(
  'INSTALLATION', date '2026-11-02', (select id from public.overtime_types where code = 'OVERTIME_50')
), 120, 'Instalaciones lunes HH50: tope 120');
select is(public.max_approvable_overtime_minutes(
  'INSTALLATION', date '2026-11-07', (select id from public.overtime_types where code = 'OVERTIME_50')
), 120, 'Instalaciones sábado HH50: tope 120');
select is(public.max_approvable_overtime_minutes(
  'INSTALLATION', date '2026-11-02', (select id from public.overtime_types where code = 'OVERTIME_100')
), 360, 'Instalaciones feriado HH100: tope 360');
select is(public.max_approvable_overtime_minutes(
  'INSTALLATION', date '2026-11-08', (select id from public.overtime_types where code = 'OVERTIME_100')
), null::integer, 'Instalaciones domingo HH100: sin tope fijo');
select is(public.max_approvable_overtime_minutes(
  'ADMINISTRATION', date '2026-11-02', (select id from public.overtime_types where code = 'OVERTIME_50')
), 0, 'Administración: bloqueada');

select ok((select overtime_eligible and max_overtime_minutes = 120
  from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
  where eg.code = 'PRODUCTION' and op.day_of_week = 6 and op.effective_to is null),
  'política Producción sábado: elegible y 120');
select ok((select not overtime_eligible and max_overtime_minutes is null
  from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
  where eg.code = 'PRODUCTION' and op.day_of_week = 0 and op.effective_to is null),
  'política Producción domingo: no elegible');
select ok((select overtime_eligible and max_overtime_minutes = 120
  from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
  where eg.code = 'INSTALLATION' and op.day_of_week = 2 and op.effective_to is null),
  'política Instalaciones L-S: 120');
select ok((select overtime_eligible and max_overtime_minutes is null
  from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
  where eg.code = 'INSTALLATION' and op.day_of_week = 0 and op.effective_to is null),
  'política Instalaciones domingo: elegible sin tope fijo de negocio');

select ok((select with_check like '%has_company_app_role%' and with_check like '%ADMIN_RRHH%'
    and with_check not like '%is_privileged_admin%'
  from pg_policies where schemaname = 'public' and tablename = 'reporting_periods'
    and policyname = 'reporting_periods_insert_admin'),
  'apertura de período: policy exclusiva ADMIN_RRHH');
select ok((select qual like '%has_company_app_role%' and qual like '%ADMIN_RRHH%'
    and qual not like '%is_privileged_admin%'
  from pg_policies where schemaname = 'public' and tablename = 'reporting_periods'
    and policyname = 'reporting_periods_update_admin'),
  'cierre/reapertura: policy exclusiva ADMIN_RRHH');

insert into public.profiles (id, display_name, role)
values ('95000000-0000-4000-8000-000000000001', 'Fixture RRHH HE canónica', 'ADMIN_RRHH');
insert into public.employees (external_workera_id, first_name, last_name, display_name, employee_group_id)
values ('HE-CANON-095', 'Fixture', 'Canónica', 'Fixture HE canónica',
  (select id from public.employee_groups where code = 'PRODUCTION'));

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
select id, date '2026-11-02', timestamptz '2026-11-02 08:00-03', timestamptz '2026-11-02 18:59-03',
  'hash-he-canon-59', 1, true from public.employees where external_workera_id = 'HE-CANON-095';
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
select e.id, date '2026-11-02', ar.id,
  (select id from public.overtime_types where code = 'OVERTIME_50'), 59, op.id
from public.employees e
join public.attendance_records ar on ar.employee_id = e.id and ar.source_hash = 'hash-he-canon-59'
join public.employee_groups eg on eg.id = e.employee_group_id
join public.overtime_policies op on op.employee_group_id = eg.id and op.day_of_week = 1 and op.effective_to is null
where e.external_workera_id = 'HE-CANON-095';
select throws_ok(format(
  $$insert into public.overtime_decisions
      (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
    values (%L, 59, 0, 'FULLY_APPROVED', '95000000-0000-4000-8000-000000000001')$$,
  (select id from public.overtime_records where work_date = date '2026-11-02'
    and employee_id = (select id from public.employees where external_workera_id = 'HE-CANON-095'))
), 'P0001', null, '59 minutos no se pueden aprobar');
select lives_ok(format(
  $$insert into public.overtime_decisions
      (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
    values (%L, 0, 59, 'REJECTED', '95000000-0000-4000-8000-000000000001')$$,
  (select id from public.overtime_records where work_date = date '2026-11-02'
    and employee_id = (select id from public.employees where external_workera_id = 'HE-CANON-095'))
), '59 minutos se conservan y pueden rechazarse');

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
select id, date '2026-11-09', timestamptz '2026-11-09 08:00-03', timestamptz '2026-11-09 19:30-03',
  'hash-he-canon-90', 1, true from public.employees where external_workera_id = 'HE-CANON-095';
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
select e.id, date '2026-11-09', ar.id,
  (select id from public.overtime_types where code = 'OVERTIME_50'), 90, op.id
from public.employees e
join public.attendance_records ar on ar.employee_id = e.id and ar.source_hash = 'hash-he-canon-90'
join public.employee_groups eg on eg.id = e.employee_group_id
join public.overtime_policies op on op.employee_group_id = eg.id and op.day_of_week = 1 and op.effective_to is null
where e.external_workera_id = 'HE-CANON-095';
select lives_ok(format(
  $$insert into public.overtime_decisions
      (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
    values (%L, 90, 0, 'FULLY_APPROVED', '95000000-0000-4000-8000-000000000001')$$,
  (select id from public.overtime_records where work_date = date '2026-11-09'
    and employee_id = (select id from public.employees where external_workera_id = 'HE-CANON-095'))
), '90 minutos se aprueban exactos, sin selector binario ni redondeo');

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
select id, date '2026-11-16', timestamptz '2026-11-16 08:00-03', timestamptz '2026-11-16 20:01-03',
  'hash-he-canon-121', 1, true from public.employees where external_workera_id = 'HE-CANON-095';
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
select e.id, date '2026-11-16', ar.id,
  (select id from public.overtime_types where code = 'OVERTIME_50'), 121, op.id
from public.employees e
join public.attendance_records ar on ar.employee_id = e.id and ar.source_hash = 'hash-he-canon-121'
join public.employee_groups eg on eg.id = e.employee_group_id
join public.overtime_policies op on op.employee_group_id = eg.id and op.day_of_week = 1 and op.effective_to is null
where e.external_workera_id = 'HE-CANON-095';
select lives_ok(format(
  $$insert into public.overtime_decisions
      (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
    values (%L, 120, 1, 'PARTIALLY_APPROVED', '95000000-0000-4000-8000-000000000001')$$,
  (select id from public.overtime_records where work_date = date '2026-11-16'
    and employee_id = (select id from public.employees where external_workera_id = 'HE-CANON-095'))
), '121 reales se conservan con 120 pagables y decisión parcial');

select * from finish();
rollback;
