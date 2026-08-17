-- Fase 3 — 14: roles reales, vínculo con Supabase Auth, helpers de autorización
--
-- Extiende (no reemplaza) profiles (Fase 2A). No se modifica ninguna migración
-- de Fase 2A/2B.

-- ---------------------------------------------------------------------------
-- app_role — únicamente los 3 accesos corporativos confirmados. Enum de
-- Postgres, no catálogo: es un estado técnico pequeño, estable y de alto
-- impacto de seguridad — agregar un cuarto rol es una decisión de negocio
-- excepcional que debe pasar por una migración explícita y revisable, no una
-- fila insertable por la aplicación (a diferencia de employee_groups, que sí
-- es catálogo porque crecer no tiene impacto de seguridad). "No aceptar texto
-- arbitrario de rol" queda satisfecho: el dominio de valores es cerrado.
create type public.app_role as enum (
  'ADMIN_RRHH',
  'SUPERVISOR_PRODUCTION',
  'SUPERVISOR_INSTALLATION'
);

comment on type public.app_role is
  'Los 3 únicos accesos corporativos de la aplicación. Cualquier grupo nuevo '
  'requiere una migración explícita, nunca una fila de catálogo.';

-- profiles.role (Fase 2A) usaba text + CHECK('admin','supervisor') — un
-- vocabulario genérico previo a que los roles reales estuvieran definidos.
-- Se reemplaza por el enum real. NULLABLE a propósito (ver sección de abajo,
-- "creación automática de profile"): un usuario recién autenticado sin
-- configuración administrativa no tiene rol, y por lo tanto no tiene ningún
-- acceso — el NULL es exactamente "sin privilegios", nunca un rol por defecto.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles alter column role drop not null;
alter table public.profiles alter column role type public.app_role using (
  case role
    when 'admin' then 'ADMIN_RRHH'::public.app_role
    else null
  end
);

comment on column public.profiles.role is
  'NULL = usuario autenticado sin rol asignado todavía (sin acceso a ningún '
  'dato de negocio). Solo ADMIN_RRHH puede asignar un valor no nulo (RLS, '
  'ver migración de políticas de profiles más abajo).';

