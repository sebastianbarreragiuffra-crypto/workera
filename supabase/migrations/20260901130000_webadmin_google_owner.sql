-- GESTORA: webadmin principal autenticado con Google.
--
-- El correo aprobado recibe dos capacidades independientes:
--   1. SUPER_ADMIN en el workspace operativo.
--   2. OWNER en el control plane multiempresa.
-- La asignación vive exclusivamente en provisioning; la aplicación nunca
-- decide permisos comparando emails durante una petición.

alter table public.authorized_email_roles
  add column if not exists platform_role public.platform_role;

comment on column public.authorized_email_roles.platform_role is
  'Rol opcional del control plane asignado durante el primer login. NULL no concede acceso global a la plataforma.';

insert into public.authorized_email_roles (email, role, platform_role)
values ('sbarreragiuffra@gmail.com', 'SUPER_ADMIN', 'OWNER')
on conflict (email) do update
set role = excluded.role,
    platform_role = excluded.platform_role;

-- Cuenta preexistente: converge al rol aprobado sin esperar un nuevo login.
insert into public.profiles (id, display_name, role, active)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    nullif(u.raw_user_meta_data ->> 'full_name', ''),
    u.email
  ),
  a.role,
  true
from auth.users u
join public.authorized_email_roles a on a.email = pg_catalog.lower(u.email)
where a.email = 'sbarreragiuffra@gmail.com'
on conflict (id) do update
set role = excluded.role,
    active = true;

insert into public.platform_memberships (user_id, role, active)
select u.id, a.platform_role, true
from auth.users u
join public.authorized_email_roles a on a.email = pg_catalog.lower(u.email)
where a.email = 'sbarreragiuffra@gmail.com'
  and a.platform_role is not null
on conflict (user_id) do update
set role = excluded.role,
    active = true;

-- Cuenta futura: email+password y Google OAuth terminan en auth.users, por lo
-- que ambos caminos reciben exactamente el mismo provisioning controlado.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
  v_platform_role public.platform_role;
begin
  select a.role, a.platform_role
    into v_role, v_platform_role
  from public.authorized_email_roles a
  where a.email = pg_catalog.lower(new.email);

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      new.email
    ),
    v_role
  )
  on conflict (id) do nothing;

  if v_platform_role is not null then
    insert into public.platform_memberships (user_id, role, active)
    values (new.id, v_platform_role, true)
    on conflict (user_id) do update
    set role = excluded.role,
        active = true;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Provisiona profile y, cuando authorized_email_roles.platform_role lo declara, membresía del control plane. No confía en metadata OAuth para decidir roles.';
