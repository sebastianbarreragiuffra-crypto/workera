-- Corrige DOS agujeros de autorización, previos y ajenos a la rama de MFA,
-- de la misma clase de error: una función de identidad/rol que devuelve
-- NULL en vez de false, combinada con `if not funcion() then raise`, que en
-- PL/pgSQL trata NULL igual que false y nunca lanza la excepción.
--
-- El primero (`can_manage_platform()`) se encontró al verificar el orden de
-- las dos guardas en la etapa F de docs/MFA_DESIGN.md (sección 11). El
-- segundo (`is_super_admin()` y las otras tres funciones de identidad exacta
-- de rol) se encontró al buscar el mismo patrón en el resto de la base antes
-- de dar por cerrado el primero.
--
-- El problema: current_platform_role() devuelve NULL -- no ningún valor del
-- enum -- para una cuenta sin membresía de plataforma activa. La expresión
-- `current_platform_role() in ('OWNER', 'ADMIN')` con el lado izquierdo NULL
-- evalúa a NULL, nunca a false.
--
-- Eso importa porque el patrón de guarda usado en NUEVE RPC es
-- `if v_actor_id is null or not public.can_manage_platform() then raise
-- exception ... end if;`. Con can_manage_platform() = NULL, la expresión
-- completa es `false or not null` = `false or null` = NULL, y en PL/pgSQL un
-- IF sobre NULL se trata igual que IF false: la rama que lanza la excepción
-- NUNCA se ejecuta. La función sigue de largo como si el chequeo hubiera
-- pasado.
--
-- Verificado en un harness local: una cuenta SUPERVISOR_PRODUCTION sin
-- ninguna fila en platform_memberships pudo ejecutar
-- platform_create_company() y dejar su fila en platform_audit_log.
--
-- Las nueve funciones con este patrón (localizadas por texto, no por lista
-- fija -- ver el pgTAP de esta migración): platform_create_company,
-- platform_assign_company_role, platform_set_company_module_status (las dos
-- versiones -- la original y la redefinida por EX-2 --, y la vigente después
-- de la etapa F de MFA), platform_set_onboarding_step_completed,
-- platform_create_company_invitation, platform_create_organization_unit,
-- platform_mark_company_invitation_delivery.
--
-- La corrección va en la ÚNICA función que decide la pregunta, no en cada
-- llamador: current_platform_role() legítimamente devuelve NULL (se usa para
-- mostrar el rol, no solo para autorizar), así que el fix no toca esa función.
-- can_manage_platform() es exclusivamente una guarda booleana y nunca debe
-- devolver otra cosa que true/false.
--
-- Las policies RLS que ya usaban can_manage_platform() en `using`/`with
-- check` NO estaban afectadas: en un filtro SQL, NULL deniega la fila igual
-- que false. El agujero era específico del `if ... then raise` de PL/pgSQL.
create or replace function public.can_manage_platform()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_platform_role() in ('OWNER', 'ADMIN'), false);
$$;

-- ---------------------------------------------------------------------------
-- Segundo hallazgo, misma clase de error: `current_user_role() = 'ROL'`
-- devuelve NULL -- no false -- para cualquier cuenta con `profiles.role IS
-- NULL`, que es el estado por defecto de TODA cuenta recién registrada
-- (`handle_new_auth_user`, Fase 3: "role = NULL (sin acceso) hasta que un
-- ADMIN_RRHH asigne un rol explícito"). Las cuatro funciones de identidad
-- exacta de rol tenían el mismo patrón que `can_manage_platform()`.
--
-- Impacto verificado: `cleanup_demo_data()` -- otorgada a `authenticated`,
-- guardada solo por `if not public.is_super_admin() then raise` -- se
-- ejecuta hasta el final para CUALQUIER cuenta recién creada sin rol, sin
-- necesitar ningún privilegio. Es el caso más severo porque no requiere una
-- cuenta comprometida con privilegios: alcanza con haberse registrado.
--
-- `is_privileged_admin()` se corrige de forma transitiva: es
-- `is_super_admin() or is_admin_rrhh()`, y el OR de dos valores que ya nunca
-- son NULL nunca es NULL.
--
-- `is_corporate_user()` NO se toca: usa `current_user_role() is not null`,
-- que nunca es NULL en sí mismo (el operador IS siempre devuelve true/false).
create or replace function public.is_admin_rrhh()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'ADMIN_RRHH', false);
$$;

create or replace function public.is_supervisor_production()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'SUPERVISOR_PRODUCTION', false);
$$;

create or replace function public.is_supervisor_installation()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'SUPERVISOR_INSTALLATION', false);
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'SUPER_ADMIN', false);
$$;
