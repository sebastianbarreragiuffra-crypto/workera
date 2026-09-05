-- Directorio mínimo para anticipos. Un rol financiero puede otorgar anticipos
-- sin necesariamente tener company.members.read; consultar memberships
-- directamente dejaba su selector incompleto por RLS. Este RPC expone solo el
-- identificador y nombre visible de miembros activos del tenant autorizado.

create or replace function public.list_expense_advance_recipients(
  p_company_id uuid
)
returns table (
  user_id uuid,
  display_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;

  if p_company_id is null then
    raise exception 'company_id es obligatorio.' using errcode = '22004';
  end if;

  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (
       not public.has_company_permission(p_company_id, 'expenses.reconcile')
       and not public.has_company_permission(p_company_id, 'expenses.manage')
     ) then
    raise exception 'Tu rol no permite consultar destinatarios de anticipos.'
      using errcode = '42501';
  end if;

  return query
  select cm.user_id, coalesce(p.display_name, 'Persona sin nombre registrado')
  from public.company_memberships cm
  join public.profiles p
    on p.id = cm.user_id
   and p.active
  join public.companies c
    on c.id = cm.company_id
   and c.active
  where cm.company_id = p_company_id
    and cm.active
  order by p.display_name nulls last, cm.user_id;
end;
$$;

comment on function public.list_expense_advance_recipients(uuid) is
  'Directorio financiero mínimo tenant-scoped: devuelve id y nombre de miembros activos para otorgar anticipos.';

revoke all on function public.list_expense_advance_recipients(uuid)
  from public, anon, authenticated;
grant execute on function public.list_expense_advance_recipients(uuid)
  to authenticated;
