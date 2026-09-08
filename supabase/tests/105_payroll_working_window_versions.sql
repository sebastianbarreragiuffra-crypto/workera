-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(24);

select has_table('public', 'payroll_working_versions',
  'existe el historial separado de versiones de trabajo');
select has_table('public', 'payroll_working_changes',
  'existe la auditoria de cambios de versiones de trabajo');
select has_table('private', 'payroll_working_acceptance_receipts',
  'existe el recibo idempotente privado');

select has_function(
  'public', 'register_accepted_working_workbook',
  array[
    'uuid','uuid','text','date','date','uuid','text','integer','text','text',
    'jsonb','bigint','text','integer','text','uuid','text','timestamp with time zone'
  ],
  'existe el commit atestado de ventanas cortas'
);

select ok(
  (select prosecdef and provolatile = 'v'
   from pg_proc
   where oid = 'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)'::regprocedure),
  'el commit es SECURITY DEFINER y VOLATILE'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'solo service_role puede cruzar el commit'
);

select ok(
  not has_table_privilege('service_role', 'public.payroll_working_versions', 'INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('service_role', 'public.payroll_working_changes', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'service_role no tiene bypass DML sobre la evidencia'
);

select is(
  (select count(*) from pg_trigger
   where tgname in ('payroll_working_versions_immutable', 'payroll_working_changes_immutable')
     and not tgisinternal),
  2::bigint,
  'versiones y cambios son inmutables por trigger'
);

select ok(
  pg_get_functiondef('private.prevent_registered_workforce_object_mutation()'::regprocedure)
    like '%from public.payroll_working_versions w%w.storage_path = v_old_name%'
  and pg_get_functiondef('private.prevent_registered_workforce_object_mutation()'::regprocedure)
    like '%from public.payroll_working_versions w%w.storage_path = v_new_name%',
  'el guard fisico de Storage protege tambien versiones de trabajo'
);

select ok(exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'payroll_working_versions'
    and policyname = 'payroll_working_versions_read'
    and qual like '%is_active_company_member(company_id)%'
    and qual like '%has_company_app_role(company_id, ''ADMIN_RRHH''%'
), 'la lectura exige membresia y rol de la empresa');

insert into public.profiles(id, display_name, role, active)
values ('10500000-0000-4000-8000-000000000001', 'RRHH ficticio 105', null, true);

insert into public.company_memberships(id, user_id, company_id, role, active)
values (
  '10500000-0000-4000-8000-000000000002',
  '10500000-0000-4000-8000-000000000001',
  '0a4c0000-0000-0000-0000-000000000001',
  'ADMIN_RRHH', true
);

insert into public.company_membership_roles(company_id, membership_id, role_id)
select
  '0a4c0000-0000-0000-0000-000000000001',
  '10500000-0000-4000-8000-000000000002',
  cr.id
from public.company_roles cr
where cr.company_id = '0a4c0000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';

insert into storage.objects(id, bucket_id, name, owner_id, metadata)
values (
  '10500000-0000-4000-8000-000000000003',
  'payroll-workbooks',
  '0a4c0000-0000-0000-0000-000000000001/2097-03-03_2097-03-03/10500000-0000-4000-8000-000000000004.xlsx',
  '10500000-0000-4000-8000-000000000001',
  '{"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":100}'::jsonb
);

