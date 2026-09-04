-- pgTAP GESTORA MT-3A: RPCs atomicos del panel de plataforma.
create extension if not exists pgtap;

begin;
select plan(63);

-- Desde la etapa F de MFA (docs/MFA_DESIGN.md sección 7), los RPC sensibles
-- llaman a `enforce_mfa_for_privileged()`. Las sesiones de esta prueba ejercen
-- operaciones privilegiadas, así que declaran el nivel que tendría una sesión
-- real después de verificar su segundo factor. No relaja nada: que la guarda
-- distinga aal1 de aal2 se prueba en 049.
set local request.jwt.claim.aal = 'aal2';

select has_function('public', 'platform_create_company',
  array['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'existe el RPC atomico para crear empresas');
select has_function('public', 'platform_assign_company_role', array['uuid', 'uuid'],
  'existe el RPC atomico para reemplazar roles empresariales');
select has_function('public', 'platform_set_company_module_status',
  array['uuid', 'text', 'company_module_status'],
  'existe el RPC atomico para cambiar entitlements');
select has_function('public', 'platform_set_onboarding_step_completed',
  array['uuid', 'text', 'boolean'],
  'existe el RPC atomico para completar onboarding');
select has_function('public', 'platform_create_company_invitation',
  array['uuid', 'text', 'uuid', 'timestamp with time zone'],
  'existe el RPC atomico para crear invitaciones');
select has_function('public', 'platform_create_organization_unit',
  array['uuid', 'uuid', 'text', 'text', 'organization_unit_type', 'integer'],
  'existe el RPC atomico para crear unidades organizacionales');

select ok(
  has_function_privilege('authenticated',
    'public.platform_create_company(text,text,text,text,text,text,text,text)', 'EXECUTE'),
  'authenticated puede invocar la API cerrada del control plane');
select ok(
  not has_function_privilege('anon',
    'public.platform_create_company(text,text,text,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.platform_assign_company_role(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.platform_set_company_module_status(uuid,text,company_module_status)', 'EXECUTE'),
  'anon no recibe EXECUTE sobre los RPC de administracion');

insert into public.profiles (id, display_name, role, active) values
  ('92000000-0000-0000-0000-000000000101', 'Platform Manager RPC', null, true),
  ('92000000-0000-0000-0000-000000000102', 'Platform Viewer RPC', null, true),
  ('92000000-0000-0000-0000-000000000103', 'Cliente Member RPC', null, true),
  ('92000000-0000-0000-0000-000000000104', 'ARCOTEX Legacy RPC', null, true);

insert into public.platform_memberships (user_id, role, active) values
  ('92000000-0000-0000-0000-000000000101', 'ADMIN', true),
  ('92000000-0000-0000-0000-000000000102', 'VIEWER', true);

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_create_company(
    '  Cliente Alpha  ', 'Cliente-Alpha-RPC', null, '  Ana Cliente  ',
    '  CONTACTO@EXAMPLE.COM ', ' enterprise ', ' cl ', 'America/Santiago')$$,
  'un ADMIN de plataforma crea una empresa');
reset role;

select ok(
  (select name = 'Cliente Alpha'
      and slug = 'cliente-alpha-rpc'
      and legal_name = 'Cliente Alpha'
      and status = 'ONBOARDING'
      and active and not workspace_enabled
      and plan_code = 'ENTERPRISE' and country_code = 'CL'
      and primary_contact_name = 'Ana Cliente'
      and primary_contact_email = 'contacto@example.com'
      and created_by = '92000000-0000-0000-0000-000000000101'
      and onboarded_at is null
   from public.companies where slug = 'cliente-alpha-rpc'),
  'el alta normaliza datos y fuerza onboarding con workspace cerrado');
select ok(
  (select
      (select count(*) from public.company_roles cr where cr.company_id = c.id) = 5
      and (select count(*) from public.company_modules cm where cm.company_id = c.id)
          = (select count(*) from public.module_catalog mc where mc.active)
      and (select count(*) from public.company_onboarding_steps os where os.company_id = c.id)
          = (select count(*) from public.onboarding_step_catalog osc where osc.active)
      and exists (select 1 from public.organization_units ou
                  where ou.company_id = c.id and ou.code = 'ROOT' and ou.unit_type = 'COMPANY')
   from public.companies c where c.slug = 'cliente-alpha-rpc'),
  'el alta provisiona roles, modulos, onboarding y raiz organizacional');
select is(
  (select count(*)::integer
   from public.platform_audit_log pal
   join public.companies c on c.id = pal.company_id
   where c.slug = 'cliente-alpha-rpc' and pal.action = 'company.created'),
  1, 'el alta de empresa queda auditada en la misma transaccion');

insert into public.companies (id, name, legal_name, slug, active, status, created_by)
values ('92000000-0000-0000-0000-000000000002', 'Cliente Beta', 'Cliente Beta SpA',
        'cliente-beta-rpc', true, 'ONBOARDING', null);

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.platform_create_company('Sin permiso', 'sin-permiso-rpc')$$,
  '42501', null, 'VIEWER no puede crear empresas');
