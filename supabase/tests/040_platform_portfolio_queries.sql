-- pgTAP GESTORA MT-3A: portafolio paginado y KPIs agregados.
create extension if not exists pgtap;

begin;
select plan(41);

select has_function(
  'public',
  'platform_company_portfolio_page',
  array['text', 'company_lifecycle_status', 'uuid', 'integer', 'integer'],
  'existe el RPC paginado del portafolio'
);
select has_function(
  'public',
  'platform_portfolio_summary',
  array[]::text[],
  'existe el RPC de KPIs agregados'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.platform_company_portfolio_page(text,company_lifecycle_status,uuid,integer,integer)',
    'EXECUTE'
  ),
  'authenticated puede invocar el portafolio; la autorización interna decide'
);
select ok(
  has_function_privilege('authenticated', 'public.platform_portfolio_summary()', 'EXECUTE'),
  'authenticated puede invocar el resumen; la autorización interna decide'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.platform_company_portfolio_page(text,company_lifecycle_status,uuid,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege('anon', 'public.platform_portfolio_summary()', 'EXECUTE'),
  'anon no recibe EXECUTE sobre ninguna proyección del portafolio'
);

insert into public.profiles (id, display_name, role, active) values
  ('94000000-0000-0000-0000-000000000101', 'Platform Viewer Portfolio', null, true),
  ('94000000-0000-0000-0000-000000000102', 'Sin Plataforma Portfolio', null, true),
  ('94000000-0000-0000-0000-000000000103', 'Miembro Activo Portfolio', null, true),
  ('94000000-0000-0000-0000-000000000104', 'Perfil Inactivo Portfolio', null, false),
  ('94000000-0000-0000-0000-000000000105', 'Membresía Inactiva Portfolio', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('94000000-0000-0000-0000-000000000101', 'VIEWER', true);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled, created_at
) values
  ('94000000-0000-0000-0000-000000000001', 'Portfolio 040 Alpha', 'Alpha Search Holdings SpA', 'portfolio-040-alpha', true, 'ACTIVE', false, '2026-01-01 12:00:00+00'),
  ('94000000-0000-0000-0000-000000000002', 'Portfolio 040 Beta', 'Beta Search Holdings SpA', 'portfolio-040-beta', true, 'ONBOARDING', false, '2026-04-01 12:00:00+00'),
  ('94000000-0000-0000-0000-000000000003', 'Portfolio 040 Gamma', 'Gamma Legal Exclusiva SpA', 'portfolio-040-gamma', false, 'SUSPENDED', false, '2026-03-01 12:00:00+00'),
  ('94000000-0000-0000-0000-000000000004', 'Portfolio 040 Delta', 'Delta Search Holdings SpA', 'portfolio-040-delta', true, 'ONBOARDING', false, '2026-02-01 12:00:00+00');

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('94000000-0000-0000-0000-000000000201', '94000000-0000-0000-0000-000000000103', '94000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('94000000-0000-0000-0000-000000000202', '94000000-0000-0000-0000-000000000104', '94000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('94000000-0000-0000-0000-000000000203', '94000000-0000-0000-0000-000000000105', '94000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', false);

update public.company_modules
set status = 'ENABLED', enabled_at = now(), enabled_by = '94000000-0000-0000-0000-000000000101'
where company_id = '94000000-0000-0000-0000-000000000001'
  and module_key = 'payroll';
update public.company_modules
set status = 'PILOT', enabled_at = now(), enabled_by = '94000000-0000-0000-0000-000000000101'
where company_id = '94000000-0000-0000-0000-000000000001'
  and module_key = 'expenses';

update public.company_onboarding_steps
set status = 'BLOCKED', notes = 'Fixture 040'
where company_id = '94000000-0000-0000-0000-000000000002'
  and step_key = 'security';

insert into public.company_invitations (
  company_id, email, role_id, status, invited_by
)
select
  cr.company_id,
  'pendiente-040@example.com',
  cr.id,
  'PENDING',
  '94000000-0000-0000-0000-000000000101'
from public.company_roles cr
where cr.company_id = '94000000-0000-0000-0000-000000000002'
  and cr.code = 'HR_ADMIN';

insert into public.company_invitations (
  company_id, email, role_id, status, invited_by
)
select
  cr.company_id,
  'expirada-040@example.com',
  cr.id,
  'EXPIRED',
  '94000000-0000-0000-0000-000000000101'
from public.company_roles cr
where cr.company_id = '94000000-0000-0000-0000-000000000002'
  and cr.code = 'HR_ADMIN';

set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-0000-0000-000000000101';

select lives_ok(
  $$select * from public.platform_company_portfolio_page('portfolio 040', null, null, 25, 0)$$,
  'un VIEWER de plataforma puede consultar la cartera agregada'
);
select lives_ok(
  $$select * from public.platform_portfolio_summary()$$,
  'un VIEWER de plataforma puede consultar los KPIs agregados'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 25, 0)$$,
  '42501',
  'Acceso exclusivo del control plane.',
  'un usuario autenticado sin membresía global no puede leer la cartera'
);
select throws_ok(
  $$select * from public.platform_portfolio_summary()$$,
  '42501',
  'Acceso exclusivo del control plane.',
  'un usuario autenticado sin membresía global no puede leer los KPIs'
);

reset role;
set local role anon;
set local request.jwt.claim.sub = '';
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 25, 0)$$,
  '42501',
  null,
  'anon no puede ejecutar el portafolio'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '94000000-0000-0000-0000-000000000101';

