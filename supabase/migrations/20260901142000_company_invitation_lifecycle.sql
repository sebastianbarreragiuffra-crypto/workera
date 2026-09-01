-- Invitaciones empresariales de extremo a extremo: entrega observable y
-- aceptación atómica al autenticar al destinatario.

alter table public.company_invitations
  add column delivery_status text not null default 'PENDING',
  add column delivery_attempts integer not null default 0,
  add column last_delivery_at timestamptz,
  add column delivery_error_code text,
  add constraint company_invitations_delivery_status_chk
    check (delivery_status in ('PENDING', 'SENT', 'ACCOUNT_EXISTS', 'FAILED')),
  add constraint company_invitations_delivery_attempts_chk
    check (delivery_attempts >= 0),
  add constraint company_invitations_delivery_error_code_chk
    check (delivery_error_code is null or length(delivery_error_code) <= 80);

comment on column public.company_invitations.delivery_status is
  'Resultado del último intento de entrega. ACCOUNT_EXISTS indica que la persona debe ingresar con su cuenta existente.';

create or replace function public.platform_mark_company_invitation_delivery(
  p_invitation_id uuid,
  p_delivery_status text,
  p_error_code text default null
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
  v_status text := pg_catalog.upper(pg_catalog.btrim(p_delivery_status));
  v_error_code text := nullif(pg_catalog.left(pg_catalog.btrim(p_error_code), 80), '');
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.' using errcode = '42501';
  end if;
  if v_status not in ('SENT', 'ACCOUNT_EXISTS', 'FAILED') then
    raise exception 'Estado de entrega no válido.' using errcode = '22023';
  end if;

  update public.company_invitations ci
  set delivery_status = v_status,
      delivery_attempts = ci.delivery_attempts + 1,
      last_delivery_at = pg_catalog.clock_timestamp(),
      delivery_error_code = case when v_status = 'FAILED' then v_error_code else null end
  where ci.id = p_invitation_id and ci.status = 'PENDING'
  returning ci.company_id into v_company_id;

  if v_company_id is null then
    raise exception 'La invitación pendiente no existe.' using errcode = 'P0002';
  end if;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.invitation.delivery_attempted',
    'company_invitation', p_invitation_id::text,
    pg_catalog.jsonb_build_object('delivery_status', v_status, 'error_code', v_error_code)
  );
end;
$$;

create or replace function public.accept_my_company_invitations()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_email text;
  v_invitation record;
  v_membership_id uuid;
  v_accepted integer := 0;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(u.email)) into v_email
  from auth.users u
  where u.id = v_actor_id;

  if v_email is null or not exists (
    select 1 from public.profiles p where p.id = v_actor_id and p.active
  ) then
    return 0;
  end if;

  update public.company_invitations
  set status = 'EXPIRED'
  where email = v_email and status = 'PENDING' and expires_at <= pg_catalog.now();

  for v_invitation in
    select ci.id, ci.company_id, ci.role_id, cr.base_role,
           c.slug as company_slug, c.workspace_enabled
    from public.company_invitations ci
    join public.companies c on c.id = ci.company_id
    join public.company_roles cr
      on cr.company_id = ci.company_id and cr.id = ci.role_id
    where ci.email = v_email
      and ci.status = 'PENDING'
      and ci.expires_at > pg_catalog.now()
      and c.active and c.status in ('ACTIVE', 'ONBOARDING')
      and cr.active and cr.base_role is not null
    order by ci.created_at
    for update of ci
  loop
    insert into public.company_memberships (user_id, company_id, role, active)
    values (v_actor_id, v_invitation.company_id, v_invitation.base_role, true)
    on conflict (company_id, user_id) do update
      set role = excluded.role, active = true, updated_at = pg_catalog.clock_timestamp()
    returning id into v_membership_id;

    insert into public.company_membership_roles (
      company_id, membership_id, role_id, assigned_by
    ) values (
      v_invitation.company_id, v_membership_id, v_invitation.role_id, v_actor_id
    ) on conflict (company_id, membership_id, role_id) do nothing;

    -- Compatibilidad temporal con el workspace operacional legado. Nunca
    -- sobreescribe un rol global ya asignado.
    update public.profiles
    set role = v_invitation.base_role
    where id = v_actor_id
      and role is null
      and v_invitation.company_slug = 'arcotex'
      and v_invitation.workspace_enabled;

    update public.company_invitations
    set status = 'ACCEPTED', accepted_by = v_actor_id,
        accepted_at = pg_catalog.clock_timestamp()
    where id = v_invitation.id;

    insert into public.platform_audit_log (
      actor_id, company_id, action, target_type, target_id, metadata
    ) values (
      v_actor_id, v_invitation.company_id, 'company.invitation.accepted',
      'company_invitation', v_invitation.id::text,
      pg_catalog.jsonb_build_object('role_id', v_invitation.role_id)
    );
    v_accepted := v_accepted + 1;
  end loop;

  return v_accepted;
end;
$$;

revoke all on function public.platform_mark_company_invitation_delivery(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.accept_my_company_invitations()
  from public, anon, authenticated;
grant execute on function public.platform_mark_company_invitation_delivery(uuid, text, text)
  to authenticated;
grant execute on function public.accept_my_company_invitations()
  to authenticated;
