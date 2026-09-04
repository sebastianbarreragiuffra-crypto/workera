-- Boolean authorization guards must never return NULL. In PL/pgSQL,
-- `if not guard() then ...` does not enter the branch when guard() is NULL,
-- which previously allowed unauthorised callers to pass privileged RPC gates.

create or replace function public.can_manage_platform()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_platform_role() in ('OWNER', 'ADMIN'), false);
$$;

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
