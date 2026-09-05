-- Cierra inconsistencias de identidad introducidas durante la transición
-- ARCOTEX legacy -> RBAC multiempresa.
--
-- 1. Una membresía de un tenant nuevo puede ser puramente RBAC y, por tanto,
--    no tener equivalente en app_role.
-- 2. Aceptar una invitación reemplaza el rol principal: nunca acumula permisos.
-- 3. El puente legacy de ARCOTEX mantiene sincronizadas ambas representaciones.
-- 4. MFA conserva el alcance que ya está protegido en middleware y RPC.
-- 5. Las altas operacionales nuevas pasan por invitación; solo el OWNER
--    bootstrap conserva preautorización por correo.

alter table public.company_memberships
  alter column role drop not null;

comment on column public.company_memberships.role is
  'Compatibilidad temporal con app_role para el workspace laboral legacy. '
  'Puede ser NULL en tenants RBAC puros; la autoridad multiempresa es '
  'company_membership_roles + company_role_permissions.';

-- La lista histórica de siete correos era un bootstrap previo al control
-- plane. Desde ahora las cuentas empresariales se habilitan por invitación;
-- conservar esas filas permitiría saltarse el flujo tenant-aware.
delete from public.authorized_email_roles
where platform_role is distinct from 'OWNER'::public.platform_role;

comment on table public.authorized_email_roles is
  'Bootstrap de emergencia para la identidad OWNER inicial. Las demás cuentas '
  'se incorporan exclusivamente mediante company_invitations; no agregar '
  'correos operacionales para eludir ese flujo.';

create or replace function public.sync_arcotex_company_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_arcotex_id uuid;
  v_membership_id uuid;
  v_role_id uuid;
begin
  -- El UUID es el sentinel estable del workspace laboral. El slug es una
  -- etiqueta de URL mutable y no puede definir autorización ni sincronía.
  select c.id into v_arcotex_id
  from public.companies c
  where c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid;

  if v_arcotex_id is null then
    return new;
  end if;

  if new.role is not null and new.active then
    -- Si el panel acaba de asignar un rol custom compatible, conservarlo.
    -- Elegir siempre el rol system destruiría silenciosamente permisos custom
    -- cuando el UPDATE de profiles disparara este puente legacy.
    select cm.id into v_membership_id
    from public.company_memberships cm
    where cm.user_id = new.id
      and cm.company_id = v_arcotex_id;

    if v_membership_id is not null then
      select cr.id into v_role_id
      from public.company_membership_roles cmr
      join public.company_roles cr
        on cr.company_id = cmr.company_id
       and cr.id = cmr.role_id
      where cmr.company_id = v_arcotex_id
        and cmr.membership_id = v_membership_id
        and cr.base_role = new.role
        and cr.active
      order by cr.is_system asc, cr.created_at, cr.id
      limit 1;
    end if;

    -- Si no existe una asignación compatible, usar el rol system canónico.
    -- Esto cubre altas antiguas y cambios directos de profiles.role.
    if v_role_id is null then
    select cr.id into v_role_id
    from public.company_roles cr
    where cr.company_id = v_arcotex_id
      and cr.base_role = new.role
      and cr.active
      and cr.is_system
    order by cr.created_at, cr.id
    limit 1;
    end if;

    if v_role_id is null then
      raise exception 'ARCOTEX no tiene un rol RBAC activo para el rol legacy solicitado.'
        using errcode = '23514';
    end if;

    insert into public.company_memberships (user_id, company_id, role, active)
    values (new.id, v_arcotex_id, new.role, true)
    on conflict (user_id, company_id) do update
      set role = excluded.role,
          active = true,
          updated_at = pg_catalog.clock_timestamp()
    returning id into v_membership_id;

    -- El panel administra hoy un rol principal por membresía. Mantener una
    -- sola fila evita que un cambio legacy deje permisos anteriores activos.
    delete from public.company_membership_roles cmr
    where cmr.company_id = v_arcotex_id
      and cmr.membership_id = v_membership_id;

    insert into public.company_membership_roles (
      company_id, membership_id, role_id, assigned_by
    ) values (
      v_arcotex_id, v_membership_id, v_role_id, auth.uid()
    );
  else
    update public.company_memberships cm
    set active = false,
        role = null,
        updated_at = pg_catalog.clock_timestamp()
    where cm.user_id = new.id
      and cm.company_id = v_arcotex_id
    returning cm.id into v_membership_id;

    if v_membership_id is not null then
      delete from public.company_membership_roles cmr
      where cmr.company_id = v_arcotex_id
        and cmr.membership_id = v_membership_id;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.sync_arcotex_company_membership() is
  'Puente ARCOTEX: sincroniza profiles.role/active con company_memberships y '
  'con exactamente un company_membership_role. No aplica a otros tenants.';