reset role;
select is((select count(*)::integer from public.companies where slug = 'sin-permiso-rpc'),
  0, 'el rechazo de alta no deja una empresa parcial');

insert into public.company_memberships (id, user_id, company_id, role, active)
select '92000000-0000-0000-0000-000000000201',
       '92000000-0000-0000-0000-000000000103', c.id, 'ADMIN_RRHH', true
from public.companies c where c.slug = 'cliente-alpha-rpc';

insert into public.company_memberships (id, user_id, company_id, role, active)
values (
  '92000000-0000-0000-0000-000000000202',
  '92000000-0000-0000-0000-000000000104',
  '0a4c0000-0000-0000-0000-000000000001',
  'ADMIN_RRHH',
  true
)
on conflict (user_id, company_id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000201', %L)$$,
    (select cr.id from public.company_roles cr
     join public.companies c on c.id = cr.company_id
     where c.slug = 'cliente-alpha-rpc' and cr.code = 'PRODUCTION_SUPERVISOR')),
  'el manager reemplaza el rol empresarial');
reset role;

select is((select count(*)::integer from public.company_membership_roles
           where membership_id = '92000000-0000-0000-0000-000000000201'),
  1, 'el reemplazo deja exactamente un rol principal');
select is((select cr.code from public.company_membership_roles cmr
           join public.company_roles cr on cr.id = cmr.role_id
           where cmr.membership_id = '92000000-0000-0000-0000-000000000201'),
  'PRODUCTION_SUPERVISOR', 'la membresia queda asociada al rol solicitado');
select is((select role::text from public.company_memberships
           where id = '92000000-0000-0000-0000-000000000201'),
  'SUPERVISOR_PRODUCTION', 'base_role mantiene alineada la compatibilidad legacy');
select is((select role::text from public.profiles
           where id = '92000000-0000-0000-0000-000000000103'),
  null, 'un cliente con workspace cerrado no modifica profiles.role');
select is((select assigned_by from public.company_membership_roles
           where membership_id = '92000000-0000-0000-0000-000000000201'),
  '92000000-0000-0000-0000-000000000101'::uuid,
  'la asignacion conserva la identidad real del actor');
select is((select count(*)::integer from public.platform_audit_log
           where action = 'company.membership_role.assigned'
             and target_id = '92000000-0000-0000-0000-000000000201'),
  1, 'la asignacion queda auditada');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000201', %L)$$,
    (select id from public.company_roles
     where company_id = '92000000-0000-0000-0000-000000000002'
       and code = 'COMPANY_OWNER')),
  '23514', null, 'se rechaza asignar un rol de otra empresa');
reset role;

select is((select cr.code from public.company_membership_roles cmr
           join public.company_roles cr on cr.id = cmr.role_id
           where cmr.membership_id = '92000000-0000-0000-0000-000000000201'),
  'PRODUCTION_SUPERVISOR',
  'el rechazo cross-tenant conserva la asignacion previa atomicamente');
