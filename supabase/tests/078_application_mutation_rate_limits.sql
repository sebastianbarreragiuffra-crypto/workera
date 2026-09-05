-- P0-A: cuota distribuida para mutaciones de Rendiciones y del workspace laboral.
create extension if not exists pgtap;

begin;
select plan(50);

-- Contrato estructural y privilegios cerrados.
select has_table(
  'public', 'application_action_rate_limits',
  '1) las mutaciones comparten un contador distribuido'
);
select has_function(
  'public', 'consume_application_action_rate_limit', array['text','uuid'],
  '2) existe el RPC tenant-aware de cuota de aplicacion'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.consume_application_action_rate_limit(text,uuid)',
    'EXECUTE'
  ),
  '3) authenticated solo entra por el RPC cerrado'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.consume_application_action_rate_limit(text,uuid)',
    'EXECUTE'
  ),
  '4) anon no puede consumir ni sondear cuotas'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.consume_application_action_rate_limit(text,uuid)',
    'EXECUTE'
  ),
  '5) service_role no recibe esta capacidad por accidente'
);
select ok(
  not has_table_privilege(
    'authenticated', 'public.application_action_rate_limits', 'SELECT'
  ),
  '6) una sesion no inspecciona contadores ajenos'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid='public.application_action_rate_limits'::regclass),
  '7) el contador conserva RLS fail-closed'
);
select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid='public.application_action_rate_limits'::regclass
     and conname='application_action_rate_limits_scope_check')
    ~ 'expenses.workflow.mutate'
  and (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid='public.application_action_rate_limits'::regclass
         and conname='application_action_rate_limits_scope_check')
    ~ 'workforce.review.mutate'
  and (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid='public.application_action_rate_limits'::regclass
         and conname='application_action_rate_limits_scope_check')
    ~ 'workforce.sync.rerun',
  '8) el vocabulario de scopes queda cerrado de gastos a sincronizacion'
);
select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid='public.application_action_rate_limits'::regclass
     and conname='application_action_rate_limits_request_count_check')
    ~ '242',
  '9) el contador admite la saturacion de la cuota maxima'
);
select ok(
  (select prosecdef
   from pg_proc
   where oid='public.consume_application_action_rate_limit(text,uuid)'::regprocedure),
  '10) autorizacion, consumo y auditoria son una frontera SECURITY DEFINER'
);
select is(
  (select proconfig[1]
   from pg_proc
   where oid='public.consume_application_action_rate_limit(text,uuid)'::regprocedure),
  'search_path=""',
  '11) el RPC fija search_path vacio'
);
select ok(
  pg_get_functiondef(
    'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
  ) ~* 'on conflict on constraint application_action_rate_limits_key',
  '12) el consumo usa un UPSERT atomico'
);
select ok(
  strpos(
    pg_get_functiondef(
      'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
    ),
    'least(limits.request_count + 1, v_limit + 2)'
  ) > 0,
  '13) el trafico bloqueado se satura y no crece sin limite'
);
select ok(
  strpos(
    pg_get_functiondef(
      'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
    ),
    'v_request_count = v_limit + 1'
  ) > 0,
  '14) solo el primer bloqueo de la ventana emite auditoria'
);
select ok(
  strpos(
    pg_get_functiondef(
      'public.consume_application_action_rate_limit(text,uuid)'::regprocedure
    ),
    'if p_company_id is not null'
  ) > 0,
  '15) el navegador no puede elegir empresa en el dominio laboral legacy'
);

-- Fixtures independientes del seed. Los perfiles laborales se reflejan en la
-- membresia ARCOTEX mediante el trigger de compatibilidad ya existente.
insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values
  ('78000000-0000-4000-8000-00000000000a', 'Mutaciones Alpha', 'Mutaciones Alpha SpA', 'mutaciones-alpha', true, 'ONBOARDING', false),
  ('78000000-0000-4000-8000-00000000000b', 'Mutaciones Beta', 'Mutaciones Beta SpA', 'mutaciones-beta', true, 'ONBOARDING', false),
  ('78000000-0000-4000-8000-00000000000c', 'Mutaciones Gamma', 'Mutaciones Gamma SpA', 'mutaciones-gamma', true, 'ONBOARDING', false);

update public.company_modules
set status='PILOT', enabled_at=now()
where company_id in (
  '78000000-0000-4000-8000-00000000000a',
  '78000000-0000-4000-8000-00000000000c'
) and module_key='expenses';

