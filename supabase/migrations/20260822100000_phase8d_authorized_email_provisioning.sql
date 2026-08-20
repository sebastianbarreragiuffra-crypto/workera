-- Fase 8D — Provisioning confiable de roles para el mapeo email->rol aprobado.
--
-- Por qué una migración (no código de aplicación): el encargo exige que el
-- provisioning sea "trusted, auditable, idempotent" y que el email
-- "SOLO se use en el límite de provisioning/bootstrap" -- nunca comparado en
-- componentes React ni server actions (eso dispersaría la lista aprobada por
-- el código y la haría imposible de auditar en un solo lugar). Una tabla +
-- un trigger SECURITY DEFINER es exactamente el mismo patrón ya establecido
-- en Fase 3 para `handle_new_auth_user` -- se EXTIENDE ese trigger, no se
-- reemplaza su diseño ni se toca la migración original (frozen).
--
-- Diseño:
--   1. `authorized_email_roles`: única fuente de verdad del mapeo, sin
--      ninguna policy de escritura para `authenticated` (deny-by-default) --
--      solo poblable vía migración. Auditable por diseño: se puede
--      consultar en cualquier momento quién está aprobado y para qué rol.
--   2. `handle_new_auth_user` (Fase 3) se recrea (create or replace, mismo
--      patrón ya usado en Fase 5D para `can_manage_employee`) para
--      consultar esta tabla y asignar el rol correcto en el momento del
--      primer login -- funciona igual para email+password que para OAuth,
--      porque ambos caminos terminan insertando la misma fila en
--      `auth.users`. Un email que NO está en la tabla sigue recibiendo
--      role=NULL, EXACTAMENTE el mismo comportamiento que ya existía --
--      nadie se auto-provisiona.
--   3. UPDATE retroactivo, idempotente: cubre cuentas que ya existían en
--      `auth.users` antes de que su email se agregara a la lista (el
--      trigger solo corre en INSERT, no repromueve cuentas ya creadas).
--
-- APP_ADMIN no es un rol nuevo: se audita el rol SUPER_ADMIN existente
-- (Fase 5D, `20260818180100_super_admin_privileges_and_access_model.sql`) y
-- ya tiene exactamente la base técnica requerida -- `is_super_admin()`,
-- RLS de `profiles_update` que impide a ADMIN_RRHH tocar o crear una cuenta
-- SUPER_ADMIN, y el trigger `prevent_last_super_admin_removal`. "APP_ADMIN"
-- es solo el nombre conceptual que usa la UI/documentación para ese mismo
-- rol técnico -- no se crea ningún valor nuevo de `app_role`.

create table public.authorized_email_roles (
  email      text primary key,
  role       public.app_role not null,
  created_at timestamptz not null default now()
);

comment on table public.authorized_email_roles is
  'Fase 8D -- única fuente de verdad del mapeo email->rol para bootstrap de '
  'acceso (email+password U OAuth). Poblada EXCLUSIVAMENTE vía migración -- '
  'sin policy de INSERT/UPDATE/DELETE para `authenticated` (deny-by-default). '
  'Nunca expuesta a través de ninguna API de la aplicación.';

alter table public.authorized_email_roles enable row level security;
-- Sin policies para `authenticated`/`anon`: deny-by-default real. Ni
-- siquiera SUPER_ADMIN puede leer/escribir esta tabla desde la aplicación --
-- el único lector es el trigger SECURITY DEFINER de abajo, y la única forma
-- de escribirla es una migración nueva (git, revisable, auditable).
revoke all on public.authorized_email_roles from authenticated, anon, public;

insert into public.authorized_email_roles (email, role) values
  ('i.gonzalez@arcotex.cl', 'SUPERVISOR_PRODUCTION'),
  ('ingenieria@arcotex.cl', 'SUPERVISOR_INSTALLATION'),
  ('asistenteg@arcotex.cl', 'ADMIN_RRHH'),
  ('a.caceres@arcotex.cl', 'ADMIN_RRHH'),
  ('a.valencia@arcotex.cl', 'ADMIN_RRHH'),
  ('c.barrera@arcotex.cl', 'ADMIN_RRHH'),
  ('s.barrera@arcotex.cl', 'SUPER_ADMIN')
on conflict (email) do update set role = excluded.role;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  select role into v_role
  from public.authorized_email_roles
  where email = lower(new.email);

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email),
    v_role  -- NULL si el email no está en la lista aprobada -- sin acceso, igual que antes de esta fase
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Crea la fila de profiles al registrarse un usuario en Supabase Auth '
  '(email+password u OAuth). role = el de authorized_email_roles si el '
  'email está aprobado (Fase 8D), NULL en cualquier otro caso -- sin acceso '
  'hasta que un SUPER_ADMIN asigne un rol explícito. SECURITY DEFINER: '
  'necesario para escribir en public.profiles desde el contexto de '
  'auth.users; search_path fijo vacío + nombres completamente calificados '
  'para evitar hijacking.';

-- Provisioning retroactivo (idempotente): cuentas que ya tenían una fila en
-- auth.users antes de esta migración no vuelven a disparar el trigger, así
-- que se corrigen acá directamente, una sola vez por email/rol. Reaplicar
-- esta migración converge siempre al mismo resultado (no es un simple
-- "promover", es "dejar en el rol exacto de la tabla aprobada").
update public.profiles p
set role = a.role
from auth.users u
join public.authorized_email_roles a on a.email = lower(u.email)
where p.id = u.id
  and p.role is distinct from a.role;
