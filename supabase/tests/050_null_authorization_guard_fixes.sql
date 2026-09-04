-- pgTAP: dos funciones de autorización dejaban de rechazar por devolver NULL
-- en vez de false, y el `if not funcion() then raise` que las envuelve trata
-- NULL igual que false en PL/pgSQL -- la excepción nunca se lanzaba.
--
-- 1. `can_manage_platform()`: una cuenta sin membresía de plataforma podía
--    ejecutar RPC de gestión de plataforma.
-- 2. `is_super_admin()` (y las otras tres funciones de identidad exacta de
--    rol): CUALQUIER cuenta recién registrada, sin rol asignado todavía --el
--    estado por defecto de toda cuenta nueva--, podía ejecutar
--    `cleanup_demo_data()`.
create extension if not exists pgtap;

begin;
select plan(9);

set local request.jwt.claim.aal = 'aal2';

-- ---------------------------------------------------------------------------
-- 1. La función en sí: nunca NULL.

select isnt(public.can_manage_platform(), null, 'can_manage_platform() nunca devuelve NULL sin sesión');

insert into public.profiles (id, display_name, role, active) values
  ('98000000-0000-0000-0000-000000000001', 'Supervisor Sin Plataforma', 'SUPERVISOR_PRODUCTION', true);

set local role authenticated;
set local request.jwt.claim.sub = '98000000-0000-0000-0000-000000000001';
select isnt(
  public.can_manage_platform(), null,
  'can_manage_platform() nunca devuelve NULL para una cuenta sin membresía de plataforma'
);
select ok(not public.can_manage_platform(), 'y ese resultado corregido es false, no true');

-- ---------------------------------------------------------------------------
-- 2. El hallazgo real, extremo a extremo: esta era exactamente la cuenta y la
-- llamada que antes de esta migración creaba la empresa sin autorización.

select throws_ok(
  $$select public.platform_create_company('Empresa Sin Autorizar', 'empresa-sin-autorizar')$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una cuenta sin membresía de plataforma ya no puede crear una empresa'
);
select is(
  (select count(*)::integer from public.companies where slug = 'empresa-sin-autorizar'),
  0,
  'y no queda ninguna fila de esa empresa que nunca debió crearse'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. Cobertura completa: todas las funciones que comparten el patrón de
-- guarda se recorren por su código fuente, no por una lista fija -- es la
-- misma superficie que tenía el problema, y una función nueva que copie el
-- patrón a futuro cae sola en esta prueba en vez de quedar sin cubrir.

-- pg_proc solo conserva la definición VIGENTE de cada función: las dos
-- redefiniciones de platform_set_company_module_status (la original y la que
-- EX-2 amplió para el módulo `expenses`) cuentan una sola vez acá, aunque el
-- patrón roto haya existido en ambas a lo largo del historial de migraciones.
select is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~ 'v_actor_id is null or not public\.can_manage_platform\(\)'
  ),
  7,
  'siete funciones vigentes comparten hoy el patrón de guarda corregido -- si este número cambia, revisar antes de actualizarlo'
);

-- ---------------------------------------------------------------------------
-- 4. Segundo hallazgo: las cuatro funciones de identidad exacta de rol nunca
-- devuelven NULL, ni para una cuenta sin rol.

insert into public.profiles (id, display_name, role, active) values
  ('98100000-0000-0000-0000-000000000001', 'Cuenta Recien Registrada Sin Rol', null, true);

set local role authenticated;
set local request.jwt.claim.sub = '98100000-0000-0000-0000-000000000001';

select is(
  (
    select array_agg(v order by v)
    from unnest(array[
      public.is_super_admin(),
      public.is_admin_rrhh(),
      public.is_supervisor_production(),
      public.is_supervisor_installation(),
      public.is_privileged_admin()
    ]) as v
    where v is null
  ),
  null::boolean[],
  'ninguna de las cinco funciones de rol devuelve NULL para una cuenta recién registrada sin rol'
);

-- ---------------------------------------------------------------------------
-- 5. El hallazgo real, extremo a extremo: esta era exactamente la cuenta que
-- antes de esta migración podía ejecutar cleanup_demo_data() sin ningún
-- privilegio -- ni siquiera un rol asignado.

select throws_ok(
  $$select * from public.cleanup_demo_data()$$,
  'P0001', 'Solo SUPER_ADMIN puede ejecutar la limpieza de datos de demostración.',
  'una cuenta recién registrada sin rol ya no puede ejecutar la limpieza de datos de demo'
);
reset role;

select * from finish();
rollback;
