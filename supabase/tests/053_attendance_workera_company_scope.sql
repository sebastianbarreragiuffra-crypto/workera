-- pgTAP MT-3B: aislamiento tenant de asistencia, Workera y motor de reglas.
create extension if not exists pgtap;

begin;
select plan(20);

select has_column('public', 'sync_runs', 'company_id', 'sync_runs declara tenant');
select has_column('public', 'attendance_records', 'company_id', 'attendance_records declara tenant');
select has_column('public', 'attendance_status_records', 'company_id', 'attendance_status_records declara tenant');
select has_column('public', 'attendance_corrections', 'company_id', 'attendance_corrections declara tenant');
select has_column('public', 'workera_attendance_events', 'company_id', 'eventos Workera declaran tenant');
select has_column('public', 'rule_engine_runs', 'company_id', 'rule_engine_runs declara tenant');

select col_not_null('public', 'sync_runs', 'company_id', 'sync_runs.company_id es obligatorio');
select col_not_null('public', 'attendance_records', 'company_id', 'attendance_records.company_id es obligatorio');
select col_not_null('public', 'attendance_status_records', 'company_id', 'attendance_status_records.company_id es obligatorio');
select col_not_null('public', 'attendance_corrections', 'company_id', 'attendance_corrections.company_id es obligatorio');
select col_not_null('public', 'workera_attendance_events', 'company_id', 'eventos Workera exigen company_id');
select col_not_null('public', 'rule_engine_runs', 'company_id', 'rule_engine_runs.company_id es obligatorio');

select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'sync_runs' and column_name = 'company_id'),
  null,
  'sync_runs no tiene tenant por defecto implícito'
);
select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'rule_engine_runs' and column_name = 'company_id'),
  null,
  'rule_engine_runs no tiene tenant por defecto implícito'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values (
  '95000000-0000-0000-0000-000000000002',
  'Attendance Tenant B', 'Attendance Tenant B SpA', 'attendance-tenant-b',
  true, 'ONBOARDING', false
);

select lives_ok(
  $$insert into public.sync_runs (
      company_id, status, target_period_start, target_period_end
    ) values
      ('0a4c0000-0000-0000-0000-000000000001', 'RUNNING', '2098-01-01', '2098-01-01'),
      ('95000000-0000-0000-0000-000000000002', 'RUNNING', '2098-01-01', '2098-01-01')$$,
  'dos empresas pueden mantener un lock RUNNING para el mismo rango'
);

select throws_ok(
  $$insert into public.sync_runs (
      company_id, status, target_period_start, target_period_end
    ) values (
      '0a4c0000-0000-0000-0000-000000000001', 'RUNNING', '2098-01-01', '2098-01-01'
    )$$,
  '23505', null,
  'la misma empresa no puede duplicar un lock RUNNING para el mismo rango'
);

update public.sync_runs
set status = 'SUCCEEDED', finished_at = now()
where target_period_start = '2098-01-01';

insert into public.sync_runs (
  id, company_id, status, target_period_start, target_period_end, started_at
) values
  (
    '95000000-0000-0000-0000-000000000101',
    '0a4c0000-0000-0000-0000-000000000001',
    'RUNNING', '2098-01-02', '2098-01-02', now() - interval '20 minutes'
  ),
  (
    '95000000-0000-0000-0000-000000000102',
    '95000000-0000-0000-0000-000000000002',
    'RUNNING', '2098-01-02', '2098-01-02', now() - interval '20 minutes'
  );

select is(
  public.reclaim_stale_workera_sync_runs(
    '0a4c0000-0000-0000-0000-000000000001', 900
  ),
  1,
  'reclaim Workera solo recupera locks del tenant solicitado'
);
select is(
  (select status from public.sync_runs where id = '95000000-0000-0000-0000-000000000102'),
  'RUNNING',
  'reclaim de ARCOTEX no modifica el lock abandonado de otra empresa'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.workera_attendance_events'::regclass
      and conname = 'workera_attendance_events_company_employee_fkey'
      and contype = 'f'
  ),
  'eventos Workera tienen FK compuesta que impide cruzar empleado y empresa'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.reclaim_stale_workera_sync_runs(uuid,integer)',
    'EXECUTE'
  ),
  'service_role puede recuperar locks de un tenant explícito'
);

select * from finish();
rollback;