select is(
  (select count(*) from public.platform_company_portfolio_page('PORTFOLIO 040', null, null, 25, 0)),
  4::bigint,
  'la búsqueda por nombre ignora mayúsculas y minúsculas'
);
select is(
  (select count(*) from public.platform_company_portfolio_page('portfolio-040-gamma', null, null, 25, 0)),
  1::bigint,
  'la búsqueda encuentra por slug'
);
select is(
  (select count(*) from public.platform_company_portfolio_page('gamma legal exclusiva', null, null, 25, 0)),
  1::bigint,
  'la búsqueda encuentra por razón social'
);
select is(
  (select count(*) from public.platform_company_portfolio_page('%', null, null, 25, 0)),
  0::bigint,
  'los metacaracteres LIKE se tratan como texto literal'
);
select is(
  (select count(*) from public.platform_company_portfolio_page('portfolio 040', null, null, 2, 0)),
  2::bigint,
  'el límite acota el número de filas de la página'
);
select is(
  (select pg_catalog.max(total_count) from public.platform_company_portfolio_page('portfolio 040', null, null, 2, 0)),
  4::bigint,
  'total_count conserva el total filtrado antes del límite'
);
select is(
  (select pg_catalog.array_agg(slug) from public.platform_company_portfolio_page('portfolio 040', null, null, 2, 0)),
  array['portfolio-040-beta', 'portfolio-040-gamma']::text[],
  'la primera página ordena empresas recientes primero'
);
select is(
  (select pg_catalog.array_agg(slug) from public.platform_company_portfolio_page('portfolio 040', null, null, 2, 2)),
  array['portfolio-040-delta', 'portfolio-040-alpha']::text[],
  'el offset entrega la página siguiente en orden estable'
);
select is(
  (select pg_catalog.max(total_count) from public.platform_company_portfolio_page('portfolio 040', null, null, 2, 2)),
  4::bigint,
  'total_count se conserva también después del offset'
);
select is(
  (select count(*) from public.platform_company_portfolio_page('portfolio 040', 'ONBOARDING', null, 25, 0)),
  2::bigint,
  'el filtro de estado limita la cartera'
);
select ok(
  (select pg_catalog.bool_and(status = 'ONBOARDING')
   from public.platform_company_portfolio_page('portfolio 040', 'ONBOARDING', null, 25, 0)),
  'el filtro no mezcla empresas de otro estado'
);
select is(
  (select slug from public.platform_company_portfolio_page(
    null, null, '94000000-0000-0000-0000-000000000003', 25, 0
  )),
  'portfolio-040-gamma',
  'company_id resuelve una empresa exacta sin enumerar otras'
);
select ok(
  (select onboarding_blocked
   from public.platform_company_portfolio_page(
     null, null, '94000000-0000-0000-0000-000000000002', 25, 0
   )),
  'la proyección señala una empresa con onboarding bloqueado'
);
select ok(
  not exists (
    select 1
    from public.platform_company_portfolio_page('portfolio 040', null, null, 25, 0)
    where slug <> 'portfolio-040-beta' and onboarding_blocked
  ),
  'el bloqueo no contamina a otras empresas'
);
select ok(
  (select
     total_members = 3
     and active_members = 1
     and employee_count = 0
     and enabled_modules = 2
     and available_modules = (select count(*) from public.module_catalog where active)
   from public.platform_company_portfolio_page(
     null, null, '94000000-0000-0000-0000-000000000001', 25, 0
   )),
  'los agregados cuentan membresías pero no inventan nómina para un workspace bloqueado'
);