insert into public.profiles (id, display_name, role, active) values
  ('78000000-0000-4000-8000-000000000101', 'Admin laboral', 'SUPER_ADMIN', true),
  ('78000000-0000-4000-8000-000000000102', 'Supervisor laboral', 'SUPERVISOR_PRODUCTION', true),
  ('78000000-0000-4000-8000-000000000103', 'Persona gastos Alpha', null, true),
  ('78000000-0000-4000-8000-000000000104', 'Persona gastos Beta', null, true),
  ('78000000-0000-4000-8000-000000000105', 'Membresia revocada', null, true),
  ('78000000-0000-4000-8000-000000000106', 'Admin inactivo', 'ADMIN_RRHH', false);

insert into public.company_memberships (
  id, user_id, company_id, role, active
) values
  ('78000000-0000-4000-8000-000000000201', '78000000-0000-4000-8000-000000000103', '78000000-0000-4000-8000-00000000000a', 'ADMIN_RRHH', true),
  ('78000000-0000-4000-8000-000000000202', '78000000-0000-4000-8000-000000000103', '78000000-0000-4000-8000-00000000000b', 'ADMIN_RRHH', true),
  ('78000000-0000-4000-8000-000000000203', '78000000-0000-4000-8000-000000000104', '78000000-0000-4000-8000-00000000000b', 'ADMIN_RRHH', true),
  ('78000000-0000-4000-8000-000000000204', '78000000-0000-4000-8000-000000000105', '78000000-0000-4000-8000-00000000000a', 'ADMIN_RRHH', false);

create temporary table test_application_limit (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer
);
grant all on test_application_limit to authenticated;

set local role authenticated;
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a')$$,
  '42501', 'Autenticacion requerida.',
  '16) sin identidad falla cerrado'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.schedules.manage')$$,
  '42501', 'Acceso no autorizado.',
  '17) un administrador privilegiado en AAL1 no consume cuota'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000103';
delete from test_application_limit;
insert into test_application_limit
select * from public.consume_application_action_rate_limit(
  'expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a'
);
select ok((select allowed from test_application_limit), '18) un miembro con modulo activo reserva una mutacion de gastos');
select is((select request_limit from test_application_limit), 240, '19) el workflow de gastos soporta edicion interactiva acotada');
select is((select remaining from test_application_limit), 239, '20) la primera mutacion consume exactamente una unidad');

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000104';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a')$$,
  '42501', 'Acceso no autorizado.',
  '21) conocer el id de otro tenant no concede su cuota'
);
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000b')$$,
  '42501', 'Acceso no autorizado.',
  '22) una membresia valida no supera un modulo apagado'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000105';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a')$$,
  '42501', 'Acceso no autorizado.',
  '23) una membresia revocada queda fuera'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.inventada')$$,
  '22023', 'Superficie no permitida.',
  '24) un scope fuera de la allowlist se rechaza'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.schedules.manage', '0a4c0000-0000-0000-0000-000000000001')$$,
  '42501', 'Acceso no autorizado.',
  '25) ni un administrador puede inyectar empresa al scope laboral'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal1';
delete from test_application_limit;
insert into test_application_limit
select * from public.consume_application_action_rate_limit('workforce.review.mutate');
select ok((select allowed from test_application_limit), '26) un supervisor puede reservar una decision de su flujo');
select is((select request_limit from test_application_limit), 240, '27) la revision diaria admite trabajo operativo sin cuota infinita');
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.medical.decide')$$,
  '42501', 'Acceso no autorizado.',
  '28) un supervisor no reserva decisiones medicas'
);
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.schedules.manage')$$,
  '42501', 'Acceso no autorizado.',
  '29) un supervisor no reserva configuracion administrativa'
);

set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
delete from test_application_limit;
insert into test_application_limit
select * from public.consume_application_action_rate_limit('workforce.medical.decide');
select ok((select allowed from test_application_limit), '30) un administrador AAL2 reserva una decision medica');
select is((select request_limit from test_application_limit), 60, '31) decisiones medicas tienen cuota propia');

delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.schedules.manage');
select is((select request_limit from test_application_limit), 60, '32) horarios tienen cuota administrativa');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.periods.manage');
select is((select request_limit from test_application_limit), 30, '33) periodos usan una cuota mas estricta');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.payroll.manage');
select is((select request_limit from test_application_limit), 30, '34) nomina usa contador independiente');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.roster.manage');
select is((select request_limit from test_application_limit), 20, '35) importacion de roster queda acotada');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.meals.manage');
select is((select request_limit from test_application_limit), 20, '36) colaciones queda acotada');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.rule_engine.run');
select is((select request_limit from test_application_limit), 10, '37) ejecuciones manuales del motor usan cuota estricta');
delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.sync.rerun');
select is((select request_limit from test_application_limit), 10, '38) reruns de integracion usan cuota estricta');

