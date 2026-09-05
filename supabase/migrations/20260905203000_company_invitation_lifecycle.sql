-- Completa el ciclo de una invitación tenant. Un OWNER/ADMIN puede revocar
-- una invitación pendiente para corregir correo o rol y luego crear otra,
-- siempre con MFA y auditoría. Reenviar nunca cambia el rol silenciosamente.

create or replace function public.platform_revoke_company_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_role_id uuid;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_invitation_id is null then
    raise exception 'invitation_id es obligatorio.' using errcode = '22004';
  end if;

  select ci.company_id, ci.role_id
    into v_company_id, v_role_id
  from public.company_invitations ci
  where ci.id = p_invitation_id
    and ci.status = 'PENDING'
  for update;

  if not found then
    raise exception 'La invitación pendiente no existe.' using errcode = 'P0002';
  end if;

  -- Cierra la ventana entre autorización y adquisición del lock.
  if not public.can_manage_platform() then
    raise exception 'Tu autorización de plataforma ya no está activa.'
      using errcode = '42501';
  end if;

  update public.company_invitations
  set status = 'REVOKED'
  where id = p_invitation_id;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.invitation.revoked',
    'company_invitation', p_invitation_id::text,
    pg_catalog.jsonb_build_object('role_id', v_role_id)
  );
end;
$$;

comment on function public.platform_revoke_company_invitation(uuid) is
  'Revoca una invitación PENDING con MFA y auditoría para poder corregir correo o rol sin acumular permisos.';

revoke all on function public.platform_revoke_company_invitation(uuid)
  from public, anon, authenticated;
grant execute on function public.platform_revoke_company_invitation(uuid)
  to authenticated;
