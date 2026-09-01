-- GESTORA: un único webadmin autorizado.
--
-- El acceso global al control plane queda reservado a s.barrera@arcotex.cl.
-- Los demás correos aprobados conservan únicamente su rol operacional cuando
-- corresponda; sbarreragiuffra@gmail.com deja de ser una identidad autorizada.

insert into public.authorized_email_roles (email, role, platform_role)
values ('s.barrera@arcotex.cl', 'SUPER_ADMIN', 'OWNER')
on conflict (email) do update
set role = excluded.role,
    platform_role = excluded.platform_role;

delete from public.authorized_email_roles
where email = 'sbarreragiuffra@gmail.com';

-- Si la cuenta corporativa ya existe, converge inmediatamente a ambos roles.
insert into public.profiles (id, display_name, role, active)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    nullif(u.raw_user_meta_data ->> 'full_name', ''),
    u.email
  ),
  'SUPER_ADMIN'::public.app_role,
  true
from auth.users u
where pg_catalog.lower(u.email) = 's.barrera@arcotex.cl'
on conflict (id) do update
set role = excluded.role,
    active = true;

insert into public.platform_memberships (user_id, role, active)
select u.id, 'OWNER'::public.platform_role, true
from auth.users u
where pg_catalog.lower(u.email) = 's.barrera@arcotex.cl'
on conflict (user_id) do update
set role = excluded.role,
    active = true;

-- Revocación retroactiva del correo personal si llegó a crear una cuenta.
-- La protección del último OWNER permanece activa: la cuenta corporativa se
-- provisiona primero para que nunca exista una ventana sin administrador.
delete from public.platform_memberships pm
using auth.users u
where pm.user_id = u.id
  and pg_catalog.lower(u.email) = 'sbarreragiuffra@gmail.com';

update public.profiles p
set role = null
from auth.users u
where p.id = u.id
  and pg_catalog.lower(u.email) = 'sbarreragiuffra@gmail.com';
