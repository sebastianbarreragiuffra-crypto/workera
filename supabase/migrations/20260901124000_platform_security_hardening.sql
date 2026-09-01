-- GESTORA MT-3A -- hardening de fronteras antes de habilitar otro workspace.
--
-- Esta migracion no abre un segundo tenant operacional. Mantiene ARCOTEX como
-- unico workspace permitido hasta completar company_id, FKs compuestas y RLS
-- tenant-aware en todo el dominio laboral (MT-3B/MT-3D).

-- ---------------------------------------------------------------------------
-- Ciclo de vida coherente y gate temporal del workspace.

alter table public.companies
  add constraint companies_lifecycle_active_chk check (
    (status in ('ACTIVE', 'ONBOARDING') and active)
    or (status in ('SUSPENDED', 'INACTIVE') and not active)
  ) not valid;

alter table public.companies
  validate constraint companies_lifecycle_active_chk;

alter table public.companies
  add constraint companies_workspace_mt3a_gate_chk check (
    not workspace_enabled
    or (
      id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and active
      and status = 'ACTIVE'
    )
  ) not valid;

alter table public.companies
  validate constraint companies_workspace_mt3a_gate_chk;

-- No se permite que una fila laboral de otro tenant exista accidentalmente
-- mientras las tablas historicas todavia conservan RLS global de ARCOTEX.
do $$
begin
  if exists (
    select 1
    from public.employee_groups eg
    where eg.company_id <> '0a4c0000-0000-0000-0000-000000000001'::uuid
  ) or exists (
    select 1
    from public.employees e
    where e.company_id <> '0a4c0000-0000-0000-0000-000000000001'::uuid
  ) then
    raise exception
      'MT-3A no admite employee_groups/employees fuera del workspace ARCOTEX.'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function public.enforce_operational_company_workspace_enabled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_enabled boolean;
  v_active boolean;
  v_status public.company_lifecycle_status;
begin
  select c.workspace_enabled, c.active, c.status
    into v_workspace_enabled, v_active, v_status
  from public.companies c
  where c.id = new.company_id;

  if not found then
    raise exception 'Empresa operacional inexistente.' using errcode = '23503';
  end if;

  if not v_workspace_enabled or not v_active or v_status <> 'ACTIVE' then
    raise exception
      'El workspace de la empresa esta bloqueado para datos laborales.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger employee_groups_require_enabled_workspace
  before insert or update of company_id on public.employee_groups
  for each row execute function public.enforce_operational_company_workspace_enabled();

create trigger employees_require_enabled_workspace
  before insert or update of company_id on public.employees
  for each row execute function public.enforce_operational_company_workspace_enabled();

revoke all on function public.enforce_operational_company_workspace_enabled()
  from public, anon, authenticated;

-- Los helpers de membresia no dependen solo del booleano legacy. ONBOARDING
-- permanece accesible para configurar el cliente; SUSPENDED/INACTIVE revocan.
create or replace function public.active_company_memberships()
returns setof public.company_memberships
language sql
stable
security definer
set search_path = ''
as $$
  select cm.*
  from public.company_memberships cm
  where cm.user_id = auth.uid()
    and cm.active
    and exists (
      select 1
      from public.companies c
      where c.id = cm.company_id
        and c.active
        and c.status in ('ACTIVE', 'ONBOARDING')
    );
$$;

create or replace function public.is_active_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    join public.companies c on c.id = cm.company_id
    join public.profiles p on p.id = cm.user_id
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and cm.active
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
      and p.active
  );
$$;

create or replace function public.has_company_permission(
  p_company_id uuid,
  p_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    join public.companies c on c.id = cm.company_id
    join public.profiles p on p.id = cm.user_id
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id and cr.id = cmr.role_id and cr.active
    join public.company_role_permissions crp
      on crp.company_id = cr.company_id and crp.role_id = cr.id
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and cm.active
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
      and p.active
      and crp.permission_code = p_permission_code
  );
$$;

create or replace function public.company_has_module(
  p_company_id uuid,
  p_module_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_modules cm
    join public.companies c on c.id = cm.company_id
    where cm.company_id = p_company_id
      and cm.module_key = p_module_key
      and cm.status in ('ENABLED', 'PILOT')
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
  );
$$;

