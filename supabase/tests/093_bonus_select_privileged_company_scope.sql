-- pgTAP: la lectura de bonos automáticos incluye a SUPER_ADMIN y ADMIN_RRHH,
-- conserva el aislamiento por empresa y no amplía acceso a supervisores.
create extension if not exists pgtap;

begin;
select plan(7);

select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_daily_bonuses'
      and policyname = 'employee_daily_bonuses_select_admin'
      and cmd = 'SELECT'
      and roles::text = '{authenticated}'
  ),
  1,
  'existe una sola policy SELECT de bonos para authenticated'
);

select ok(
  (
    select qual::text like '%is_privileged_admin()%'
      and qual::text like '%employee_belongs_to_active_company(employee_id)%'
      and qual::text not like '%is_admin_rrhh()%'
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_daily_bonuses'
      and policyname = 'employee_daily_bonuses_select_admin'
  ),
  'la policy exige administrador privilegiado y pertenencia activa a la empresa'
);

insert into public.profiles (id, display_name, role, active) values
  (
    '93000000-0000-4000-8000-000000000101',
    'SUPER_ADMIN bonos 093', 'SUPER_ADMIN', true
  ),
  (
    '93000000-0000-4000-8000-000000000102',
    'ADMIN_RRHH bonos 093', 'ADMIN_RRHH', true
  ),
  (
    '93000000-0000-4000-8000-000000000103',
    'Supervisor bonos 093', 'SUPERVISOR_PRODUCTION', true
  );

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  '93000000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'BONUS-RLS-093', 'Fixture', 'Bono', 'Fixture Bono RLS 093',
  (
    select id
    from public.employee_groups
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and code = 'PRODUCTION'
  )
);

insert into public.attendance_records (
  id, employee_id, work_date, actual_clock_in, actual_clock_out,
  source, source_hash, source_version, is_current
) values (
  '93000000-0000-4000-8000-000000000301',
  '93000000-0000-4000-8000-000000000201', date '2030-01-07',
  timestamptz '2030-01-07 07:30:00-03',
  timestamptz '2030-01-07 19:35:00-03',
  'manual', 'bonus-rls-093-attendance', 1, true
);

insert into public.overtime_records (
  id, employee_id, work_date, attendance_record_id, overtime_type_id,
  candidate_minutes, overtime_policy_id, is_current
) values (
  '93000000-0000-4000-8000-000000000401',
  '93000000-0000-4000-8000-000000000201', date '2030-01-07',
  '93000000-0000-4000-8000-000000000301',
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  120,
  (
    select op.id
    from public.overtime_policies op
    join public.employee_groups eg on eg.id = op.employee_group_id
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
      and op.day_of_week = extract(dow from date '2030-01-07')::smallint
      and op.effective_from <= date '2030-01-07'
      and (op.effective_to is null or op.effective_to >= date '2030-01-07')
    order by op.effective_from desc
    limit 1
  ),
  true
);

insert into public.overtime_decisions (
  id, overtime_record_id, approved_minutes, rejected_minutes,
  decision_status, decided_by, is_current
) values (
  '93000000-0000-4000-8000-000000000501',
  '93000000-0000-4000-8000-000000000401',
  120, 0, 'FULLY_APPROVED',
  '93000000-0000-4000-8000-000000000103', true
);

select is(
  (
    select count(*)::integer
    from public.employee_daily_bonuses
    where employee_id = '93000000-0000-4000-8000-000000000201'
      and work_date = date '2030-01-07'
      and amount = 1000
      and currency = 'CLP'
  ),
  1,
  'la decisión aprobada genera el bono auditable de $1.000 CLP'
);

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000101';
select ok(
  public.is_super_admin() and public.is_privileged_admin(),
  'SUPER_ADMIN satisface el gate administrativo privilegiado'
);
select is(
  (
    select count(*)::integer
    from public.employee_daily_bonuses
    where employee_id = '93000000-0000-4000-8000-000000000201'
  ),
  1,
  'SUPER_ADMIN puede leer el bono de su empresa activa'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000102';
select is(
  (
    select count(*)::integer
    from public.employee_daily_bonuses
    where employee_id = '93000000-0000-4000-8000-000000000201'
  ),
  1,
  'ADMIN_RRHH conserva la lectura del bono de su empresa activa'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-4000-8000-000000000103';
select is(
  (
    select count(*)::integer
    from public.employee_daily_bonuses
    where employee_id = '93000000-0000-4000-8000-000000000201'
  ),
  0,
  'un supervisor no puede leer bonos aunque pertenezca a la empresa'
);
reset role;

select * from finish();
rollback;