revoke all on function public.sync_arcotex_company_membership()
  from public, anon, authenticated;

-- Repara drift preexistente sin destruir un rol custom compatible. La CTE
-- materializada elige primero una asignación custom activa con el mismo
-- base_role y cae al rol system únicamente si no existe.
with desired as materialized (
  select
    cm.company_id,
    cm.id as membership_id,
    coalesce(
      (
        select cr_existing.id
        from public.company_membership_roles cmr_existing
        join public.company_roles cr_existing
          on cr_existing.company_id = cmr_existing.company_id
         and cr_existing.id = cmr_existing.role_id
        where cmr_existing.company_id = cm.company_id
          and cmr_existing.membership_id = cm.id
          and cr_existing.base_role = p.role
          and cr_existing.active
        order by cr_existing.is_system asc, cr_existing.created_at, cr_existing.id
        limit 1
      ),
      (
        select cr_system.id
        from public.company_roles cr_system
        where cr_system.company_id = cm.company_id
          and cr_system.base_role = p.role
          and cr_system.active
          and cr_system.is_system
        order by cr_system.created_at, cr_system.id
        limit 1
      )
    ) as role_id
  from public.company_memberships cm
  join public.profiles p
    on p.id = cm.user_id and p.active and p.role is not null
  where cm.active
    and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
), removed as (
  delete from public.company_membership_roles cmr
  using public.company_memberships cm
  where cmr.company_id = cm.company_id
    and cmr.membership_id = cm.id
    and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
  returning cmr.membership_id
)
insert into public.company_membership_roles (
  company_id, membership_id, role_id, assigned_by
)
select d.company_id, d.membership_id, d.role_id, null
from desired d
cross join (
  select pg_catalog.count(*) as removed_count
  from removed
) barrier
where d.role_id is not null;

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
  v_membership_was_active boolean;
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
  where email = v_email
    and status = 'PENDING'
    and expires_at <= pg_catalog.now();

  for v_invitation in
    select ci.id, ci.company_id, ci.role_id, cr.base_role,
           c.workspace_enabled
    from public.company_invitations ci
    join public.companies c on c.id = ci.company_id
    join public.company_roles cr
      on cr.company_id = ci.company_id and cr.id = ci.role_id
    where ci.email = v_email
      and ci.status = 'PENDING'
      and ci.expires_at > pg_catalog.now()
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
      and cr.active
      and (not c.workspace_enabled or cr.base_role is not null)
    order by ci.created_at
    for update of ci
  loop
    v_membership_id := null;
    v_membership_was_active := false;

    select cm.id, cm.active
      into v_membership_id, v_membership_was_active
    from public.company_memberships cm
    where cm.company_id = v_invitation.company_id
      and cm.user_id = v_actor_id
    for update;

    -- Una invitación es un alta, no una vía lateral para cambiar el rol de un
    -- miembro ya activo. Ese cambio se hace con platform_assign_company_role.
    if v_membership_id is not null and v_membership_was_active then
      update public.company_invitations
      set status = 'REVOKED'
      where id = v_invitation.id;

      insert into public.platform_audit_log (
        actor_id, company_id, action, target_type, target_id, metadata
      ) values (
        v_actor_id, v_invitation.company_id,
        'company.invitation.revoked_existing_member',
        'company_invitation', v_invitation.id::text,
        pg_catalog.jsonb_build_object('role_id', v_invitation.role_id)
      );
      continue;
    end if;

    insert into public.company_memberships (user_id, company_id, role, active)
    values (v_actor_id, v_invitation.company_id, v_invitation.base_role, true)
    on conflict (company_id, user_id) do update
      set role = excluded.role,
          active = true,
          updated_at = pg_catalog.clock_timestamp()
    returning id into v_membership_id;

    delete from public.company_membership_roles cmr
    where cmr.company_id = v_invitation.company_id
      and cmr.membership_id = v_membership_id;

    insert into public.company_membership_roles (
      company_id, membership_id, role_id, assigned_by
    ) values (
      v_invitation.company_id, v_membership_id,
      v_invitation.role_id, v_actor_id
    );

    -- El único profiles.role activo es la compatibilidad laboral de ARCOTEX.
    -- En tenants nuevos el rol puede ser puramente RBAC y permanece NULL.
    if v_invitation.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and v_invitation.workspace_enabled
       and v_invitation.base_role is not null then
      update public.profiles
      set role = v_invitation.base_role
      where id = v_actor_id;
    end if;

    update public.company_invitations
    set status = 'ACCEPTED',
        accepted_by = v_actor_id,
        accepted_at = pg_catalog.clock_timestamp()
    where id = v_invitation.id;

    insert into public.platform_audit_log (
      actor_id, company_id, action, target_type, target_id, metadata
    ) values (
      v_actor_id, v_invitation.company_id,
      'company.invitation.accepted',
      'company_invitation', v_invitation.id::text,
      pg_catalog.jsonb_build_object('role_id', v_invitation.role_id)
    );
    v_accepted := v_accepted + 1;
  end loop;

  return v_accepted;
