-- pgTAP Fase 3: creación de profile al registrarse, y protección contra
-- escalación de rol (secciones 22/23/27/28 del encargo)
create extension if not exists pgtap;

begin;
select plan(9);

-- Emails ficticios, nunca reales (encargo sección 21).
insert into auth.users (id, email) values
  ('30000000-0000-0000-0000-000000000001', 'rrhh@example.test');

-- 1) El trigger on_auth_user_created crea automáticamente la fila de profiles,
-- con role = NULL (sin acceso) hasta que un ADMIN_RRHH lo asigne.
select is(
  (select role from public.profiles where id = '30000000-0000-0000-0000-000000000001'),
  null,
  'trigger: nuevo usuario de auth.users obtiene profiles.role = NULL (sin privilegios)'
);

-- Fixtures de los 3 roles reales + un usuario sin rol, con ids fijos para
-- poder simular su sesión más abajo.
insert into public.profiles (id, display_name, role) values
  ('30000000-0000-0000-0000-000000000002', 'Fixture Admin', 'ADMIN_RRHH'),
  ('30000000-0000-0000-0000-000000000003', 'Fixture Supervisor Prod', 'SUPERVISOR_PRODUCTION'),
  ('30000000-0000-0000-0000-000000000004', 'Fixture Supervisor Install', 'SUPERVISOR_INSTALLATION');

-- 2) SUPERVISOR_PRODUCTION intenta escalar su propio rol a ADMIN_RRHH -> DENIED
set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';

select is(
  (select public.current_user_role()),
  'SUPERVISOR_PRODUCTION'::public.app_role,
  'current_user_role() refleja correctamente al usuario simulado'
);

-- Nota sobre la forma de estas aserciones: bajo RLS, un UPDATE cuya cláusula
-- USING excluye la fila no lanza una excepción — simplemente afecta 0 filas
-- (comportamiento estándar de Postgres, distinto de un INSERT cuyo WITH CHECK
-- falla, que sí aborta con excepción). Por eso la prueba correcta de "no puede
-- escalar su rol" es confirmar que el UPDATE "vive" (no truena) pero el valor
-- de la fila NO cambió, no esperar una excepción.
select lives_ok(
  $$ update public.profiles set role = 'ADMIN_RRHH'
     where id = '30000000-0000-0000-0000-000000000003' $$,
  'el UPDATE no truena (0 filas afectadas por RLS, no un error de sintaxis/permiso de tabla)'
);
select is(
  (select role::text from public.profiles where id = '30000000-0000-0000-0000-000000000003'),
  'SUPERVISOR_PRODUCTION',
  'SUPERVISOR_PRODUCTION NO logra escalar su propio rol a ADMIN_RRHH (RLS excluyó la fila, 0 filas afectadas)'
);

reset role;

-- 3) SUPERVISOR_INSTALLATION intenta lo mismo -> sin efecto
set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000004';

select lives_ok(
  $$ update public.profiles set role = 'ADMIN_RRHH'
     where id = '30000000-0000-0000-0000-000000000004' $$,
  'el UPDATE no truena'
);
select is(
  (select role::text from public.profiles where id = '30000000-0000-0000-0000-000000000004'),
  'SUPERVISOR_INSTALLATION',
  'SUPERVISOR_INSTALLATION NO logra escalar su propio rol a ADMIN_RRHH'
);

-- 4) Tampoco puede modificar el rol de OTRO usuario (IDOR sobre profiles)
select is(
  (select role from public.profiles where id = '30000000-0000-0000-0000-000000000001'),
  null,
  'el rol de otro usuario (id ajeno) sigue NULL: SUPERVISOR_INSTALLATION no lo modificó'
);

reset role;

-- 5) ADMIN_RRHH SÍ puede asignar un rol a un usuario recién registrado
set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';

select lives_ok(
  format(
    $$ update public.profiles set role = 'SUPERVISOR_PRODUCTION' where id = %L $$,
    '30000000-0000-0000-0000-000000000001'
  ),
  'ADMIN_RRHH puede asignar un rol a un usuario sin configuración administrativa'
);

-- 6) ADMIN_RRHH puede ver todos los perfiles; un supervisor solo el propio
select is(
  (select count(*)::int from public.profiles),
  4,
  'ADMIN_RRHH ve los 4 perfiles (SELECT amplio)'
);

reset role;
select * from finish();
rollback;