select is((select role::text from public.company_memberships
           where id = '92000000-0000-0000-0000-000000000201'),
  'SUPERVISOR_PRODUCTION',
  'el rechazo cross-tenant tampoco altera el rol legacy');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000202', %L)$$,
    (select id from public.company_roles
     where company_id = '0a4c0000-0000-0000-0000-000000000001'
       and code = 'PRODUCTION_SUPERVISOR')),
  'el manager cambia un rol compatible del workspace habilitado');
reset role;

select is((select role::text from public.profiles
           where id = '92000000-0000-0000-0000-000000000104'),
  'SUPERVISOR_PRODUCTION',
  'el workspace habilitado mantiene profiles.role alineado con el rol asignado');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000202', %L)$$,
    (select id from public.company_roles
     where company_id = '0a4c0000-0000-0000-0000-000000000001'
       and code = 'AUDITOR')),
  '23514', null,
  'un workspace habilitado rechaza roles sin equivalencia legacy');
reset role;

select is((select cr.code from public.company_membership_roles cmr
           join public.company_roles cr on cr.id = cmr.role_id
           where cmr.membership_id = '92000000-0000-0000-0000-000000000202'),
  'PRODUCTION_SUPERVISOR',
  'el rechazo de rol sin equivalencia conserva la asignacion anterior');
select is((select role::text from public.profiles
           where id = '92000000-0000-0000-0000-000000000104'),
  'SUPERVISOR_PRODUCTION',
  'el rechazo de rol sin equivalencia conserva profiles.role');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000102';
select throws_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000201', %L)$$,
    (select cr.id from public.company_roles cr
     join public.companies c on c.id = cr.company_id
     where c.slug = 'cliente-alpha-rpc' and cr.code = 'HR_ADMIN')),
  '42501', null, 'VIEWER no puede cambiar roles empresariales');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_set_company_module_status(%L, 'expenses', 'PILOT')$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  'el manager habilita un modulo en piloto');
reset role;

select ok(
  (select cm.status = 'PILOT' and cm.enabled_at is not null
      and cm.enabled_by = '92000000-0000-0000-0000-000000000101'
   from public.company_modules cm join public.companies c on c.id = cm.company_id
   where c.slug = 'cliente-alpha-rpc' and cm.module_key = 'expenses'),
  'habilitar el modulo fija estado, actor y fecha');
select is(
  (select count(*)::integer from public.platform_audit_log pal
   join public.companies c on c.id = pal.company_id
   where c.slug = 'cliente-alpha-rpc'
     and pal.action = 'company.module.status_changed' and pal.target_id = 'expenses'),
  1, 'el cambio de modulo queda auditado');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000102';
select throws_ok(
  format($$select public.platform_set_company_module_status(%L, 'expenses', 'DISABLED')$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  '42501', null, 'VIEWER no puede cambiar entitlements');
reset role;
select is(
  (select cm.status::text from public.company_modules cm
   join public.companies c on c.id = cm.company_id
   where c.slug = 'cliente-alpha-rpc' and cm.module_key = 'expenses'),
  'PILOT', 'el intento no autorizado no altera el modulo');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_set_company_module_status(%L, 'expenses', 'DISABLED')$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  'el manager puede deshabilitar el modulo');
reset role;
select ok(
  (select cm.status = 'DISABLED' and cm.enabled_at is null and cm.enabled_by is null
   from public.company_modules cm join public.companies c on c.id = cm.company_id
   where c.slug = 'cliente-alpha-rpc' and cm.module_key = 'expenses'),
  'deshabilitar limpia los metadatos de habilitacion');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_set_onboarding_step_completed(%L, 'company_profile', true)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  'el manager completa un paso de onboarding');