revoke all on function
  public.active_company_memberships(),
  public.is_active_company_member(uuid),
  public.has_company_permission(uuid, text),
  public.company_has_module(uuid, text)
from public, anon;

grant execute on function
  public.active_company_memberships(),
  public.is_active_company_member(uuid),
  public.has_company_permission(uuid, text),
  public.company_has_module(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Unicas vias de mutacion del control plane: RPCs SECURITY DEFINER auditados.
-- Donde todavia no existe RPC, el recurso permanece read-only. SELECT sigue
-- disponible y filtrado por RLS; una policy permisiva nunca sustituye GRANT.

revoke insert, update, delete on table
  public.companies,
  public.company_memberships,
  public.platform_memberships,
  public.company_roles,
  public.company_role_permissions,
  public.company_membership_roles,
  public.company_modules,
  public.company_invitations,
  public.company_onboarding_steps,
  public.organization_units,
  public.job_positions,
  public.employee_org_assignments,
  public.organization_unit_leads,
  public.reporting_lines,
  public.membership_org_scopes,
  public.platform_audit_log
from authenticated;

grant select on table
  public.companies,
  public.company_memberships,
  public.platform_memberships,
  public.company_roles,
  public.company_role_permissions,
  public.company_membership_roles,
  public.company_modules,
  public.company_invitations,
  public.company_onboarding_steps,
  public.organization_units,
  public.job_positions,
  public.employee_org_assignments,
  public.organization_unit_leads,
  public.reporting_lines,
  public.membership_org_scopes,
  public.platform_audit_log
to authenticated;

-- ---------------------------------------------------------------------------
-- Auditoria append-only incluso ante errores de un proceso con service_role.

create or replace function public.prevent_platform_audit_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'platform_audit_log es append-only.' using errcode = '55000';
end;
$$;

create trigger platform_audit_log_immutable
  before update or delete or truncate on public.platform_audit_log
  for each statement execute function public.prevent_platform_audit_log_mutation();

revoke all on function public.prevent_platform_audit_log_mutation()
  from public, anon, authenticated;

revoke all on sequence public.platform_audit_log_id_seq
  from public, anon, authenticated;

-- Prevencion de recurrencia para objetos futuros creados por el rol de
-- migraciones. Cada RPC publico debe recibir GRANT EXECUTE explicito.
alter default privileges in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- OWNER global: identidad inmutable y perfil activo protegido con el mismo
-- advisory lock que serializa degradaciones/desactivaciones de membresia.

create or replace function public.prevent_last_platform_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removes_owner boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'La identidad de una membresia de plataforma es inmutable.'
        using errcode = '23514';
    end if;

    v_removes_owner := new.role <> 'OWNER' or not new.active;
  elsif tg_op = 'DELETE' then
    v_removes_owner := true;
  end if;

  if old.role = 'OWNER' and old.active and v_removes_owner then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('gestora:last-platform-owner')
    );

    if not exists (
      select 1
      from public.platform_memberships pm
      join public.profiles p on p.id = pm.user_id
      where pm.user_id <> old.user_id
        and pm.role = 'OWNER'
        and pm.active
        and p.active
    ) then
      raise exception 'No se puede remover al ultimo OWNER activo de la plataforma.'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_last_platform_owner_profile_deactivation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.active and not new.active
     and exists (
       select 1
       from public.platform_memberships pm
       where pm.user_id = old.id
         and pm.role = 'OWNER'
         and pm.active
     ) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('gestora:last-platform-owner')
    );

    if not exists (
      select 1
      from public.platform_memberships pm
      join public.profiles p on p.id = pm.user_id
      where pm.user_id <> old.id
        and pm.role = 'OWNER'
        and pm.active
        and p.active
    ) then
      raise exception
        'No se puede desactivar el perfil del ultimo OWNER activo de la plataforma.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_preserve_last_platform_owner
  before update of active on public.profiles
  for each row execute function public.prevent_last_platform_owner_profile_deactivation();

revoke all on function
  public.prevent_last_platform_owner_removal(),
  public.prevent_last_platform_owner_profile_deactivation()
from public, anon, authenticated;

-- Recorridos del arbol y validacion anti-ciclo parten por tenant/padre.
create index if not exists organization_units_company_parent_idx
  on public.organization_units(company_id, parent_id);
