-- pgTAP: desactivar una membresia ARCOTEX revoca de inmediato todas las
-- guardas legacy que componen sobre current_user_role(). Reactivarla restaura
-- el mismo rol sin destruir su asignacion RBAC.
create extension if not exists pgtap;

begin;
select plan(20);

select ok(
  pg_catalog.strpos(
    pg_get_functiondef('public.current_user_role()'::regprocedure),
    $$cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid$$
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.current_user_role()'::regprocedure),
    'cm.active'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.current_user_role()'::regprocedure),
    'c.active'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.current_user_role()'::regprocedure),
    'c.workspace_enabled'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.current_user_role()'::regprocedure),
    'c.slug'
  ) = 0,
  'current_user_role usa membresia activa y UUID sentinel, nunca el slug'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.current_user_role()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.current_user_role()', 'EXECUTE'
  ),
  'la funcion conserva su ACL cerrada'
);

insert into public.profiles (id, display_name, role, active) values
  ('86000000-0000-4000-8000-000000000101', 'Owner lifecycle 086', null, true),
  ('86000000-0000-4000-8000-000000000102', 'RRHH lifecycle 086', 'ADMIN_RRHH', true);
insert into public.platform_memberships (user_id, role, active)
values ('86000000-0000-4000-8000-000000000101', 'OWNER', true);
insert into public.holidays (id, holiday_date, name, active, created_by)
values (
  '86000000-0000-4000-8000-000000000201', '2086-06-17',
  'Fixture lifecycle 086', true,
  '86000000-0000-4000-8000-000000000102'
);

select ok(
  exists (
    select 1
    from public.company_memberships cm
    where cm.user_id = '86000000-0000-4000-8000-000000000102'
      and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and cm.active
  )
  and exists (
    select 1
    from public.company_membership_roles cmr
    join public.company_memberships cm
      on cm.company_id = cmr.company_id and cm.id = cmr.membership_id
    where cm.user_id = '86000000-0000-4000-8000-000000000102'
      and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
  ),
  'el trigger bootstrap crea membresia y rol RBAC ARCOTEX'
);

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000102","aal":"aal2"}';
select is(
  public.current_user_role(), 'ADMIN_RRHH'::public.app_role,
  'la membresia activa expone el rol legacy esperado'
);
select ok(
  public.is_admin_rrhh()
  and public.is_privileged_admin()
  and public.is_corporate_user(),
  'las guardas legacy heredan la autoridad de la membresia activa'
);
select is(
  (select count(*)::integer
   from public.holidays
   where id = '86000000-0000-4000-8000-000000000201'),
  1,
  'RRHH activo puede leer una superficie legacy global'
);
reset role;
set local request.jwt.claims = '';

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000101","aal":"aal1"}';
select throws_ok(
  format(
    $$select public.platform_set_company_membership_active(%L, false)$$,
    (select id
     from public.company_memberships
     where user_id = '86000000-0000-4000-8000-000000000102'
       and company_id = '0a4c0000-0000-0000-0000-000000000001')
  ),
  'P0001', 'Esta operación requiere verificación de segundo factor (MFA).',
  'OWNER en AAL1 no puede cerrar una membresia'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select active
   from public.company_memberships
   where user_id = '86000000-0000-4000-8000-000000000102'
     and company_id = '0a4c0000-0000-0000-0000-000000000001'),
  'el rechazo MFA no cambia la membresia'
);

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  format(
    $$select public.platform_set_company_membership_active(%L, false)$$,
    (select id
     from public.company_memberships
     where user_id = '86000000-0000-4000-8000-000000000102'
       and company_id = '0a4c0000-0000-0000-0000-000000000001')
  ),
  'OWNER en AAL2 desactiva la membresia'
);
reset role;
set local request.jwt.claims = '';

select ok(
  not (select active
       from public.company_memberships
       where user_id = '86000000-0000-4000-8000-000000000102'
         and company_id = '0a4c0000-0000-0000-0000-000000000001')
  and (select role = 'ADMIN_RRHH'::public.app_role and active
       from public.profiles
       where id = '86000000-0000-4000-8000-000000000102')
  and exists (
    select 1
    from public.company_membership_roles cmr
    join public.company_memberships cm
      on cm.company_id = cmr.company_id and cm.id = cmr.membership_id
    where cm.user_id = '86000000-0000-4000-8000-000000000102'
      and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
  ),
  'la baja preserva perfil legacy y rol RBAC para una reactivacion explicita'
);

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000102","aal":"aal2"}';
select is(
  public.current_user_role(), null::public.app_role,
  'una membresia inactiva ya no expone profiles.role'
);
select ok(
  not public.is_admin_rrhh()
  and not public.is_privileged_admin()
  and not public.is_corporate_user(),
  'todas las guardas legacy pierden autorizacion inmediatamente'
);
select is(
  (select count(*)::integer
   from public.holidays
   where id = '86000000-0000-4000-8000-000000000201'),
  0,
  'el exmiembro ya no puede leer la superficie legacy global'
);
select lives_ok(
  $$update public.holidays
    set active = false
    where id = '86000000-0000-4000-8000-000000000201'$$,
  'la escritura filtrada por RLS no produce una excepcion'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select active
   from public.holidays
   where id = '86000000-0000-4000-8000-000000000201'),
  'el exmiembro tampoco puede modificar la superficie legacy'
);

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  format(
    $$select public.platform_set_company_membership_active(%L, true)$$,
    (select id
     from public.company_memberships
     where user_id = '86000000-0000-4000-8000-000000000102'
       and company_id = '0a4c0000-0000-0000-0000-000000000001')
  ),
  'OWNER en AAL2 reactiva la membresia con el rol preservado'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select active
   from public.company_memberships
   where user_id = '86000000-0000-4000-8000-000000000102'
     and company_id = '0a4c0000-0000-0000-0000-000000000001')
  and exists (
    select 1
    from public.company_membership_roles cmr
    join public.company_memberships cm
      on cm.company_id = cmr.company_id and cm.id = cmr.membership_id
    join public.company_roles cr
      on cr.company_id = cmr.company_id and cr.id = cmr.role_id
    where cm.user_id = '86000000-0000-4000-8000-000000000102'
      and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and cr.active
      and cr.base_role = 'ADMIN_RRHH'
  ),
  'la reactivacion conserva una asignacion RBAC compatible'
);

set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000102","aal":"aal2"}';
select is(
  public.current_user_role(), 'ADMIN_RRHH'::public.app_role,
  'reactivar restaura el rol legacy sin reescribir el perfil'
);
select ok(
  public.is_admin_rrhh()
  and public.is_privileged_admin()
  and public.is_corporate_user(),
  'reactivar restaura las guardas legacy'
);
reset role;
set local request.jwt.claims = '';

update public.companies
set workspace_enabled = false
where id = '0a4c0000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '86000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"86000000-0000-4000-8000-000000000102","aal":"aal2"}';
select is(
  public.current_user_role(), null::public.app_role,
  'cerrar el workspace sentinel revoca la autoridad legacy aunque la membresia siga activa'
);
reset role;
set local request.jwt.claims = '';

select * from finish();
rollback;