delete from test_application_limit;
insert into test_application_limit select * from public.consume_application_action_rate_limit('workforce.review.mutate');
select ok((select allowed from test_application_limit), '39) SUPER_ADMIN tambien opera el flujo laboral autorizado');
reset role;
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='78000000-0000-4000-8000-000000000101'
     and company_id='0a4c0000-0000-0000-0000-000000000001'),
  9,
  '40) cada tipo de mutacion laboral mantiene un contador separado'
);

reset role;
update public.company_modules
set status='PILOT', enabled_at=now()
where company_id='78000000-0000-4000-8000-00000000000b'
  and module_key='expenses';
set local role authenticated;
set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000103';
set local request.jwt.claim.aal = 'aal1';
select * from public.consume_application_action_rate_limit(
  'expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000b'
);
reset role;
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='78000000-0000-4000-8000-000000000103'
     and scope='expenses.workflow.mutate'),
  2,
  '41) dos empresas del mismo actor nunca comparten contador'
);

reset role;
update public.application_action_rate_limits
set request_count=240
where actor_id='78000000-0000-4000-8000-000000000103'
  and company_id='78000000-0000-4000-8000-00000000000a'
  and scope='expenses.workflow.mutate';
set local role authenticated;
set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000103';
delete from test_application_limit;
insert into test_application_limit
select * from public.consume_application_action_rate_limit(
  'expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a'
);
select ok(not (select allowed from test_application_limit), '42) una solicitud sobre la cuota queda bloqueada');
select is((select remaining from test_application_limit), 0, '43) el bloqueo nunca entrega saldo negativo');
select ok(
  (select retry_after_seconds between 1 and 3600 from test_application_limit),
  '44) Retry-After deriva de la ventana vigente'
);
select * from public.consume_application_action_rate_limit(
  'expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a'
);
select * from public.consume_application_action_rate_limit(
  'expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a'
);
reset role;
select is(
  (select request_count
   from public.application_action_rate_limits
   where actor_id='78000000-0000-4000-8000-000000000103'
     and company_id='78000000-0000-4000-8000-00000000000a'
     and scope='expenses.workflow.mutate'),
  242,
  '45) trafico repetido se satura en limite mas dos'
);
select is(
  (select count(*)::integer
   from public.audit_log
   where actor_id='78000000-0000-4000-8000-000000000103'
     and action='APPLICATION_ACTION_RATE_LIMITED'
     and entity_id='78000000-0000-4000-8000-00000000000a'),
  1,
  '46) solo el primer bloqueo amplifica la bitacora'
);
select ok(
  (select metadata->>'company_id'='78000000-0000-4000-8000-00000000000a'
       and metadata->>'scope'='expenses.workflow.mutate'
       and metadata->>'request_count'='241'
       and metadata->>'request_limit'='240'
       and (metadata->>'retry_after_seconds')::integer between 1 and 3600
       and (select count(*) from jsonb_object_keys(metadata))=5
   from public.audit_log
   where actor_id='78000000-0000-4000-8000-000000000103'
     and action='APPLICATION_ACTION_RATE_LIMITED'
     and entity_id='78000000-0000-4000-8000-00000000000a'),
  '47) la auditoria contiene solo identificadores y conteos operativos'
);

set local role authenticated;
set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000105';
set local request.jwt.claim.aal = 'aal1';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('expenses.workflow.mutate', '78000000-0000-4000-8000-00000000000a')$$,
  '42501', 'Acceso no autorizado.',
  '48) un rechazo de membresia sigue fallando cerrado'
);
reset role;
select is(
  (select count(*)::integer
   from public.application_action_rate_limits
   where actor_id='78000000-0000-4000-8000-000000000105'),
  0,
  '49) los rechazos no consumen cuota'
);

set local role authenticated;
set local request.jwt.claim.sub = '78000000-0000-4000-8000-000000000106';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.consume_application_action_rate_limit('workforce.review.mutate')$$,
  '42501', 'Acceso no autorizado.',
  '50) un profile inactivo no conserva acceso laboral'
);

select * from finish();
rollback;
