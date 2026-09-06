-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(18);

select has_column(
  'public', 'reporting_periods', 'company_id',
  'reporting_periods declara la empresa duena'
);

select col_not_null(
  'public', 'reporting_periods', 'company_id',
  'ningun periodo puede quedar sin empresa'
);

select col_default_is(
  'public', 'reporting_periods', 'company_id',
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  'el default transicional conserva inserts historicos de ARCOTEX'
);

select ok(exists (
  select 1
  from pg_constraint c
  where c.conrelid = 'public.reporting_periods'::regclass
    and c.conname = 'reporting_periods_no_overlap'
    and pg_get_constraintdef(c.oid) like '%company_id WITH =%'
), 'el no-solapamiento esta particionado por empresa');

select ok(exists (
  select 1
  from pg_constraint c
  where c.conrelid = 'public.reporting_periods'::regclass
    and c.conname = 'reporting_periods_company_id_id_key'
    and c.contype = 'u'
), 'existe la clave candidata compuesta empresa-periodo');

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '0a4c0000-0000-0000-0000-000000000104'::uuid,
  'Tenant periodos 104', 'Tenant periodos 104', 'tenant-periodos-104',
  true, 'ONBOARDING', false
);

insert into public.reporting_periods(company_id, period_start, period_end, status)
values
  ('0a4c0000-0000-0000-0000-000000000001', date '2097-01-16', date '2097-02-15', 'OPEN'),
  ('0a4c0000-0000-0000-0000-000000000104', date '2097-01-16', date '2097-02-15', 'OPEN');

select is(
  (select count(*) from public.reporting_periods
   where period_start = date '2097-01-16' and period_end = date '2097-02-15'),
  2::bigint,
  'dos empresas pueden tener el mismo ciclo 16-15'
);

select throws_ok(
  $$insert into public.reporting_periods(company_id, period_start, period_end, status)
    values ('0a4c0000-0000-0000-0000-000000000104', date '2097-02-01', date '2097-02-28', 'OPEN')$$,
  '23P01',
  null,
  'una misma empresa no puede crear periodos solapados'
);

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.payroll_workbook_versions'::regclass
    and conname = 'payroll_workbook_versions_company_period_fkey'
    and conkey = array[
      (select attnum from pg_attribute where attrelid = 'public.payroll_workbook_versions'::regclass and attname = 'company_id'),
      (select attnum from pg_attribute where attrelid = 'public.payroll_workbook_versions'::regclass and attname = 'reporting_period_id')
    ]::smallint[]
), 'versiones validan empresa y periodo en una sola FK');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.payroll_workbook_conflicts'::regclass
    and conname = 'payroll_workbook_conflicts_company_period_fkey'
), 'conflictos no pueden apuntar a un periodo ajeno');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.reporting_period_approvals'::regclass
    and conname = 'reporting_period_approvals_company_period_fkey'
), 'aprobaciones no pueden apuntar a un periodo ajeno');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.reporting_period_approvals'::regclass
    and conname = 'reporting_period_approvals_company_version_fkey'
), 'aprobaciones no pueden usar una version de otra empresa');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'private.payroll_period_close_operations'::regclass
    and conname = 'payroll_period_close_operations_company_period_fkey'
), 'el cierre preparado valida la empresa del periodo');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'private.payroll_period_close_operations'::regclass
    and conname = 'payroll_period_close_operations_company_base_version_fkey'
), 'el cierre preparado valida la empresa de la version base');

select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'private.payroll_period_close_operations'::regclass
    and conname = 'payroll_period_close_operations_company_snapshot_version_fkey'
), 'el cierre preparado valida la empresa del snapshot final');

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%where company_id = p_company_id%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)'::regprocedure
  ) like '%where rp.company_id = p_company_id%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%where rp.company_id = p_company_id%',
  'todos los commits internos de XLSX resuelven el periodo dentro de la empresa'
);

select ok(exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'reporting_periods'
    and policyname = 'reporting_periods_select'
    and qual like '%is_active_company_member(company_id)%'
    and qual like '%workspace_enabled%'
), 'la lectura RLS exige membresia y workspace laboral habilitado');

select ok(exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'reporting_periods'
    and policyname = 'reporting_periods_insert_admin'
    and with_check like '%has_company_app_role(company_id, ''ADMIN_RRHH''%'
), 'solo RR. HH. de esa empresa puede crear su periodo');

select is(
  (select count(*) from pg_trigger
   where tgname in (
     'payroll_workbook_versions_period_company_guard',
     'payroll_workbook_conflicts_period_company_guard',
     'reporting_period_approvals_period_company_guard',
     'payroll_close_operations_period_company_guard'
   ) and not tgisinternal),
  4::bigint,
  'versiones, conflictos, aprobaciones y cierre tienen guard tenant explicito'
);

select * from finish();
rollback;
