-- P0-A: cuota distribuida para las ocho mutaciones del control plane.
create extension if not exists pgtap;

begin;
select plan(48);

-- Contrato estructural: el cliente solo puede consumir la función cerrada.
select has_table(
  'public', 'application_action_rate_limits',
  '1) existe el contador distribuido de acciones administrativas'
);
select has_function(
  'public', 'consume_platform_action_rate_limit', array['text','uuid','uuid'],
  '2) existe el RPC de cuota del control plane'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.consume_platform_action_rate_limit(text,uuid,uuid)',
    'EXECUTE'
  ),
  '3) authenticated entra exclusivamente por el RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.consume_platform_action_rate_limit(text,uuid,uuid)',
    'EXECUTE'
  ),
  '4) anon no puede consumir ni sondear cuotas'
);
select ok(
  not has_table_privilege(
    'authenticated', 'public.application_action_rate_limits', 'SELECT'
  ),
  '5) una sesion no puede inspeccionar contadores de otros actores'
);
select ok(
  not has_table_privilege(
    'service_role', 'public.application_action_rate_limits', 'SELECT'
  ),
  '6) ni service_role recibe acceso directo accidental al contador'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid='public.application_action_rate_limits'::regclass),
  '7) la tabla conserva RLS fail-closed'
);
select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid='public.application_action_rate_limits'::regclass
     and conname='application_action_rate_limits_scope_check')
    ~ 'platform.company.create'
  and (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid='public.application_action_rate_limits'::regclass
         and conname='application_action_rate_limits_scope_check')
    ~ 'platform.mfa.reset',
  '8) el scope queda cerrado desde alta de empresa hasta reset MFA'
);
select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid='public.application_action_rate_limits'::regclass
     and conname='application_action_rate_limits_key')
    ~* 'NULLS NOT DISTINCT',
  '9) el scope global usa una unica clave aun con company_id null'
);
select ok(
  (select prosecdef
   from pg_proc
   where oid='public.consume_platform_action_rate_limit(text,uuid,uuid)'::regprocedure),
  '10) autorizacion, cuota y auditoria ocurren dentro de SECURITY DEFINER'
);
select is(
  (select proconfig[1]
   from pg_proc
   where oid='public.consume_platform_action_rate_limit(text,uuid,uuid)'::regprocedure),
  'search_path=""',
  '11) el RPC fija search_path vacio'
);
select ok(
  pg_get_functiondef(
    'public.consume_platform_action_rate_limit(text,uuid,uuid)'::regprocedure
  ) ~* 'on conflict on constraint application_action_rate_limits_key',
  '12) la cuota se consume con un UPSERT atomico'
);
select ok(
  strpos(
    pg_get_functiondef(
      'public.consume_platform_action_rate_limit(text,uuid,uuid)'::regprocedure
    ),
    'least(limits.request_count + 1, v_limit + 2)'
  ) > 0,
  '13) el trafico bloqueado se satura y no crece sin limite'
);
select ok(
  strpos(
    pg_get_functiondef(
      'public.consume_platform_action_rate_limit(text,uuid,uuid)'::regprocedure
    ),
    'v_request_count = v_limit + 1'
  ) > 0,
  '14) solo el primer bloqueo de una ventana genera señal'
);