select is(
  (select count(*) from public.platform_portfolio_summary()),
  1::bigint,
  'el resumen devuelve exactamente una fila'
);
select is(
  (select total_companies from public.platform_portfolio_summary()),
  (select count(*) from public.companies),
  'total_companies cuenta toda la cartera'
);
select is(
  (select active_companies from public.platform_portfolio_summary()),
  (select count(*) from public.companies where status = 'ACTIVE'),
  'active_companies usa el ciclo de vida vigente'
);
select is(
  (select onboarding_companies from public.platform_portfolio_summary()),
  (select count(*) from public.companies where status = 'ONBOARDING'),
  'onboarding_companies cuenta clientes en incorporación'
);
select is(
  (select active_members from public.platform_portfolio_summary()),
  (
    select count(*)
    from public.company_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.active and p.active
  ),
  'active_members exige membresía y perfil activos'
);
select is(
  (select enabled_modules from public.platform_portfolio_summary()),
  (
    select count(*)
    from public.company_modules cm
    join public.module_catalog mc on mc.key = cm.module_key and mc.active
    where cm.status in ('ENABLED', 'PILOT')
  ),
  'enabled_modules agrega habilitados y pilotos del catálogo activo'
);
select is(
  (select pending_invitations from public.platform_portfolio_summary()),
  (select count(*) from public.company_invitations where status = 'PENDING' and expires_at > now()),
  'pending_invitations no cuenta invitaciones expiradas'
);
select is(
  (select setup_required_modules from public.platform_portfolio_summary()),
  (
    select count(*)
    from public.company_modules cm
    join public.module_catalog mc on mc.key = cm.module_key and mc.active
    where cm.status = 'SETUP_REQUIRED'
  ),
  'setup_required_modules agrega configuración pendiente'
);
select is(
  (select blocked_onboarding_companies from public.platform_portfolio_summary()),
  (
    select count(distinct os.company_id)
    from public.company_onboarding_steps os
    join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
    where os.status = 'BLOCKED'
  ),
  'blocked_onboarding_companies cuenta empresas, no pasos'
);
select is(
  (select suspended_companies from public.platform_portfolio_summary()),
  (select count(*) from public.companies where status = 'SUSPENDED'),
  'suspended_companies refleja el estado de ciclo de vida'
);

select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 0, 0)$$,
  '22023',
  'p_limit debe estar entre 1 y 100.',
  'se rechaza un límite igual a cero'
);
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 101, 0)$$,
  '22023',
  'p_limit debe estar entre 1 y 100.',
  'se rechaza un límite excesivo'
);
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, null, 0)$$,
  '22023',
  'p_limit debe estar entre 1 y 100.',
  'se rechaza un límite nulo explícito'
);
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 25, -1)$$,
  '22023',
  'p_offset debe ser mayor o igual a 0.',
  'se rechaza un offset negativo'
);
select throws_ok(
  $$select * from public.platform_company_portfolio_page(null, null, null, 25, null)$$,
  '22023',
  'p_offset debe ser mayor o igual a 0.',
  'se rechaza un offset nulo explícito'
);
select throws_ok(
  $$select * from public.platform_company_portfolio_page(repeat('x', 161), null, null, 25, 0)$$,
  '22023',
  'p_search no puede superar 160 caracteres.',
  'se rechaza una búsqueda desproporcionada'
);

reset role;
select * from finish();
rollback;