select set_config(
  'test.working_revision_105',
  (select revision::text from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001'),
  true
);
select set_config(
  'test.working_object_updated_at_105',
  (select updated_at::text from storage.objects
   where id='10500000-0000-4000-8000-000000000003'),
  true
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select throws_ok(
  $$select public.register_accepted_working_workbook(
    '10500000-0000-4000-8000-000000000001',
    '0a4c0000-0000-0000-0000-000000000001',
    'MENSUAL', date '2097-03-03', date '2097-03-03', null,
    repeat('a',64), 100,
    '0a4c0000-0000-0000-0000-000000000001/2097-03-03_2097-03-03/10500000-0000-4000-8000-000000000004.xlsx',
    'Prueba ficticia', '[]'::jsonb,
    current_setting('test.working_revision_105')::bigint,
    repeat('a',64), 100, repeat('b',64),
    '10500000-0000-4000-8000-000000000003', null,
    current_setting('test.working_object_updated_at_105')::timestamptz
  )$$,
  '22023', null,
  'el mensual no puede entrar por el historial de trabajo'
);

select throws_ok(
  $$select public.register_accepted_working_workbook(
    '10500000-0000-4000-8000-000000000001',
    '0a4c0000-0000-0000-0000-000000000001',
    'SEMANAL', date '2097-03-04', date '2097-03-10', null,
    repeat('a',64), 100,
    '0a4c0000-0000-0000-0000-000000000001/2097-03-03_2097-03-03/10500000-0000-4000-8000-000000000004.xlsx',
    'Prueba ficticia', '[]'::jsonb, 0,
    repeat('a',64), 100, repeat('b',64),
    '10500000-0000-4000-8000-000000000003', null, clock_timestamp()
  )$$,
  '22023', null,
  'una semana que no comienza el lunes se rechaza'
);

create temporary table accepted_working_105(id uuid);
select lives_ok(
  $$insert into accepted_working_105
    select public.register_accepted_working_workbook(
      '10500000-0000-4000-8000-000000000001',
      '0a4c0000-0000-0000-0000-000000000001',
      'DIARIO', date '2097-03-03', date '2097-03-03', null,
      repeat('a',64), 100,
      '0a4c0000-0000-0000-0000-000000000001/2097-03-03_2097-03-03/10500000-0000-4000-8000-000000000004.xlsx',
      'Ajuste diario ficticio', '[]'::jsonb,
      current_setting('test.working_revision_105')::bigint,
      repeat('a',64), 100, repeat('b',64),
      '10500000-0000-4000-8000-000000000003', null,
      current_setting('test.working_object_updated_at_105')::timestamptz
    )$$,
  'una version diaria atestada se registra'
);

reset role;

select is(
  (select window_type from public.payroll_working_versions
   where id = (select id from accepted_working_105)),
  'DIARIO',
  'la version conserva su frecuencia exacta'
);
select is(
  (select version_number from public.payroll_working_versions
   where id = (select id from accepted_working_105)),
  1,
  'la primera version del rango comienza en v1'
);
select is(
  (select count(*) from private.payroll_working_acceptance_receipts
   where version_id = (select id from accepted_working_105)),
  1::bigint,
  'el commit conserva un recibo idempotente privado'
);
select is(
  (select count(*) from public.reporting_periods
   where period_start = date '2097-03-03' and period_end = date '2097-03-03'),
  0::bigint,
  'una version corta no crea un periodo oficial solapado'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select lives_ok(
  $$select public.register_accepted_working_workbook(
    '10500000-0000-4000-8000-000000000001',
    '0a4c0000-0000-0000-0000-000000000001',
    'DIARIO', date '2097-03-03', date '2097-03-03', null,
    repeat('a',64), 100,
    '0a4c0000-0000-0000-0000-000000000001/2097-03-03_2097-03-03/10500000-0000-4000-8000-000000000004.xlsx',
    'Ajuste diario ficticio', '[]'::jsonb,
    current_setting('test.working_revision_105')::bigint,
    repeat('a',64), 100, repeat('b',64),
    '10500000-0000-4000-8000-000000000003', null,
    current_setting('test.working_object_updated_at_105')::timestamptz
  )$$,
  'repetir el mismo comando es idempotente'
);
reset role;

select is(
  (select count(*) from public.payroll_working_versions
   where company_id='0a4c0000-0000-0000-0000-000000000001'
     and window_type='DIARIO'
     and period_start=date '2097-03-03'),
  1::bigint,
  'la repeticion no duplica la version'
);

select throws_ok(
  $$update public.payroll_working_versions
    set general_reason='reescritura'
    where id=(select id from accepted_working_105)$$,
  '42501', null,
  'una version aceptada no puede reescribirse'
);

select throws_ok(
  $$delete from storage.objects
    where id='10500000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'los bytes registrados no pueden borrarse'
);

select ok(
  not has_table_privilege(
    'authenticated', 'private.payroll_working_acceptance_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'authenticated no puede observar recibos privados'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)'::regprocedure
  ) like '%join public.company_membership_roles cmr%cr.base_role = ''ADMIN_RRHH''%'
  and pg_get_functiondef(
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)'::regprocedure
  ) like '%p_verified_content_sha256 is distinct from p_content_sha256%',
  'el commit revalida actor RRHH y evidencia fisica'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)'::regprocedure
  ) like '%p_window_type not in (''DIARIO'', ''SEMANAL'', ''QUINCENAL'')%'
  and pg_get_functiondef(
    'public.register_accepted_working_workbook(uuid,uuid,text,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)'::regprocedure
  ) like '%v_work_date not between p_period_start and p_period_end%',
  'la base vuelve a validar frecuencia y fechas de cambios diarios'
);

select * from finish();
rollback;
