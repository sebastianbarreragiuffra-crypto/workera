-- pgTAP Fase 8D: provisioning confiable email->rol, APP_ADMIN (=SUPER_ADMIN
-- técnico) para el OWNER bootstrap, usuarios desconocidos sin privilegios,
-- metadata de OAuth nunca puede sobrescribir el rol, y prevención de
-- auto-promoción se mantiene intacta para cuentas recién provisionadas.
create extension if not exists pgtap;

begin;
select plan(19);

-- ---------------------------------------------------------------------------
-- 1) authorized_email_roles conserva exclusivamente el bootstrap de emergencia
--    del OWNER inicial. Las altas operacionales pasan por invitaciones tenant.
select is(
  (select count(*)::int from public.authorized_email_roles),
  1,
  'authorized_email_roles conserva exactamente el bootstrap OWNER inicial'
);
select results_eq(
  $$select role::text, platform_role::text from public.authorized_email_roles$$,
  $$values ('SUPER_ADMIN'::text, 'OWNER'::text)$$,
  'el único bootstrap conserva los roles legacy y de plataforma esperados'
);

-- ---------------------------------------------------------------------------
-- 2) Deny-by-default real sobre authorized_email_roles: ni siquiera
--    `authenticated` puede leerla/escribirla desde la aplicación -- solo el
--    trigger SECURITY DEFINER la consulta.
select is(has_table_privilege('authenticated', 'public.authorized_email_roles', 'SELECT'), false, 'authenticated: sin SELECT sobre authorized_email_roles');
select is(has_table_privilege('authenticated', 'public.authorized_email_roles', 'INSERT'), false, 'authenticated: sin INSERT sobre authorized_email_roles');
select is(has_table_privilege('authenticated', 'public.authorized_email_roles', 'UPDATE'), false, 'authenticated: sin UPDATE sobre authorized_email_roles');
select is(has_table_privilege('anon', 'public.authorized_email_roles', 'SELECT'), false, 'anon: sin SELECT sobre authorized_email_roles');

-- ---------------------------------------------------------------------------
-- 3) Provisioning real vía el trigger: cada email aprobado, al aparecer en
--    auth.users (mismo camino para email+password y OAuth), obtiene el rol
--    correcto de inmediato -- sin intervención manual. Los emails de las
--    cuentas creadas son fixtures exclusivos de esta prueba: reutilizar los
--    correos de bootstrap reales haría colisión cuando una cuenta local existe.
insert into public.authorized_email_roles (email, role, platform_role) values
  ('fixture-super-admin-028@example.test', 'SUPER_ADMIN', 'OWNER'),
  ('fixture-admin-028@example.test', 'ADMIN_RRHH', null),
  ('fixture-production-028@example.test', 'SUPERVISOR_PRODUCTION', null),
  ('fixture-admin-metadata-028@example.test', 'ADMIN_RRHH', null);

insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000001', 'fixture-super-admin-028@example.test');
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000001'),
  'SUPER_ADMIN',
  'trigger: email fixture aprobado recibe SUPER_ADMIN al crear su cuenta'
);
select is(
  (select role::text from public.platform_memberships where user_id = '80000000-0000-0000-0000-000000000001'),
  'OWNER',
  'trigger: webadmin aprobado recibe OWNER del control plane al crear su cuenta'
);

insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000002', 'fixture-admin-028@example.test');
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000002'),
  'ADMIN_RRHH',
  'trigger: email fixture aprobado recibe ADMIN_RRHH al crear su cuenta'
);

-- Normalización de mayúsculas/minúsculas: un email de Google con distinta
-- capitalización sigue matcheando el mapeo aprobado.
insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000003', 'Fixture-Production-028@Example.Test');
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000003'),
  'SUPERVISOR_PRODUCTION',
  'trigger: matcheo de email es insensible a mayúsculas/minúsculas'
);

-- 4) Usuario desconocido (no aprobado): sigue recibiendo role=NULL, EXACTO
--    mismo comportamiento que antes de Fase 8D -- nadie se auto-provisiona.
insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000004', 'desconocido@arcotex.cl');
select is(
  (select role from public.profiles where id = '80000000-0000-0000-0000-000000000004'),
  null,
  'trigger: email NO aprobado recibe role=NULL (sin acceso), nunca se auto-provisiona'
);

