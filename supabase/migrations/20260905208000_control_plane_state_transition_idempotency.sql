-- Hardening de transiciones del control plane: expiración de invitaciones,
-- idempotencia real, timestamps estables y catálogo de onboarding extensible.

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
  v_expires_at timestamptz;
  v_status text := pg_catalog.upper(pg_catalog.btrim(p_delivery_status));
  v_error_code text := nullif(pg_catalog.left(pg_catalog.btrim(p_error_code), 80), '');
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_invitation_id is null then
    raise exception 'invitation_id es obligatorio.' using errcode = '22004';
  end if;
  if v_status is null or v_status not in ('SENT', 'ACCOUNT_EXISTS', 'FAILED') then
    raise exception 'Estado de entrega no válido.' using errcode = '22023';
  end if;

  select ci.company_id, ci.expires_at
    into v_company_id, v_expires_at
  from public.company_invitations ci
  where ci.id = p_invitation_id
    and ci.status = 'PENDING'
  for update;

  if not found then
    raise exception 'La invitación pendiente no existe.' using errcode = 'P0002';
  end if;

  if not public.can_manage_platform() then
    raise exception 'Tu autorización de plataforma ya no está activa.'
      using errcode = '42501';
  end if;

  if v_expires_at <= pg_catalog.now() then
    raise exception 'La invitación pendiente está expirada.' using errcode = '23514';
  end if;

  update public.company_invitations ci
  set delivery_status = v_status,
      delivery_attempts = ci.delivery_attempts + 1,
      last_delivery_at = pg_catalog.clock_timestamp(),
      delivery_error_code = case when v_status = 'FAILED' then v_error_code else null end
  where ci.id = p_invitation_id
    and ci.status = 'PENDING';

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, v_company_id, 'company.invitation.delivery_attempted',
    'company_invitation', p_invitation_id::text,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'delivery_status', v_status,
      'error_code', case when v_status = 'FAILED' then v_error_code else null end
    ))
  );
end;
$$;

revoke all on function public.platform_mark_company_invitation_delivery(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.platform_mark_company_invitation_delivery(uuid, text, text)
  to authenticated;

create or replace function public.platform_set_onboarding_step_completed(
  p_company_id uuid,
  p_step_key text,
  p_completed boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_onboarding_status;
  v_next_status public.company_onboarding_status;
  v_workspace_enabled boolean;
  v_independent_module_enabled boolean := false;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_step_key is null or p_completed is null then
    raise exception 'company_id, step_key y completed son obligatorios.'
      using errcode = '22004';
  end if;

  v_next_status := case
    when p_completed then 'COMPLETE'::public.company_onboarding_status
    else 'NOT_STARTED'::public.company_onboarding_status
  end;

  select cos.status, c.workspace_enabled
    into v_previous_status, v_workspace_enabled
  from public.company_onboarding_steps cos
  join public.companies c on c.id = cos.company_id
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key
    and c.active
    and c.status in ('ACTIVE', 'ONBOARDING')
  for update;

  if not found then
    raise exception 'Paso de onboarding no provisionado para la empresa.'
      using errcode = '23503';
  end if;

  if not public.can_manage_platform() then
    raise exception 'Tu autorización de plataforma ya no está activa.'
      using errcode = '42501';
  end if;

  -- La firma no recibe evidencia externa: si el estado ya coincide, conservar
  -- completed_at, completed_by, notes y updated_at es el no-op real.
  if v_previous_status = v_next_status then
    return;
  end if;

  if p_completed and p_step_key = 'go_live' and exists (
    select 1
    from public.onboarding_step_catalog osc
    left join public.company_onboarding_steps pending
      on pending.company_id = p_company_id
     and pending.step_key = osc.key
    where osc.active
      and osc.key <> 'go_live'
      and coalesce(pending.status, 'NOT_STARTED') <> 'COMPLETE'
  ) then
    raise exception 'Completa los pasos anteriores antes de activar la empresa.'
      using errcode = '23514';
  end if;

  if not p_completed and p_step_key = 'go_live' and v_workspace_enabled then
    raise exception 'No se puede reabrir go_live mientras el workspace laboral está operativo.'
      using errcode = '23514';
  end if;

  if not p_completed and p_step_key <> 'go_live' and exists (
    select 1
    from public.company_onboarding_steps live_step
    where live_step.company_id = p_company_id
      and live_step.step_key = 'go_live'
      and live_step.status = 'COMPLETE'
  ) then
    raise exception 'Reabre go_live antes de reabrir un paso anterior.'
      using errcode = '23514';
  end if;

  if p_completed and p_step_key = 'go_live' and not v_workspace_enabled then
    select exists (
      select 1
      from public.company_modules cm
      join public.module_catalog mc
        on mc.key = cm.module_key
       and mc.active
       and mc.tenant_isolated
      where cm.company_id = p_company_id
        and cm.status in ('ENABLED', 'PILOT')
    ) into v_independent_module_enabled;

    if not v_independent_module_enabled then
      raise exception 'Activa al menos un módulo multiempresa antes de completar go_live.'
        using errcode = '23514';
    end if;
  end if;

  update public.company_onboarding_steps cos
  set status = v_next_status,
      completed_at = case when p_completed then pg_catalog.clock_timestamp() else null end,
      completed_by = case when p_completed then v_actor_id else null end
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key;

  if p_completed and p_step_key = 'go_live' then
    update public.companies c
    set status = 'ACTIVE',
        onboarded_at = coalesce(c.onboarded_at, pg_catalog.clock_timestamp())
    where c.id = p_company_id;
  elsif not p_completed and p_step_key = 'go_live' then
    update public.companies c
    set status = 'ONBOARDING'
    where c.id = p_company_id
      and c.status = 'ACTIVE'
      and not c.workspace_enabled;
  end if;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, p_company_id, 'company.onboarding_step.status_changed',
    'company_onboarding_step', p_step_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', v_next_status,
      'workspace_enabled', v_workspace_enabled,
      'independent_module_enabled', v_independent_module_enabled
    )
  );
