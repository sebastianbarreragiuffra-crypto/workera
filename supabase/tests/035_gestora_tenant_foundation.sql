-- pgTAP GESTORA MT-1/MT-2: companies + company_memberships, aislamiento
-- entre tenants, bootstrap de ARCOTEX, y que ningún usuario pueda descubrir
-- ni auto-asignarse membresía en otra empresa.
create extension if not exists pgtap;

begin;
select plan(19);

-- ---------------------------------------------------------------------------
-- 1) ARCOTEX bootstrap
select ok(
  exists(select 1 from public.companies where slug = 'arcotex' and active),
  'ARCOTEX existe como companies.slug=arcotex, activa'
);

-- ---------------------------------------------------------------------------
-- 2) Fixtures: una segunda empresa ("GESTORA DEMO COMPANY", encargo sección
--    43) + usuarios/membresías cruzadas para probar aislamiento real.
insert into public.companies (id, name, slug, active) values
  ('90000000-0000-0000-0000-0000000000c2', 'GESTORA DEMO COMPANY', 'demo-co', true);

insert into public.profiles (id, display_name, role, active) values
  ('90000000-0000-0000-0000-000000000101', 'Fixture Arcotex User', 'ADMIN_RRHH', true),
  ('90000000-0000-0000-0000-000000000102', 'Fixture Demo User', 'ADMIN_RRHH', true),
  ('90000000-0000-0000-0000-000000000103', 'Fixture Multi-Tenant User', 'SUPERVISOR_PRODUCTION', true),
  ('90000000-0000-0000-0000-000000000104', 'Fixture No Membership User', 'ADMIN_RRHH', true);

insert into public.company_memberships (user_id, company_id, role, active) values
  ('90000000-0000-0000-0000-000000000101', (select id from public.companies where slug='arcotex'), 'ADMIN_RRHH', true),
  ('90000000-0000-0000-0000-000000000102', '90000000-0000-0000-0000-0000000000c2', 'ADMIN_RRHH', true),
  ('90000000-0000-0000-0000-000000000103', (select id from public.companies where slug='arcotex'), 'SUPERVISOR_PRODUCTION', true),
  ('90000000-0000-0000-0000-000000000103', '90000000-0000-0000-0000-0000000000c2', 'ADMIN_RRHH', true);
-- 000104 deliberadamente SIN ninguna membresía -- caso "0 memberships".

-- ---------------------------------------------------------------------------
-- 3) Aislamiento real: usuario de ARCOTEX no ve la membresía/empresa DEMO.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000101'; -- Arcotex user
select is(
  (select count(*)::int from public.company_memberships),
  1,
  'usuario de ARCOTEX ve exactamente 1 membresía (la suya, nunca la de DEMO)'
);
select is(
  (select company_id::text from public.company_memberships limit 1),
  (select id::text from public.companies where slug='arcotex'),
  'la única membresía visible es la de ARCOTEX'
);
select is(
  (select count(*)::int from public.companies),
  1,
  'usuario de ARCOTEX ve exactamente 1 empresa vía companies_select_member (nunca DEMO)'
);
select is(
  (select slug from public.companies limit 1),
  'arcotex',
  'la única empresa visible es arcotex -- el nombre/slug de DEMO nunca se filtra'
);
reset role;

-- 4) Simétrico: usuario de DEMO no ve nada de ARCOTEX.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000102'; -- Demo user
select is(
  (select count(*)::int from public.company_memberships),
  1,
  'usuario de DEMO ve exactamente 1 membresía (la suya)'
);
select is(
  (select slug from public.companies limit 1),
  'demo-co',
  'usuario de DEMO ve solo su empresa -- ARCOTEX nunca se filtra hacia DEMO'
);
reset role;

-- 5) Usuario multi-tenant ve AMBAS, ninguna empresa ajena de más.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::int from public.company_memberships),
  2,
  'usuario con 2 membresías activas ve exactamente 2 (ni más, ni menos)'
);
select is(
  (select count(*)::int from public.companies),
  2,
  'usuario con 2 membresías ve exactamente las 2 empresas correspondientes'
);
reset role;

-- 6) Usuario sin ninguna membresía: "0 memberships -> access denied" (la
--    decisión de bloquear la toma la aplicación a partir de este 0, pero
--    la fuente de verdad -- que sea 0 -- debe ser correcta acá).
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000104';
select is(
  (select count(*)::int from public.company_memberships),
  0,
  'usuario sin membresía ve 0 filas -- nunca puede ver empresas de otros por omisión'
);
select is(
  (select count(*)::int from public.companies),
  0,
  'usuario sin membresía no ve NINGUNA empresa (ni siquiera nombres/slugs)'
);
reset role;

-- ---------------------------------------------------------------------------
-- 7) Un usuario NUNCA puede auto-asignarse membresía en otra empresa (sin
--    policy de INSERT para `authenticated` -- deny-by-default real).
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000101';
select throws_ok(
  format(
    $$ insert into public.company_memberships (user_id, company_id, role) values (%L, %L, 'SUPER_ADMIN') $$,
    '90000000-0000-0000-0000-000000000101',
    '90000000-0000-0000-0000-0000000000c2'
  ),
  '42501',
  null,
  'un usuario no puede auto-insertar una membresía en otra empresa (sin policy de INSERT)'
);
select throws_ok(
  $$ update public.company_memberships set role = 'SUPER_ADMIN'
       where user_id = '90000000-0000-0000-0000-000000000101' $$,
  '42501',
  null,
  'company_memberships es read-only y rechaza la auto-promocion antes de RLS'
);
select is(
  (select role::text from public.company_memberships
   where user_id = '90000000-0000-0000-0000-000000000101'),
  'ADMIN_RRHH',
  'el rol permanece intacto: el usuario no puede auto-promoverse'
);
reset role;

-- ---------------------------------------------------------------------------
-- 8) anon: acceso denegado por completo.
set local role anon;
select throws_ok($$ select 1 from public.companies $$, '42501', null, 'anon: SELECT companies denegado');
select throws_ok($$ select 1 from public.company_memberships $$, '42501', null, 'anon: SELECT company_memberships denegado');
reset role;

-- ---------------------------------------------------------------------------
-- 9) active_company_memberships(): respeta membership.active=false sin
--    afectar la OTRA empresa activa del mismo usuario (encargo sección 35:
--    "company_membership.active=false debe revocar acceso a ESA empresa;
--    si el mismo usuario pertenece a otra empresa activa, sigue accediendo
--    a esa otra").
update public.company_memberships
set active = false
where user_id = '90000000-0000-0000-0000-000000000103'
  and company_id = (select id from public.companies where slug='arcotex');

set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::int from public.active_company_memberships()),
  1,
  'membership desactivada en UNA empresa no afecta la membresía activa en la OTRA'
);
select is(
  (select company_id::text from public.active_company_memberships()),
  '90000000-0000-0000-0000-0000000000c2',
  'la única membresía activa restante es la de DEMO, no la desactivada de ARCOTEX'
);
reset role;

-- 10) Desactivar la EMPRESA completa (companies.active=false) revoca acceso
--     aunque la membresía individual siga marcada active=true.
update public.companies
set active = false, status = 'SUSPENDED'
where slug = 'demo-co';
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000102'; -- Demo user, membership.active=true
select is(
  (select count(*)::int from public.active_company_memberships()),
  0,
  'desactivar companies.active revoca acceso aunque la membresía individual siga active=true'
);
reset role;

select * from finish();
rollback;
