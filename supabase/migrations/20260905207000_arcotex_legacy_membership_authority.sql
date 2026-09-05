-- La autoridad laboral legacy no puede depender solamente de profiles.role.
-- Ese valor se conserva para poder reactivar una membresia, pero deja de
-- conceder acceso en cuanto la membresia ARCOTEX o su workspace se cierran.

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  join public.company_memberships cm
    on cm.user_id = p.id
   and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
   and cm.active
  join public.companies c
    on c.id = cm.company_id
   and c.active
   and c.status = 'ACTIVE'
   and c.workspace_enabled
  where p.id = auth.uid()
    and p.active
    and p.role is not null
  limit 1;
$$;

comment on function public.current_user_role() is
  'Rol laboral legacy del usuario solo si su identidad y membresia ARCOTEX '
  'estan activas y el workspace sentinel sigue operativo. profiles.role se '
  'conserva como compatibilidad, pero ya no autoriza por si solo.';

revoke all on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;