-- 5) Metadata de OAuth NUNCA puede sobrescribir el rol -- ni para un email
--    aprobado (el rol viene de authorized_email_roles, no de metadata) ni
--    para uno no aprobado (intentar inyectar un role vía raw_user_meta_data
--    no tiene ningún efecto, el trigger nunca lee esa clave).
insert into auth.users (id, email, raw_user_meta_data) values
  ('80000000-0000-0000-0000-000000000005', 'atacante@arcotex.cl', '{"role": "SUPER_ADMIN"}'::jsonb);
select is(
  (select role from public.profiles where id = '80000000-0000-0000-0000-000000000005'),
  null,
  'metadata de OAuth con role="SUPER_ADMIN" inyectado NO otorga ningún rol (nunca se lee esa clave)'
);

insert into auth.users (id, email, raw_user_meta_data) values
  ('80000000-0000-0000-0000-000000000006', 'fixture-admin-metadata-028@example.test', '{"role": "SUPER_ADMIN"}'::jsonb);
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000006'),
  'ADMIN_RRHH',
  'metadata de OAuth con role="SUPER_ADMIN" inyectado NO sobrescribe el rol real (fixture sigue ADMIN_RRHH)'
);

-- ---------------------------------------------------------------------------
-- 6) Provisioning retroactivo (idempotente): una cuenta que YA existía en
--    auth.users antes de que su email se agregara a la lista aprobada
--    también queda provisionada correctamente al reaplicar la corrección.
insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000007', 'preexistente@arcotex.cl');
-- Esta cuenta preexistente ahora se "aprueba" (simula agregar su email a la
-- lista en una migración futura) y se re-corre el mismo UPDATE retroactivo
-- que ya vive en la migración de Fase 8D -- debe converger igual.
insert into public.authorized_email_roles (email, role) values ('preexistente@arcotex.cl', 'SUPERVISOR_INSTALLATION');
update public.profiles p
set role = a.role
from auth.users u
join public.authorized_email_roles a on a.email = lower(u.email)
where p.id = u.id
  and p.role is distinct from a.role;
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000007'),
  'SUPERVISOR_INSTALLATION',
  'provisioning retroactivo: cuenta preexistente queda con el rol correcto tras aprobarse su email'
);
-- Reaplicar la misma corrección de nuevo no cambia nada (idempotente).
update public.profiles p
set role = a.role
from auth.users u
join public.authorized_email_roles a on a.email = lower(u.email)
where p.id = u.id
  and p.role is distinct from a.role;
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000007'),
  'SUPERVISOR_INSTALLATION',
  'provisioning retroactivo: reaplicar la corrección es idempotente (mismo resultado)'
);

-- ---------------------------------------------------------------------------
-- 7) Auto-promoción sigue bloqueada para cuentas recién provisionadas por
--    Fase 8D -- ADMIN_RRHH fixture recién creada arriba no logra
--    escalar a SUPER_ADMIN ni tocar la cuenta SUPER_ADMIN existente.
set local role authenticated;
set local request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002'; -- fixture ADMIN_RRHH
select lives_ok(
  $$ update public.profiles set role = 'SUPER_ADMIN'
       where id = '80000000-0000-0000-0000-000000000002' $$,
  'ADMIN_RRHH queda fuera por RLS sin una excepción engañosa'
);
reset role;
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000002'),
  'ADMIN_RRHH',
  'el fixture permanece ADMIN_RRHH tras el intento de auto-promoción rechazado'
);

set local role authenticated;
set local request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002'; -- fixture ADMIN_RRHH
select lives_ok(
  $$ update public.profiles set active = false
       where id = '80000000-0000-0000-0000-000000000001' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select active from public.profiles where id = '80000000-0000-0000-0000-000000000001'),
  true,
  'ADMIN_RRHH (Fase 8D) no logra desactivar la cuenta SUPER_ADMIN fixture recién provisionada'
);

select * from finish();
rollback;
