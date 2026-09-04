create extension if not exists pgtap;

begin;
select plan(8);

select isnt(
  public.can_manage_platform(),
  null,
  'can_manage_platform never returns NULL without a session'
);

insert into public.profiles (id, display_name, role, active) values
  ('98200000-0000-0000-0000-000000000001', 'Supervisor without platform role', 'SUPERVISOR_PRODUCTION', true);

set local role authenticated;
set local request.jwt.claim.sub = '98200000-0000-0000-0000-000000000001';

select isnt(
  public.can_manage_platform(),
  null,
  'can_manage_platform never returns NULL for an authenticated non-platform user'
);
select ok(not public.can_manage_platform(), 'a non-platform user is denied explicitly');

select throws_ok(
  $$select public.platform_create_company('Unauthorized Company', 'unauthorized-company')$$,
  '42501',
  'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'a non-platform user cannot invoke a privileged control-plane RPC'
);
select is(
  (select count(*)::integer from public.companies where slug = 'unauthorized-company'),
  0,
  'the denied control-plane call leaves no company behind'
);
reset role;

select is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~ 'v_actor_id is null or not public\.can_manage_platform\(\)'
  ),
  7,
  'all current control-plane RPCs share the corrected boolean guard'
);

insert into public.profiles (id, display_name, role, active) values
  ('98200000-0000-0000-0000-000000000002', 'User without legacy role', null, true);

set local role authenticated;
set local request.jwt.claim.sub = '98200000-0000-0000-0000-000000000002';

select is(
  (
    select array_agg(value order by value)
    from unnest(array[
      public.is_super_admin(),
      public.is_admin_rrhh(),
      public.is_supervisor_production(),
      public.is_supervisor_installation(),
      public.is_privileged_admin()
    ]) as value
    where value is null
  ),
  null::boolean[],
  'exact-role guards never return NULL for a user without an assigned role'
);

select throws_ok(
  $$select * from public.cleanup_demo_data()$$,
  'P0001',
  'Solo SUPER_ADMIN puede ejecutar la limpieza de datos de demostración.',
  'a user without a role cannot invoke the privileged demo cleanup RPC'
);
reset role;

select * from finish();
rollback;
