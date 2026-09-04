-- pgTAP GESTORA MT-3B: módulos tenant-aware declarados en el catálogo.
create extension if not exists pgtap;

begin;
set local request.jwt.claim.aal = 'aal2';
select plan(21);

select has_column(
  'public', 'module_catalog', 'tenant_isolated',
  'el catálogo declara si un módulo está aislado por empresa'
);
select ok(
  (select is_nullable = 'NO'
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'module_catalog'
     and column_name = 'tenant_isolated'),
  'tenant_isolated nunca queda indefinido'
);
select is(
  (select column_default
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'module_catalog'
     and column_name = 'tenant_isolated'),
  'false',
  'los módulos son protegidos por defecto'
);
select ok(
  (select tenant_isolated from public.module_catalog where key = 'expenses'),
  'Rendiciones declara su aislamiento tenant-aware'
);
select is(
  (select count(*)::integer
   from public.module_catalog
   where tenant_isolated and key <> 'expenses'),
  0,
  'ningún módulo legacy se habilita accidentalmente'
);
select ok(
  pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_company_module_status(uuid,text,public.company_module_status)'::regprocedure
    ),
    'expenses'
  ) = 0,
  'el RPC del control plane no conoce módulos concretos'
);
select is(
  (select count(*)::integer
   from pg_catalog.regexp_matches(
     pg_get_functiondef(
       'public.platform_set_company_module_status(uuid,text,public.company_module_status)'::regprocedure
     ),
     'can_manage_platform\(\)',
     'g'
   )),
  2,
  'el RPC revalida autorización después de adquirir el lock'
);
select has_trigger(
  'public', 'company_modules', 'company_modules_provision_expense_defaults',
  'Rendiciones conserva su inicialización en un trigger de dominio'
);

insert into public.profiles (id, display_name, role, active) values
  ('aa000000-0000-0000-0000-000000000101', 'Platform MT3B Catalog', null, true),
  ('aa000000-0000-0000-0000-000000000102', 'Platform Viewer MT3B', null, true);

insert into public.platform_memberships (user_id, role, active) values
  ('aa000000-0000-0000-0000-000000000101', 'ADMIN', true),
  ('aa000000-0000-0000-0000-000000000102', 'VIEWER', true);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  'aa000000-0000-0000-0000-000000000001',
  'Catálogo Tenant', 'Catálogo Tenant SpA', 'catalogo-tenant',
  true, 'ONBOARDING', false
);

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select throws_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'payroll', 'DISABLED')$$,
  '23514',
  'Los módulos de un workspace operativo no se pueden cambiar hasta completar los gates backend y RLS de MT-3D.',
  'un módulo legacy sigue protegido en un workspace operativo'
);
reset role;

update public.module_catalog
set tenant_isolated = true
where key = 'payroll';

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
set local request.jwt.claim.aal = 'aal1';
select throws_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'expenses', 'DISABLED')$$,
  'P0001',
  'Esta operación requiere verificación de segundo factor (MFA).',
  'un ADMIN autorizado en aal1 no puede cambiar módulos'
);
set local request.jwt.claim.aal = 'aal2';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'payroll', 'DISABLED')$$,
  'el mismo RPC acepta cualquier módulo declarado como tenant-aware'
);
reset role;

select is(
  (select status::text
   from public.company_modules
   where company_id = '0a4c0000-0000-0000-0000-000000000001'
     and module_key = 'payroll'),
  'DISABLED',
  'el cambio gobernado por catálogo se persiste'
);

update public.module_catalog
set tenant_isolated = false
where key = 'payroll';

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'expenses', 'DISABLED')$$,
  'Rendiciones puede cambiar realmente de estado en ARCOTEX'
);
select lives_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'Rendiciones puede volver a habilitarse sin una excepción en el RPC'
);
select lives_ok(
  $$select public.platform_set_company_module_status(
    'aa000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'habilitar Rendiciones activa también su configuración de dominio'
);
reset role;

select is(
  (select count(*)::integer
   from public.expense_categories
   where company_id = 'aa000000-0000-0000-0000-000000000001'),
  5,
  'el trigger crea las cinco categorías iniciales'
);
select is(
  (select count(*)::integer
   from public.expense_policies
   where company_id = 'aa000000-0000-0000-0000-000000000001'),
  1,
  'el trigger crea la política general'
);

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status(
    'aa000000-0000-0000-0000-000000000001', 'expenses', 'ENABLED')$$,
  'repetir la habilitación es seguro'
);
reset role;

select ok(
  (select count(*) = 5
   from public.expense_categories
   where company_id = 'aa000000-0000-0000-0000-000000000001')
  and
  (select count(*) = 1
   from public.expense_policies
   where company_id = 'aa000000-0000-0000-0000-000000000001'),
  'la inicialización de Rendiciones permanece idempotente'
);
select is(
  (select count(*)::integer
   from public.platform_audit_log
   where actor_id = 'aa000000-0000-0000-0000-000000000101'
     and action = 'company.module.status_changed'),
  5,
  'todos los cambios autorizados continúan auditados'
);

set local role authenticated;
set local request.jwt.claim.sub = 'aa000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.platform_set_company_module_status(
    'aa000000-0000-0000-0000-000000000001', 'expenses', 'DISABLED')$$,
  '42501', null,
  'el catálogo no debilita la autorización del control plane'
);
reset role;

select * from finish();
rollback;