-- Fixtures aisladas de cualquier dato seed.
insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values
  ('77000000-0000-4000-8000-00000000000a', 'Limites Alpha', 'Limites Alpha SpA', 'limites-alpha', true, 'ONBOARDING', false),
  ('77000000-0000-4000-8000-00000000000b', 'Limites Beta', 'Limites Beta SpA', 'limites-beta', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('77000000-0000-4000-8000-000000000101', 'Owner limites', null, true),
  ('77000000-0000-4000-8000-000000000102', 'Admin limites', null, true),
  ('77000000-0000-4000-8000-000000000103', 'Viewer limites', null, true),
  ('77000000-0000-4000-8000-000000000104', 'Destino MFA limites', null, true),
  ('77000000-0000-4000-8000-000000000105', 'Admin revocado limites', null, true),
  ('77000000-0000-4000-8000-000000000106', 'Otro owner limites', null, true);

insert into public.platform_memberships (user_id, role, active) values
  ('77000000-0000-4000-8000-000000000101', 'OWNER', true),
  ('77000000-0000-4000-8000-000000000102', 'ADMIN', true),
  ('77000000-0000-4000-8000-000000000103', 'VIEWER', true),
  ('77000000-0000-4000-8000-000000000105', 'ADMIN', false),
  ('77000000-0000-4000-8000-000000000106', 'OWNER', true);

insert into public.company_roles (
  id, company_id, code, name, base_role, is_system, active
) values
  ('77000000-0000-4000-8000-000000000301', '77000000-0000-4000-8000-00000000000a', 'TEST_ADMIN', 'Admin de prueba', 'ADMIN_RRHH', true, true),
  ('77000000-0000-4000-8000-000000000302', '77000000-0000-4000-8000-00000000000b', 'TEST_ADMIN', 'Admin de prueba', 'ADMIN_RRHH', true, true);

insert into public.company_memberships (
  id, user_id, company_id, role, active
) values
  ('77000000-0000-4000-8000-000000000201', '77000000-0000-4000-8000-000000000104', '77000000-0000-4000-8000-00000000000a', 'ADMIN_RRHH', true),
  ('77000000-0000-4000-8000-000000000202', '77000000-0000-4000-8000-000000000104', '77000000-0000-4000-8000-00000000000b', 'ADMIN_RRHH', true);

insert into public.company_invitations (
  id, company_id, email, role_id, status, invited_by
) values
  ('77000000-0000-4000-8000-000000000401', '77000000-0000-4000-8000-00000000000a', 'limite-a@example.com', '77000000-0000-4000-8000-000000000301', 'PENDING', '77000000-0000-4000-8000-000000000101'),
  ('77000000-0000-4000-8000-000000000402', '77000000-0000-4000-8000-00000000000b', 'limite-b@example.com', '77000000-0000-4000-8000-000000000302', 'PENDING', '77000000-0000-4000-8000-000000000101');

create temporary table test_platform_limit (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer
);
grant all on test_platform_limit to authenticated;

set local role authenticated;
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit('platform.company.create')$$,
  '42501', 'Autenticacion requerida.',
  '15) sin identidad falla cerrado'
);

set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit('platform.company.create')$$,
  '42501', 'Acceso no autorizado.',
  '16) OWNER en AAL1 no consume cuota ni muta plataforma'
);

set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000103';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit('platform.company.create')$$,
  '42501', 'Acceso no autorizado.',
  '17) VIEWER no se convierte en manager por conocer el RPC'
);

set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000101';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit('platform.inventada')$$,
  '22023', 'Superficie no permitida.',
  '18) un scope fuera de allowlist se rechaza'
);
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.company.create', '77000000-0000-4000-8000-00000000000a')$$,
  '42501', 'Acceso no autorizado.',
  '19) el scope global no acepta una empresa inyectada'
);

insert into test_platform_limit
select * from public.consume_platform_action_rate_limit('platform.company.create');
select ok((select allowed from test_platform_limit), '20) OWNER AAL2 puede reservar alta de empresa');
select is((select request_limit from test_platform_limit), 5, '21) altas usan limite horario estricto');
select is((select remaining from test_platform_limit), 4, '22) la primera alta consume exactamente una unidad');

delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.invitation.create', '77000000-0000-4000-8000-00000000000a'
);
select ok((select allowed from test_platform_limit), '23) invitacion valida queda autorizada');
select is((select request_limit from test_platform_limit), 30, '24) invitaciones tienen cuota propia');

select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.invitation.resend',
      '77000000-0000-4000-8000-00000000000b',
      '77000000-0000-4000-8000-000000000401')$$,
  '42501', 'Acceso no autorizado.',
  '25) reenvio no acepta invitacion de otra empresa'
);
delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.invitation.resend',
  '77000000-0000-4000-8000-00000000000a',
  '77000000-0000-4000-8000-000000000401'
);
select ok((select allowed from test_platform_limit), '26) reenvio valida empresa y recurso');
select is((select request_limit from test_platform_limit), 30, '27) reenvio no comparte contador con alta');

select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.role.assign',
      '77000000-0000-4000-8000-00000000000b',
      '77000000-0000-4000-8000-000000000201')$$,
  '42501', 'Acceso no autorizado.',
  '28) asignacion no acepta membresia de otra empresa'
);
delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.role.assign',
  '77000000-0000-4000-8000-00000000000a',
  '77000000-0000-4000-8000-000000000201'
);
select ok((select allowed from test_platform_limit), '29) asignacion valida empresa y membresia');
select is((select request_limit from test_platform_limit), 30, '30) roles usan cuota conservadora');

delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.module.change', '77000000-0000-4000-8000-00000000000a'
);
select is((select request_limit from test_platform_limit), 60, '31) cambios de modulo usan cuota independiente');

delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.onboarding.change', '77000000-0000-4000-8000-00000000000a'
);
select is((select request_limit from test_platform_limit), 120, '32) checklist admite la mayor cuota administrativa');

delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.organization.create', '77000000-0000-4000-8000-00000000000a'
);
select is((select request_limit from test_platform_limit), 60, '33) organigrama tiene contador propio');

set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000102';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.mfa.reset', null, '77000000-0000-4000-8000-000000000104')$$,
  '42501', 'Acceso no autorizado.',
  '34) ADMIN no obtiene capacidad global de borrar MFA'
);

set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000101';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.mfa.reset', null, '77000000-0000-4000-8000-000000000101')$$,
  '42501', 'Acceso no autorizado.',
  '35) OWNER no puede reservar un reset propio'
);
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit(
      'platform.mfa.reset', null, '77000000-0000-4000-8000-000000000106')$$,
  '42501', 'Acceso no autorizado.',
  '36) un OWNER objetivo conserva recuperacion break-glass'
);
delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit(
  'platform.mfa.reset', null, '77000000-0000-4000-8000-000000000104'
);
select ok((select allowed from test_platform_limit), '37) OWNER reserva reset de una identidad no-owner');
select is((select request_limit from test_platform_limit), 10, '38) reset MFA usa el limite mas estricto despues de altas');

reset role;
update public.application_action_rate_limits
set request_count=5
where actor_id='77000000-0000-4000-8000-000000000101'
  and company_id is null
  and scope='platform.company.create';

set local role authenticated;
set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
delete from test_platform_limit;
insert into test_platform_limit
select * from public.consume_platform_action_rate_limit('platform.company.create');
select ok(not (select allowed from test_platform_limit), '39) solicitud sobre el limite queda bloqueada');
select is((select remaining from test_platform_limit), 0, '40) el bloqueo nunca entrega saldo negativo');
select ok(
  (select retry_after_seconds between 1 and 3600 from test_platform_limit),
  '41) Retry-After deriva de la ventana vigente'
);
select * from public.consume_platform_action_rate_limit('platform.company.create');
select * from public.consume_platform_action_rate_limit('platform.company.create');
reset role;

select is(
  (select request_count
   from public.application_action_rate_limits
   where actor_id='77000000-0000-4000-8000-000000000101'
     and company_id is null
     and scope='platform.company.create'),
  7,
  '42) trafico repetido se satura en limite mas dos'
);
select is(
  (select count(*)::integer
   from public.platform_audit_log
   where actor_id='77000000-0000-4000-8000-000000000101'
     and action='platform.action.rate_limited'
     and target_type='platform.company.create'),
  1,
  '43) solo el primer bloqueo amplifica la bitacora'
);
select ok(
  (select metadata->>'request_count'='6'
       and metadata->>'request_limit'='5'
       and (metadata->>'retry_after_seconds')::integer between 1 and 3600
       and (select count(*) from jsonb_object_keys(metadata))=3
   from public.platform_audit_log
   where actor_id='77000000-0000-4000-8000-000000000101'
     and action='platform.action.rate_limited'
     and target_type='platform.company.create'),
  '44) la señal solo contiene conteos operativos minimizados'
);
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='77000000-0000-4000-8000-000000000101'
     and scope='platform.company.create'),
  1,
  '45) nulls-not-distinct impide duplicar el contador global'
);
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='77000000-0000-4000-8000-000000000101'
     and scope in ('platform.invitation.create','platform.invitation.resend')),
  2,
  '46) scopes de invitacion mantienen contadores separados'
);

set local role authenticated;
set local request.jwt.claim.sub = '77000000-0000-4000-8000-000000000105';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.consume_platform_action_rate_limit('platform.company.create')$$,
  '42501', 'Acceso no autorizado.',
  '47) una membresia de plataforma revocada queda fuera'
);
reset role;
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='77000000-0000-4000-8000-000000000105'),
  0,
  '48) los rechazos de autorizacion no consumen cuota'
);

select * from finish();
rollback;