reset role;
select ok(
  (select os.status = 'COMPLETE' and os.completed_at is not null
      and os.completed_by = '92000000-0000-0000-0000-000000000101'
   from public.company_onboarding_steps os join public.companies c on c.id = os.company_id
   where c.slug = 'cliente-alpha-rpc' and os.step_key = 'company_profile'),
  'completar el paso fija estado, fecha y actor');
select is(
  (select count(*)::integer from public.platform_audit_log pal
   join public.companies c on c.id = pal.company_id
   where c.slug = 'cliente-alpha-rpc'
     and pal.action = 'company.onboarding_step.status_changed'
     and pal.target_id = 'company_profile'),
  1, 'el cambio de onboarding queda auditado');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000102';
select throws_ok(
  format($$select public.platform_set_onboarding_step_completed(%L, 'company_profile', false)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  '42501', null, 'VIEWER no puede cambiar onboarding');
reset role;
select is(
  (select os.status::text from public.company_onboarding_steps os
   join public.companies c on c.id = os.company_id
   where c.slug = 'cliente-alpha-rpc' and os.step_key = 'company_profile'),
  'COMPLETE', 'el intento no autorizado conserva el paso completo');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_set_onboarding_step_completed(%L, 'company_profile', false)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  'el manager puede devolver un paso a pendiente');
reset role;
select ok(
  (select os.status = 'NOT_STARTED' and os.completed_at is null and os.completed_by is null
   from public.company_onboarding_steps os join public.companies c on c.id = os.company_id
   where c.slug = 'cliente-alpha-rpc' and os.step_key = 'company_profile'),
  'volver a pendiente limpia los metadatos de finalizacion');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_create_company_invitation(
      %L, '  PERSONA@EXAMPLE.COM ', %L)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc'),
    (select cr.id from public.company_roles cr
     join public.companies c on c.id = cr.company_id
     where c.slug = 'cliente-alpha-rpc' and cr.code = 'HR_ADMIN')),
  'el manager crea una invitacion pendiente');
reset role;

select ok(
  (select ci.email = 'persona@example.com' and ci.status = 'PENDING'
      and ci.invited_by = '92000000-0000-0000-0000-000000000101'
      and ci.expires_at > now() and ci.company_id = cr.company_id
   from public.company_invitations ci
   join public.company_roles cr on cr.id = ci.role_id
   where ci.email = 'persona@example.com'),
  'la invitacion normaliza email y conserva rol del mismo tenant');
select ok(
  (select count(*) = 1 and bool_and(not (pal.metadata ? 'email'))
   from public.platform_audit_log pal join public.companies c on c.id = pal.company_id
   where c.slug = 'cliente-alpha-rpc' and pal.action = 'company.invitation.created'),
  'la invitacion se audita sin duplicar el email en metadata');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_create_company_invitation(%L, 'otra@example.com', %L)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc'),
    (select id from public.company_roles
     where company_id = '92000000-0000-0000-0000-000000000002' and code = 'HR_ADMIN')),
  '23514', null, 'se rechaza una invitacion con rol de otra empresa');
reset role;
select is((select count(*)::integer from public.company_invitations
           where email = 'otra@example.com'),
  0, 'el rechazo cross-tenant no deja una invitacion parcial');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_create_organization_unit(
      %L, %L, '  finanzas_1 ', '  Finanzas  ', 'DEPARTMENT', 20)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc'),
    (select ou.id from public.organization_units ou
     join public.companies c on c.id = ou.company_id
     where c.slug = 'cliente-alpha-rpc' and ou.code = 'ROOT')),
  'el manager crea una unidad organizacional');
reset role;

select ok(
  (select child.code = 'FINANZAS_1' and child.name = 'Finanzas'
      and child.unit_type = 'DEPARTMENT'
      and child.created_by = '92000000-0000-0000-0000-000000000101'
      and child.company_id = parent.company_id
   from public.organization_units child
   join public.organization_units parent on parent.id = child.parent_id
   where child.code = 'FINANZAS_1'),
  'la unidad queda normalizada y ligada al padre del mismo tenant');