end;
$$;

revoke all on function public.accept_my_company_invitations()
  from public, anon, authenticated;
grant execute on function public.accept_my_company_invitations()
  to authenticated;

-- Mantener el alcance MFA que ya tiene doble defensa completa: middleware y
-- guardas de backend. Ampliarlo a permisos tenant sin proteger primero todos
-- sus RPC dejaría una falsa promesa: la UI pediría AAL2, pero un JWT aal1 aún
-- podría llamar algunas mutaciones financieras u operacionales directamente.
-- Para el alcance actual basta la única identidad OWNER activa; los roles
-- legacy privilegiados siguen cubiertos por compatibilidad.
create or replace function public.account_requires_mfa(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.profiles p
      where p.id = p_user
        and p.active
        and p.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
    )
    or exists (
      select 1
      from public.platform_memberships pm
      join public.profiles p on p.id = pm.user_id and p.active
      where pm.user_id = p_user
        and pm.active
        and pm.role in ('OWNER', 'ADMIN')
    )
    ,
    false
  );
$$;

comment on function public.account_requires_mfa(uuid) is
  'Autoridad única de MFA: perfiles legacy SUPER_ADMIN/ADMIN_RRHH y '
  'OWNER/ADMIN de plataforma. Ampliar solo junto con las guardas RPC.';

revoke all on function public.account_requires_mfa(uuid)
  from public, anon, authenticated;

-- El bootstrap histórico del aprobador médico se identificaba por email. El
-- flag ya provisionado no concede acceso por sí solo: además exige identidad
-- activa, membresía Arcotex vigente y el permiso tenant correspondiente.
create or replace function public.is_medical_license_approver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.profiles p
      join public.company_memberships cm
        on cm.user_id = p.id
       and cm.active
      join public.companies c
        on c.id = cm.company_id
       and c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and c.active
       and c.status in ('ACTIVE', 'ONBOARDING')
      where p.id = auth.uid()
        and p.active
        and p.medical_license_approver
        and public.has_company_permission(c.id, 'licenses.approve')
    ),
    false
  );
$$;

comment on function public.is_medical_license_approver() is
  'Compatibilidad médica Arcotex: el flag histórico solo es válido junto a '
  'identidad y membresía activas con licenses.approve. El email nunca autoriza '
  'en tiempo de ejecución.';

revoke all on function public.is_medical_license_approver()
  from public, anon, authenticated;
grant execute on function public.is_medical_license_approver()
  to authenticated;