end;
$$;

comment on function public.platform_set_onboarding_step_completed(uuid, text, boolean) is
  'Marca un paso de onboarding como COMPLETE o NOT_STARTED, mantiene sus metadatos de finalizacion y audita atomicamente.';

revoke all on function public.platform_set_onboarding_step_completed(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.platform_set_onboarding_step_completed(uuid, text, boolean)
  to authenticated;

create or replace function public.platform_set_company_module_status(
  p_company_id uuid,
  p_module_key text,
  p_status public.company_module_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_module_status;
  v_catalog_active boolean;
  v_tenant_isolated boolean;
  v_workspace_enabled boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_module_key is null or p_status is null then
    raise exception 'company_id, module_key y status son obligatorios.'
      using errcode = '22004';
  end if;

  select cm.status, mc.active, mc.tenant_isolated, c.workspace_enabled
    into v_previous_status, v_catalog_active, v_tenant_isolated, v_workspace_enabled
  from public.company_modules cm
  join public.module_catalog mc on mc.key = cm.module_key
  join public.companies c
    on c.id = cm.company_id
   and c.active
   and c.status in ('ACTIVE', 'ONBOARDING')
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key
  for update of cm, mc, c;

  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;

  if not found then
    raise exception 'Módulo o empresa inexistente o inactiva.'
      using errcode = '23503';
  end if;

  if not v_catalog_active and p_status in ('ENABLED', 'PILOT') then
    raise exception 'No se puede habilitar un módulo inactivo del catálogo.'
      using errcode = '23514';
  end if;

  if not v_tenant_isolated and p_status <> v_previous_status then
    raise exception 'Este módulo sigue ligado al workspace laboral y no puede cambiarse hasta completar su aislamiento multiempresa.'
      using errcode = '23514';
  end if;

  if p_status = v_previous_status then
    return;
  end if;

  if not v_workspace_enabled
     and v_previous_status in ('ENABLED', 'PILOT')
     and p_status not in ('ENABLED', 'PILOT')
     and exists (
       select 1
       from public.company_onboarding_steps live_step
       where live_step.company_id = p_company_id
         and live_step.step_key = 'go_live'
         and live_step.status = 'COMPLETE'
     )
     and not exists (
       select 1
       from public.company_modules other_module
       join public.module_catalog other_catalog
         on other_catalog.key = other_module.module_key
        and other_catalog.active
        and other_catalog.tenant_isolated
       where other_module.company_id = p_company_id
         and other_module.module_key <> p_module_key
         and other_module.status in ('ENABLED', 'PILOT')
     ) then
    raise exception 'Reabre go_live antes de desactivar el último módulo multiempresa.'
      using errcode = '23514';
  end if;

  update public.company_modules cm
  set status = p_status,
      enabled_at = case
        when p_status in ('ENABLED', 'PILOT')
          then case
            when v_previous_status in ('ENABLED', 'PILOT') then cm.enabled_at
            else pg_catalog.clock_timestamp()
          end
        else null
      end,
      enabled_by = case
        when p_status in ('ENABLED', 'PILOT') then v_actor_id
        else null
      end
  where cm.company_id = p_company_id
    and cm.module_key = p_module_key;

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id, p_company_id, 'company.module.status_changed',
    'company_module', p_module_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', p_status,
      'tenant_isolated', v_tenant_isolated
    )
  );
end;
$$;

comment on function public.platform_set_company_module_status(
  uuid, text, public.company_module_status
) is
  'Cambia solo módulos tenant-isolated de empresas operables; preserva la consistencia de go_live, exige MFA, revalida al actor y audita cambios efectivos.';

revoke all on function public.platform_set_company_module_status(uuid, text, public.company_module_status)
  from public, anon, authenticated;
grant execute on function public.platform_set_company_module_status(uuid, text, public.company_module_status)
  to authenticated;

create or replace function public.provision_active_onboarding_step_to_companies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_should_provision boolean := false;
begin
  if tg_op = 'INSERT' then
    v_should_provision := new.active;
  elsif tg_op = 'UPDATE' then
    v_should_provision := new.active and not old.active;
  end if;

  if v_should_provision then
    insert into public.company_onboarding_steps (company_id, step_key, status)
    select c.id, new.key, 'NOT_STARTED'::public.company_onboarding_status
    from public.companies c
    on conflict (company_id, step_key) do nothing;
  end if;
  return new;
end;
$$;

comment on function public.provision_active_onboarding_step_to_companies() is
  'Provisiona un paso de onboarding nuevo o reactivado para todas las empresas existentes.';

revoke all on function public.provision_active_onboarding_step_to_companies()
  from public, anon, authenticated, service_role;

drop trigger if exists onboarding_step_catalog_provision_companies
  on public.onboarding_step_catalog;
create trigger onboarding_step_catalog_provision_companies
  after insert or update of active on public.onboarding_step_catalog
  for each row execute function public.provision_active_onboarding_step_to_companies();

insert into public.company_onboarding_steps (company_id, step_key, status)
select c.id, osc.key, 'NOT_STARTED'::public.company_onboarding_status
from public.companies c
cross join public.onboarding_step_catalog osc
where osc.active
on conflict (company_id, step_key) do nothing;