select is(
  (select count(*)::integer from public.platform_audit_log pal
   where pal.action = 'company.organization_unit.created'
     and pal.metadata ->> 'code' = 'FINANZAS_1'),
  1, 'la nueva unidad queda auditada');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_create_organization_unit(
      %L, %L, 'CROSS_UNIT', 'Cruce', 'TEAM', 0)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc'),
    (select id from public.organization_units
     where company_id = '92000000-0000-0000-0000-000000000002' and code = 'ROOT')),
  '23514', null, 'se rechaza una unidad con padre de otra empresa');
reset role;
select is((select count(*)::integer from public.organization_units where code = 'CROSS_UNIT'),
  0, 'el rechazo cross-tenant no deja una unidad parcial');

update public.company_memberships
set active = false
where id = '92000000-0000-0000-0000-000000000201';
set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_assign_company_role(
      '92000000-0000-0000-0000-000000000201', %L)$$,
    (select cr.id from public.company_roles cr
     join public.companies c on c.id = cr.company_id
     where c.slug = 'cliente-alpha-rpc' and cr.code = 'HR_ADMIN')),
  '23514', 'No se puede asignar un rol a una membresia inactiva.',
  'una membresia inactiva no puede recuperar privilegios mediante asignacion de rol');
reset role;
select is((select cr.code from public.company_membership_roles cmr
           join public.company_roles cr on cr.id = cmr.role_id
           where cmr.membership_id = '92000000-0000-0000-0000-000000000201'),
  'PRODUCTION_SUPERVISOR', 'el rechazo de membresia inactiva conserva el rol previo');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  $$select public.platform_set_company_module_status(
      '0a4c0000-0000-0000-0000-000000000001', 'payroll', 'DISABLED')$$,
  '23514',
  'Los módulos de un workspace operativo no se pueden cambiar hasta completar los gates backend y RLS de MT-3D.',
  'un entitlement operativo no cambia antes de que rutas y RLS consuman el gate');
reset role;
select is((select status::text from public.company_modules
           where company_id = '0a4c0000-0000-0000-0000-000000000001'
             and module_key = 'payroll'),
  'ENABLED', 'el rechazo conserva el modulo operativo habilitado');

set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select throws_ok(
  format($$select public.platform_set_onboarding_step_completed(%L, 'go_live', true)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc')),
  '23514', 'No se puede completar go_live mientras el workspace permanezca bloqueado.',
  'go_live no puede completarse con el workspace fail-closed');
reset role;
select is((select os.status::text from public.company_onboarding_steps os
           join public.companies c on c.id = os.company_id
           where c.slug = 'cliente-alpha-rpc' and os.step_key = 'go_live'),
  'NOT_STARTED', 'el rechazo conserva go_live pendiente');

update public.company_invitations
set expires_at = pg_catalog.now() - interval '1 minute'
where email = 'persona@example.com' and status = 'PENDING';
set local role authenticated;
set local request.jwt.claim.sub = '92000000-0000-0000-0000-000000000101';
select lives_ok(
  format($$select public.platform_create_company_invitation(%L, 'persona@example.com', %L)$$,
    (select id from public.companies where slug = 'cliente-alpha-rpc'),
    (select cr.id from public.company_roles cr
     join public.companies c on c.id = cr.company_id
     where c.slug = 'cliente-alpha-rpc' and cr.code = 'HR_ADMIN')),
  'una invitacion vencida se expira y permite reintentar el mismo correo');
reset role;
select ok(
  (select count(*) filter (where status = 'EXPIRED') = 1
      and count(*) filter (where status = 'PENDING') = 1
   from public.company_invitations where email = 'persona@example.com'),
  'el reintento deja historial vencido y exactamente una invitacion pendiente');

set local role anon;
select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
    '92000000-0000-0000-0000-000000000002', 'company_profile', true)$$,
  '42501', null, 'anon no puede invocar los RPC del control plane');
reset role;

select * from finish();
rollback;
