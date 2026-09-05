-- pgTAP: los gates laborales legacy derivan ARCOTEX por UUID estable y no por
-- el slug mutable de presentación.
create extension if not exists pgtap;

begin;
select plan(9);

select ok(
  pg_catalog.strpos(pg_get_functiondef(
    'public.can_read_supplier_master_path(text)'::regprocedure
  ), $$c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid$$) > 0
  and pg_catalog.strpos(pg_get_functiondef(
    'public.can_read_supplier_master_path(text)'::regprocedure
  ), 'c.slug') = 0,
  'can_read_supplier_master_path usa el UUID sentinel y no el slug'
);
select ok(
  pg_catalog.strpos(pg_get_functiondef(
    'public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure
  ), $$c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid$$) > 0
  and pg_catalog.strpos(pg_get_functiondef(
    'public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure
  ), 'c.slug') = 0,
  'authorize_workforce_data_access usa el UUID sentinel y no el slug'
);
select ok(
  pg_catalog.strpos(pg_get_functiondef(
    'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
  ), $$c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid$$) > 0
  and pg_catalog.strpos(pg_get_functiondef(
    'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
  ), 'c.slug') = 0,
  'consume_application_action_rate_limit usa el UUID sentinel y no el slug'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.can_read_supplier_master_path(text)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.authorize_workforce_data_access(text,uuid,text,date,date)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.consume_application_action_rate_limit(text,uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.can_read_supplier_master_path(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.authorize_workforce_data_access(text,uuid,text,date,date)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.consume_application_action_rate_limit(text,uuid)', 'EXECUTE'
  ),
  'la sustitución conserva grants cerrados para las tres funciones'
);

update public.companies
set slug = 'arcotex-sentinel-084'
where id = '0a4c0000-0000-0000-0000-000000000001';
insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '84000000-0000-4000-8000-000000000001',
  'Slug señuelo 084', 'Slug señuelo 084 SpA', 'arcotex',
  true, 'ONBOARDING', false
);
select ok(
  (select slug = 'arcotex-sentinel-084' and workspace_enabled
   from public.companies
   where id = '0a4c0000-0000-0000-0000-000000000001')
  and exists (
    select 1 from public.companies
    where id = '84000000-0000-4000-8000-000000000001'
      and slug = 'arcotex' and not workspace_enabled
  ),
  'el fixture separa el sentinel operativo de una empresa con el slug antiguo'
);

insert into public.profiles (id, display_name, role, active)
values (
  '84000000-0000-4000-8000-000000000101',
  'Admin sentinel 084', 'ADMIN_RRHH', true
);
select ok(
  exists (
    select 1 from public.company_memberships
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and user_id = '84000000-0000-4000-8000-000000000101'
      and active
  )
  and not exists (
    select 1 from public.company_memberships
    where company_id = '84000000-0000-4000-8000-000000000001'
      and user_id = '84000000-0000-4000-8000-000000000101'
      and active
  ),
  'la identidad laboral permanece miembro del sentinel, no del slug señuelo'
);

update public.supplier_master_imports
set status = 'REPLACED',
    activated_at = coalesce(activated_at, pg_catalog.now()),
    replaced_at = coalesce(replaced_at, pg_catalog.now())
where status = 'ACTIVE';
insert into public.supplier_master_imports (
  id, uploaded_by, original_filename, storage_path, file_size, row_count,
  inserted_count, updated_count, unchanged_count, rejected_count,
  status, activated_at
) values (
  '84000000-0000-4000-8000-000000000201',
  '84000000-0000-4000-8000-000000000101',
  'maestro-sentinel-084.xlsx', 'imports/maestro-sentinel-084.xlsx',
  1024, 1, 1, 0, 0, 0, 'ACTIVE', pg_catalog.now()
);

create temporary table test_workforce_result_084 (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer,
  storage_path text,
  original_filename text
);
create temporary table test_application_result_084 (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer
);
grant all on test_workforce_result_084, test_application_result_084
  to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '84000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000101","aal":"aal2"}';
select ok(
  public.can_read_supplier_master_path('imports/maestro-sentinel-084.xlsx'),
  'renombrar el slug no corta la lectura autorizada del maestro activo'
);
insert into test_workforce_result_084
select * from public.authorize_workforce_data_access(
  'attendance.export', null, 'SEMANAL', '2026-09-01', '2026-09-07'
);
insert into test_application_result_084
select * from public.consume_application_action_rate_limit(
  'workforce.schedules.manage'
);
reset role;
set local request.jwt.claims = '';

select ok(
  (select allowed and request_limit = 20
   from test_workforce_result_084)
  and exists (
    select 1 from public.workforce_data_access_limits
    where actor_id = '84000000-0000-4000-8000-000000000101'
      and company_id = '0a4c0000-0000-0000-0000-000000000001'
      and scope = 'attendance.export'
  ),
  'la autorización laboral consume cuota contra el UUID sentinel renombrado'
);
select ok(
  (select allowed and request_limit = 60
   from test_application_result_084)
  and exists (
    select 1 from public.application_action_rate_limits
    where actor_id = '84000000-0000-4000-8000-000000000101'
      and company_id = '0a4c0000-0000-0000-0000-000000000001'
      and scope = 'workforce.schedules.manage'
  ),
  'la cuota de mutación laboral también deriva el UUID sentinel renombrado'
);

select * from finish();
rollback;
