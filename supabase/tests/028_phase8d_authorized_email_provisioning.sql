-- pgTAP Fase 8D: provisioning confiable email->rol, APP_ADMIN (=SUPER_ADMIN
-- técnico) para s.barrera@arcotex.cl, usuarios desconocidos sin privilegios,
-- metadata de OAuth nunca puede sobrescribir el rol, y prevención de
-- auto-promoción se mantiene intacta para cuentas recién provisionadas.
create extension if not exists pgtap;

begin;
select plan(24);

-- ---------------------------------------------------------------------------
-- 1) authorized_email_roles contiene EXACTAMENTE el mapeo de los 7 emails
--    aprobados -- fuente de verdad única, nada de más ni de menos.
select is(
  (select count(*)::int from public.authorized_email_roles),
  7,
  'authorized_email_roles tiene exactamente 7 filas (el mapeo aprobado, ni una más)'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'i.gonzalez@arcotex.cl'),
  'SUPERVISOR_PRODUCTION',
  'i.gonzalez@arcotex.cl -> SUPERVISOR_PRODUCTION'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'ingenieria@arcotex.cl'),
  'SUPERVISOR_INSTALLATION',
  'ingenieria@arcotex.cl -> SUPERVISOR_INSTALLATION'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'asistenteg@arcotex.cl'),
  'ADMIN_RRHH',
  'asistenteg@arcotex.cl -> ADMIN_RRHH'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'a.caceres@arcotex.cl'),
  'ADMIN_RRHH',
  'a.caceres@arcotex.cl -> ADMIN_RRHH'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'a.valencia@arcotex.cl'),
  'ADMIN_RRHH',
  'a.valencia@arcotex.cl -> ADMIN_RRHH'
);
select is(
  (select role::text from public.authorized_email_roles where email = 'c.barrera@arcotex.cl'),
  'ADMIN_RRHH',
  'c.barrera@arcotex.cl -> ADMIN_RRHH'
);
select is(
  (select role::text from public.authorized_email_roles where email = 's.barrera@arcotex.cl'),
  'SUPER_ADMIN',
  's.barrera@arcotex.cl -> SUPER_ADMIN (APP_ADMIN conceptual, mismo rol técnico)'
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
--    correcto de inmediato -- sin intervención manual.
insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000001', 's.barrera@arcotex.cl');
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000001'),
  'SUPER_ADMIN',
  'trigger: s.barrera@arcotex.cl recibe SUPER_ADMIN (máxima autoridad) al crear su cuenta'
);

insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000002', 'a.caceres@arcotex.cl');
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000002'),
  'ADMIN_RRHH',
  'trigger: a.caceres@arcotex.cl recibe ADMIN_RRHH al crear su cuenta'
);

-- Normalización de mayúsculas/minúsculas: un email de Google con distinta
-- capitalización sigue matcheando el mapeo aprobado.
insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-000000000003', 'I.Gonzalez@Arcotex.CL');
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
  ('80000000-0000-0000-0000-000000000006', 'a.valencia@arcotex.cl', '{"role": "SUPER_ADMIN"}'::jsonb);
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000006'),
  'ADMIN_RRHH',
  'metadata de OAuth con role="SUPER_ADMIN" inyectado NO sobrescribe el rol real (a.valencia sigue ADMIN_RRHH, no SUPER_ADMIN)'
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
--    Fase 8D -- ADMIN_RRHH (a.caceres, recién creada arriba) no logra
--    escalar a SUPER_ADMIN ni tocar la cuenta SUPER_ADMIN existente.
set local role authenticated;
set local request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002'; -- a.caceres, ADMIN_RRHH
select throws_ok(
  $$ update public.profiles set role = 'SUPER_ADMIN'
       where id = '80000000-0000-0000-0000-000000000002' $$,
  '42501',
  null,
  'ADMIN_RRHH provisionado por Fase 8D no logra auto-promoverse a SUPER_ADMIN'
);
reset role;
select is(
  (select role::text from public.profiles where id = '80000000-0000-0000-0000-000000000002'),
  'ADMIN_RRHH',
  'a.caceres permanece ADMIN_RRHH tras el intento de auto-promoción rechazado'
);

set local role authenticated;
set local request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002'; -- a.caceres, ADMIN_RRHH
select lives_ok(
  $$ update public.profiles set active = false
       where id = '80000000-0000-0000-0000-000000000001' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select active from public.profiles where id = '80000000-0000-0000-0000-000000000001'),
  true,
  'ADMIN_RRHH (Fase 8D) no logra desactivar la cuenta SUPER_ADMIN (s.barrera) recién provisionada'
);

select * from finish();
rollback;