-- ---------------------------------------------------------------------------
-- Vínculo con Supabase Auth (sección 27/28 del encargo)
--
-- Se evaluó una FK dura `profiles.id references auth.users(id)` y se
-- descartó: rompería los fixtures de Fase 2A/2B que crean profiles de prueba
-- sin una fila real en auth.users (no se reescriben esas migraciones/tests
-- salvo lo estrictamente necesario, y esos fixtures nunca inician sesión, solo
-- sirven como referencia FK para datos de dominio). En su lugar:
--   - profiles.id conserva su default gen_random_uuid() (Fase 2A intacto).
--   - Para una cuenta real, un trigger en auth.users crea la fila de profiles
--     usando EXPLÍCITAMENTE el mismo id (`new.id`), logrando
--     `profiles.id = auth.users.id` para todo usuario real, sin forzarlo con
--     una constraint que rompería los fixtures de prueba.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email),
    null  -- nunca un rol por defecto (sección 28: "NO asignar automáticamente
          -- un rol privilegiado")
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public;

comment on function public.handle_new_auth_user() is
  'Crea la fila de profiles al registrarse un usuario en Supabase Auth, con '
  'role = NULL (sin acceso) hasta que un ADMIN_RRHH asigne un rol explícito. '
  'SECURITY DEFINER: necesario para escribir en public.profiles desde el '
  'contexto de auth.users; search_path fijo vacío + nombres completamente '
  'calificados para evitar hijacking.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Helpers de autorización
--
-- SECURITY DEFINER es necesario aquí específicamente para evitar el problema
-- conocido de recursión de RLS: una policy de SELECT sobre `profiles` que
-- llamara a una función SECURITY INVOKER que a su vez hace SELECT sobre
-- `profiles` volvería a evaluar la misma policy en bucle. SECURITY DEFINER
-- rompe la recursión (la sub-consulta interna corre con los privilegios del
-- dueño de la función, no sujeta a la policy que se está evaluando). Mismo
-- patrón recomendado por la documentación de Supabase para este caso exacto.
--
-- Mitigación de riesgo de SECURITY DEFINER (sección 29 del encargo):
--   - search_path fijo a '' (vacío) + todos los nombres completamente
--     calificados (public.profiles, no profiles) — evita search_path hijacking.
--   - Cada función hace exactamente una lectura de una sola fila, sin DML.
--   - EXECUTE revocado de PUBLIC/anon; otorgado explícitamente solo a
--     `authenticated` (anon nunca necesita ni debe poder evaluar rol).
create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin_rrhh()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() = 'ADMIN_RRHH';
$$;

create or replace function public.is_supervisor_production()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() = 'SUPERVISOR_PRODUCTION';
$$;

create or replace function public.is_supervisor_installation()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() = 'SUPERVISOR_INSTALLATION';
$$;

-- Cualquiera de los 3 accesos corporativos (rol no nulo). Usado como frontera
-- mínima de "usuario autenticado y habilitado" para tablas de solo-lectura
-- amplia (ej. employees).
create or replace function public.is_corporate_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() is not null;
$$;

-- can_manage_employee: frontera de AUTORIZACIÓN DE ESCRITURA por contexto
-- operacional (sección 5/6 del encargo — "ver todos != modificar todos").
-- Usa el employee_group_id ACTUAL del trabajador (Fase 2B, employees.employee_group_id),
-- no el historial de employee_group_assignments: para decisiones operacionales
-- del día a día (aprobar horas extra de hoy, corregir una marcación de hoy) lo
-- correcto es el grupo vigente, no una foto histórica — si un trabajador
-- cambia de grupo, su nuevo supervisor debe poder operar sobre él de
-- inmediato y el anterior debe perder esa capacidad de inmediato. Documentado
-- como decisión deliberada, no como omisión.
--
-- supervisor_assignments (Fase 2A) NO se usa aquí: el requisito confirmado de
-- Fase 3 es autorización por GRUPO ("Supervisor Producción puede operar sobre
-- trabajadores de Producción"), no por asignación 1:1 supervisor-trabajador.
-- supervisor_assignments se mantiene en el esquema, sigue siendo consultable
-- (SELECT) y queda disponible para un modelo de autorización más fino en una
-- fase futura si el negocio lo requiere explícitamente.
create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin_rrhh()
    or exists (
      select 1
      from public.employees e
      join public.employee_groups eg on eg.id = e.employee_group_id
      where e.id = p_employee_id
        and (
          (eg.code = 'PRODUCTION' and public.is_supervisor_production())
          or (eg.code = 'INSTALLATION' and public.is_supervisor_installation())
        )
    );
$$;

comment on function public.can_manage_employee(uuid) is
  'true si el usuario actual puede escribir (decisiones/correcciones/novedades) '
  'sobre este trabajador: ADMIN_RRHH siempre, o el supervisor cuyo grupo '
  'coincide con el employee_group ACTUAL del trabajador. NO usa '
  'supervisor_assignments (autorización por grupo, no por asignación '
  'individual) — decisión documentada en docs/SECURITY_PHASE3.md.';

grant execute on function
  public.current_user_role(),
  public.is_admin_rrhh(),
  public.is_supervisor_production(),
  public.is_supervisor_installation(),
  public.is_corporate_user(),
  public.can_manage_employee(uuid)
to authenticated;

-- anon nunca necesita evaluar rol/autorización — sin EXECUTE explícito, estas
-- funciones no son invocables por anon (revoke all from public ya cubre esto,
-- reafirmado aquí por claridad de intención).
revoke all on function
  public.current_user_role(),
  public.is_admin_rrhh(),
  public.is_supervisor_production(),
  public.is_supervisor_installation(),
  public.is_corporate_user(),
  public.can_manage_employee(uuid)
from anon, public;

-- ---------------------------------------------------------------------------
-- RLS sobre profiles (deny-by-default: se habilita RLS y toda regla no
-- cubierta por una policy queda denegada).
alter table public.profiles enable row level security;

-- Cada usuario puede ver su propio perfil (necesario para que la UI futura
-- pueda leer su propio rol); ADMIN_RRHH puede ver todos (gestión de cuentas).
create policy profiles_select on public.profiles
  for select
  to authenticated
  using (id = auth.uid() or public.is_admin_rrhh());

-- Ningún usuario puede escribir su propio rol (protección de escalación de
-- privilegios, sección 22/23 del encargo) — de hecho, en Fase 3 NINGÚN
-- UPDATE de authenticated está permitido salvo ADMIN_RRHH, ni siquiera sobre
-- la propia fila: la edición de display_name propio queda fuera de alcance
-- de esta fase (simplificación documentada, no un descuido) y ADMIN_RRHH es
-- el único camino para asignar/cambiar un rol.
create policy profiles_update_admin_only on public.profiles
  for update
  to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- Sin policy de INSERT para `authenticated`: la única vía de creación de un
-- profile es el trigger on_auth_user_created (SECURITY DEFINER, corre como el
-- dueño de la función, no sujeto a esta policy). Un intento de INSERT directo
-- desde un cliente autenticado queda denegado por defecto (deny-by-default).
--
-- Sin policy de DELETE: se prefiere desactivar (profiles.active = false, ya
-- existente desde Fase 2A) sobre borrar — eliminar un profile podría romper
-- referencias de auditoría/decisiones históricas (decided_by, corrected_by,
-- etc.), y "eliminar" un acceso corporativo no es un caso confirmado en esta
-- fase.
