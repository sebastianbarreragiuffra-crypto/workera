-- GESTORA MT-3A — control plane multiempresa, RBAC extensible, módulos y
-- organización. Este cambio es aditivo y conserva el workspace ARCOTEX.
--
-- Decisión de seguridad: una empresa nueva queda en ONBOARDING y con
-- workspace_enabled=false. Puede configurarse desde el control plane, pero
-- NO puede operar todavía sobre las tablas laborales históricas. La apertura
-- de un segundo workspace requiere completar MT-3B/MT-3D (company_id + FKs
-- compuestas + RLS tenant en las 47 tablas de dominio). Evita prometer un
-- aislamiento que todavía no existe y permite avanzar en producto sin
-- reconstruir la aplicación.

-- ---------------------------------------------------------------------------
-- Vocabularios estables del control plane.

create type public.platform_role as enum (
  'OWNER',
  'ADMIN',
  'SUPPORT',
  'VIEWER'
);

create type public.company_lifecycle_status as enum (
  'ACTIVE',
  'ONBOARDING',
  'SUSPENDED',
  'INACTIVE'
);

create type public.company_module_status as enum (
  'ENABLED',
  'DISABLED',
  'PILOT',
  'SETUP_REQUIRED'
);

create type public.company_onboarding_status as enum (
  'NOT_STARTED',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETE'
);

create type public.company_invitation_status as enum (
  'PENDING',
  'ACCEPTED',
  'EXPIRED',
  'REVOKED'
);

create type public.organization_unit_type as enum (
  'COMPANY',
  'DIVISION',
  'AREA',
  'DEPARTMENT',
  'TEAM',
  'OTHER'
);

-- ---------------------------------------------------------------------------
-- Empresas como clientes de la plataforma.

alter table public.companies
  add column legal_name text,
  add column status public.company_lifecycle_status not null default 'ONBOARDING',
  add column workspace_enabled boolean not null default false,
  add column plan_code text not null default 'CUSTOM',
  add column country_code text not null default 'CL',
  add column timezone text not null default 'America/Santiago',
  add column primary_contact_name text,
  add column primary_contact_email text,
  add column created_by uuid references public.profiles(id),
  add column onboarded_at timestamptz,
  add constraint companies_country_code_chk check (country_code ~ '^[A-Z]{2}$'),
  add constraint companies_primary_contact_email_chk check (
    primary_contact_email is null
    or primary_contact_email = lower(primary_contact_email)
  );

update public.companies
set legal_name = coalesce(legal_name, name),
    status = case when active then 'ACTIVE'::public.company_lifecycle_status else 'INACTIVE'::public.company_lifecycle_status end,
    workspace_enabled = (slug = 'arcotex' and active),
    plan_code = case when slug = 'arcotex' then 'FOUNDING' else plan_code end,
    onboarded_at = case when slug = 'arcotex' and active then coalesce(onboarded_at, now()) else onboarded_at end;

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

comment on column public.companies.workspace_enabled is
  'Gate explícito del workspace operacional. Una empresa puede existir y ser configurada en el control plane sin habilitar acceso a datos laborales. Solo ARCOTEX queda habilitada durante MT-3A.';

-- ---------------------------------------------------------------------------
-- Administración global de plataforma, separada de roles de empresa.

create table public.platform_memberships (
  user_id     uuid primary key references public.profiles(id),
  role        public.platform_role not null,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.platform_memberships enable row level security;
create trigger platform_memberships_set_updated_at
  before update on public.platform_memberships
  for each row execute function public.set_updated_at();

insert into public.platform_memberships (user_id, role, active)
select id, 'OWNER'::public.platform_role, true
from public.profiles
where role = 'SUPER_ADMIN' and active
on conflict (user_id) do nothing;

create or replace function public.current_platform_role()
returns public.platform_role
language sql
stable
security definer
set search_path = ''
as $$
  select pm.role
  from public.platform_memberships pm
  join public.profiles p on p.id = pm.user_id
  where pm.user_id = auth.uid()
    and pm.active
    and p.active;
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_platform_role() is not null;
$$;

create or replace function public.can_manage_platform()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_platform_role() in ('OWNER', 'ADMIN');
$$;

grant execute on function
  public.current_platform_role(),
  public.is_platform_admin(),
  public.can_manage_platform()
to authenticated;
revoke all on function
  public.current_platform_role(),
  public.is_platform_admin(),
  public.can_manage_platform()
from anon, public;

create policy platform_memberships_select on public.platform_memberships
  for select to authenticated
  using (public.is_platform_admin());
create policy platform_memberships_insert on public.platform_memberships
  for insert to authenticated
  with check (public.current_platform_role() = 'OWNER');
create policy platform_memberships_update on public.platform_memberships
  for update to authenticated
  using (public.current_platform_role() = 'OWNER')
  with check (public.current_platform_role() = 'OWNER');

create or replace function public.prevent_last_platform_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'OWNER' and old.active
     and (tg_op = 'DELETE' or new.role <> 'OWNER' or not new.active) then
    perform pg_advisory_xact_lock(hashtext('gestora:last-platform-owner'));
    if not exists (
      select 1 from public.platform_memberships pm
      join public.profiles p on p.id = pm.user_id
      where pm.user_id <> old.user_id
        and pm.role = 'OWNER'
        and pm.active
        and p.active
    ) then
      raise exception 'No se puede remover al último OWNER activo de la plataforma.' using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger platform_memberships_preserve_owner
  before update or delete on public.platform_memberships
  for each row execute function public.prevent_last_platform_owner_removal();

-- La identidad sigue siendo global, pero un administrador de plataforma debe
-- poder resolver los nombres de las cuentas que gestiona.
create policy profiles_select_platform on public.profiles
  for select to authenticated
  using (public.is_platform_admin());

-- El control plane puede descubrir todas las empresas; un miembro de cliente
-- solo ve empresas activas donde posee membresía activa.
drop policy if exists companies_select_member on public.companies;
create policy companies_select_member on public.companies
  for select to authenticated
  using (
    active
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = companies.id
        and cm.user_id = auth.uid()
        and cm.active
    )
  );
create policy companies_select_platform on public.companies
  for select to authenticated
  using (public.is_platform_admin());
create policy companies_insert_platform on public.companies
  for insert to authenticated
  with check (public.can_manage_platform() and created_by = auth.uid());
create policy companies_update_platform on public.companies
  for update to authenticated
  using (public.can_manage_platform())
  with check (public.can_manage_platform());

create policy company_memberships_select_platform on public.company_memberships
  for select to authenticated
  using (public.is_platform_admin());
create policy company_memberships_insert_platform on public.company_memberships
  for insert to authenticated
  with check (public.can_manage_platform());
create policy company_memberships_update_platform on public.company_memberships
  for update to authenticated
  using (public.can_manage_platform())
  with check (public.can_manage_platform());

alter table public.company_memberships
  add constraint company_memberships_company_id_id_key unique (company_id, id),
  add constraint company_memberships_company_id_user_id_key unique (company_id, user_id);

-- ---------------------------------------------------------------------------
-- Módulos, permisos y roles empresariales extensibles.

create table public.module_catalog (
  key          text primary key,
  name         text not null,
  description  text not null,
  category     text not null,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint module_catalog_key_chk check (key ~ '^[a-z][a-z0-9_]*$')
);

create table public.permission_definitions (
  code         text primary key,
  module_key   text references public.module_catalog(key),
  description  text not null,
  created_at   timestamptz not null default now(),
  constraint permission_definitions_code_chk check (code ~ '^[a-z][a-z0-9_.]*$')
);

create table public.company_roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null,
  name        text not null,
  description text,
  base_role   public.app_role,
  is_system   boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint company_roles_company_code_key unique (company_id, code),
  constraint company_roles_company_id_id_key unique (company_id, id),
  constraint company_roles_code_chk check (code ~ '^[A-Z][A-Z0-9_]*$')
);

create trigger company_roles_set_updated_at
  before update on public.company_roles
  for each row execute function public.set_updated_at();

create table public.company_role_permissions (
  company_id      uuid not null references public.companies(id) on delete cascade,
  role_id         uuid not null,
  permission_code text not null references public.permission_definitions(code) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (company_id, role_id, permission_code),
  foreign key (company_id, role_id)
    references public.company_roles(company_id, id) on delete cascade
);

create table public.company_membership_roles (
  company_id     uuid not null references public.companies(id) on delete cascade,
  membership_id  uuid not null,
  role_id        uuid not null,
  assigned_by    uuid references public.profiles(id),
  assigned_at    timestamptz not null default now(),
  primary key (company_id, membership_id, role_id),
  foreign key (company_id, membership_id)
    references public.company_memberships(company_id, id) on delete cascade,
  foreign key (company_id, role_id)
    references public.company_roles(company_id, id) on delete cascade
);

create table public.company_modules (
  company_id       uuid not null references public.companies(id) on delete cascade,
  module_key       text not null references public.module_catalog(key),
  status           public.company_module_status not null default 'DISABLED',
  settings_version integer not null default 1 check (settings_version > 0),
  settings         jsonb not null default '{}'::jsonb,
  enabled_by       uuid references public.profiles(id),
  enabled_at       timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (company_id, module_key),
  constraint company_modules_settings_object_chk check (jsonb_typeof(settings) = 'object'),
  constraint company_modules_enabled_metadata_chk check (
    (status in ('ENABLED', 'PILOT') and enabled_at is not null)
    or status in ('DISABLED', 'SETUP_REQUIRED')
  )
);

create trigger company_modules_set_updated_at
  before update on public.company_modules
  for each row execute function public.set_updated_at();

insert into public.module_catalog (key, name, description, category, sort_order) values
  ('core', 'Núcleo de personas', 'Identidad, empresas, membresías y configuración base.', 'Plataforma', 10),
  ('organization', 'Organización', 'Unidades, cargos, jefaturas y alcances organizacionales.', 'Personas', 20),
  ('attendance', 'Asistencia', 'Marcaciones, revisión diaria, períodos y exportaciones.', 'Operación', 30),
  ('licenses', 'Licencias', 'Ausencias y flujo de licencias médicas.', 'Personas', 40),
  ('documents', 'Documentos', 'Respaldo documental y acceso controlado a archivos.', 'Personas', 50),
  ('payroll', 'Nómina de pago', 'Maestro de proveedores y lotes de pago.', 'Finanzas', 60),
  ('meals', 'Colaciones', 'Gestión de formularios y descuentos de colaciones.', 'Beneficios', 70),
  ('expenses', 'Rendiciones', 'Rendiciones y reembolsos configurables por empresa.', 'Finanzas', 80),
  ('analytics', 'Analítica', 'Indicadores, reportes e historial de decisiones.', 'Inteligencia', 90),
  ('workera', 'Integración Workera', 'Importación externa de personas y marcaciones.', 'Integraciones', 100);

insert into public.permission_definitions (code, module_key, description) values
  ('company.view', 'core', 'Ver configuración general de la empresa.'),
  ('company.settings.manage', 'core', 'Administrar configuración general de la empresa.'),
  ('company.members.read', 'core', 'Ver miembros y roles de la empresa.'),
  ('company.members.manage', 'core', 'Invitar, activar y desactivar miembros.'),
  ('company.roles.manage', 'core', 'Crear roles y asignar permisos empresariales.'),
  ('modules.view', 'core', 'Ver módulos contratados y su estado.'),
  ('modules.manage', 'core', 'Administrar módulos y configuración versionada.'),
  ('organization.view', 'organization', 'Ver la estructura organizacional.'),
  ('organization.manage', 'organization', 'Administrar unidades, cargos y jefaturas.'),
  ('employees.read', 'core', 'Ver personas de la empresa.'),
  ('employees.write', 'core', 'Administrar personas de la empresa.'),
  ('attendance.read', 'attendance', 'Ver asistencia y sus resultados.'),
  ('attendance.manage', 'attendance', 'Gestionar incidencias y decisiones de asistencia.'),
  ('licenses.read', 'licenses', 'Ver ausencias y licencias autorizadas.'),
  ('licenses.manage', 'licenses', 'Registrar y administrar licencias.'),
  ('licenses.approve', 'licenses', 'Aprobar o rechazar licencias médicas.'),
  ('documents.read', 'documents', 'Ver metadatos y documentos permitidos.'),
  ('documents.manage', 'documents', 'Cargar y relacionar documentos.'),
  ('payroll.read', 'payroll', 'Ver lotes y maestro de pago.'),
  ('payroll.manage', 'payroll', 'Importar proveedores y generar lotes.'),
  ('meals.manage', 'meals', 'Administrar colaciones.'),
  ('expenses.manage', 'expenses', 'Administrar rendiciones.'),
  ('analytics.read', 'analytics', 'Ver indicadores y reportes.'),
  ('integrations.manage', 'workera', 'Configurar y operar integraciones de la empresa.'),
  ('audit.read', 'analytics', 'Ver auditoría de la empresa.');

-- ---------------------------------------------------------------------------
-- Invitaciones y onboarding. La invitación queda registrada aunque el envío
-- de correo todavía no esté conectado; nunca se simula que fue enviada.

create table public.company_invitations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  email        text not null,
  role_id      uuid not null,
  status       public.company_invitation_status not null default 'PENDING',
  expires_at   timestamptz not null default (now() + interval '7 days'),
  invited_by   uuid not null references public.profiles(id),
  accepted_by  uuid references public.profiles(id),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (company_id, role_id)
    references public.company_roles(company_id, id),
  constraint company_invitations_email_normalized_chk check (email = lower(trim(email))),
  constraint company_invitations_acceptance_chk check (
    (status = 'ACCEPTED' and accepted_by is not null and accepted_at is not null)
    or status <> 'ACCEPTED'
  )
);

create unique index company_invitations_pending_email_key
  on public.company_invitations (company_id, email)
  where status = 'PENDING';

create table public.onboarding_step_catalog (
  key          text primary key,
  name         text not null,
  description  text not null,
  sort_order   integer not null,
  active       boolean not null default true
);

create table public.company_onboarding_steps (
  company_id   uuid not null references public.companies(id) on delete cascade,
  step_key     text not null references public.onboarding_step_catalog(key),
  status       public.company_onboarding_status not null default 'NOT_STARTED',
  notes        text,
  completed_by uuid references public.profiles(id),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (company_id, step_key),
  constraint company_onboarding_steps_completion_chk check (
    (status = 'COMPLETE' and completed_at is not null)
    or status <> 'COMPLETE'
  )
);

create trigger company_onboarding_steps_set_updated_at
  before update on public.company_onboarding_steps
  for each row execute function public.set_updated_at();

insert into public.onboarding_step_catalog (key, name, description, sort_order) values
  ('company_profile', 'Ficha de empresa', 'Completar identificación, contacto y zona horaria.', 10),
  ('owner_access', 'Administrador cliente', 'Invitar y validar al responsable de la empresa.', 20),
  ('modules', 'Módulos', 'Definir módulos contratados y configuración inicial.', 30),
  ('organization', 'Organización', 'Crear estructura, cargos y responsables.', 40),
  ('people', 'Personas', 'Preparar importación y conciliación de trabajadores.', 50),
  ('security', 'Seguridad', 'Validar roles, permisos y pruebas de aislamiento.', 60),
  ('integration', 'Integraciones', 'Configurar fuentes externas sin compartir credenciales.', 70),
  ('go_live', 'Salida a producción', 'Aprobar checklist y habilitar el workspace.', 80);

-- ---------------------------------------------------------------------------
-- Raíces tenant mínimas para construir el organigrama correcto. Se conserva
-- un default ARCOTEX exclusivamente como compatibilidad temporal del código
-- operacional existente; workspace_enabled impide usarlo para otro cliente.

alter table public.employee_groups
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';
update public.employee_groups
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;
alter table public.employee_groups alter column company_id set not null;
alter table public.employee_groups
  add constraint employee_groups_company_id_id_key unique (company_id, id);
create index employee_groups_company_id_idx on public.employee_groups(company_id);

alter table public.employees
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';
update public.employees
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;
alter table public.employees alter column company_id set not null;
alter table public.employees
  add constraint employees_company_id_id_key unique (company_id, id),
  add constraint employees_company_group_fkey
    foreign key (company_id, employee_group_id)
    references public.employee_groups(company_id, id);
create index employees_company_id_active_idx on public.employees(company_id, active);

create table public.organization_units (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  parent_id   uuid,
  code        text not null,
  name        text not null,
  unit_type   public.organization_unit_type not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint organization_units_company_code_key unique (company_id, code),
  constraint organization_units_company_id_id_key unique (company_id, id),
  constraint organization_units_code_chk check (code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  foreign key (company_id, parent_id)
    references public.organization_units(company_id, id)
);

create trigger organization_units_set_updated_at
  before update on public.organization_units
  for each row execute function public.set_updated_at();

create table public.job_positions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null,
  title       text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint job_positions_company_code_key unique (company_id, code),
  constraint job_positions_company_id_id_key unique (company_id, id)
);

create trigger job_positions_set_updated_at
  before update on public.job_positions
  for each row execute function public.set_updated_at();

create table public.employee_org_assignments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null,
  org_unit_id   uuid not null,
  position_id   uuid,
  effective_from date not null,
  effective_to   date,
  is_primary     boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint employee_org_assignments_range_chk check (effective_to is null or effective_to >= effective_from),
  constraint employee_org_assignments_company_id_id_key unique (company_id, id),
  foreign key (company_id, employee_id)
    references public.employees(company_id, id),
  foreign key (company_id, org_unit_id)
    references public.organization_units(company_id, id),
  foreign key (company_id, position_id)
    references public.job_positions(company_id, id),
  exclude using gist (
    company_id with =,
    employee_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (is_primary)
);

create index employee_org_assignments_unit_idx
  on public.employee_org_assignments(company_id, org_unit_id);

create table public.organization_unit_leads (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  org_unit_id    uuid not null,
  employee_id    uuid not null,
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now(),
  constraint organization_unit_leads_range_chk check (effective_to is null or effective_to >= effective_from),
  foreign key (company_id, org_unit_id)
    references public.organization_units(company_id, id),
  foreign key (company_id, employee_id)
    references public.employees(company_id, id)
);

create table public.reporting_lines (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  employee_id           uuid not null,
  manager_employee_id   uuid not null,
  effective_from        date not null,
  effective_to          date,
  is_primary            boolean not null default true,
  created_at            timestamptz not null default now(),
  constraint reporting_lines_not_self_chk check (employee_id <> manager_employee_id),
  constraint reporting_lines_range_chk check (effective_to is null or effective_to >= effective_from),
  foreign key (company_id, employee_id)
    references public.employees(company_id, id),
  foreign key (company_id, manager_employee_id)
    references public.employees(company_id, id)
);

create table public.membership_org_scopes (
  company_id          uuid not null references public.companies(id) on delete cascade,
  membership_id       uuid not null,
  org_unit_id         uuid not null,
  include_descendants boolean not null default true,
  assigned_by         uuid references public.profiles(id),
  assigned_at         timestamptz not null default now(),
  primary key (company_id, membership_id, org_unit_id),
  foreign key (company_id, membership_id)
    references public.company_memberships(company_id, id) on delete cascade,
  foreign key (company_id, org_unit_id)
    references public.organization_units(company_id, id) on delete cascade
);

create or replace function public.prevent_organization_unit_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'Una unidad no puede ser su propio padre.' using errcode = '23514';
  end if;
  if exists (
    with recursive descendants as (
      select ou.id
      from public.organization_units ou
      where ou.company_id = new.company_id and ou.parent_id = new.id
      union all
      select child.id
      from public.organization_units child
      join descendants d on child.parent_id = d.id
      where child.company_id = new.company_id
    )
    select 1 from descendants where id = new.parent_id
  ) then
    raise exception 'La jerarquía organizacional no puede contener ciclos.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger organization_units_prevent_cycle
  before insert or update of parent_id on public.organization_units
  for each row execute function public.prevent_organization_unit_cycle();

-- ---------------------------------------------------------------------------
-- Helpers RBAC del control plane. Ninguno hereda privilegios desde
-- profiles.role; ese campo permanece solo como compatibilidad del workspace.

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
      and p.active
  );
$$;

create or replace function public.has_company_permission(p_company_id uuid, p_permission_code text)
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
      and p.active
      and crp.permission_code = p_permission_code
  );
$$;

create or replace function public.company_has_module(p_company_id uuid, p_module_key text)
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
  );
$$;

grant execute on function
  public.is_active_company_member(uuid),
  public.has_company_permission(uuid, text),
  public.company_has_module(uuid, text)
to authenticated;
revoke all on function
  public.is_active_company_member(uuid),
  public.has_company_permission(uuid, text),
  public.company_has_module(uuid, text)
from anon, public;

-- ---------------------------------------------------------------------------
-- Provisionamiento idempotente de defaults para cada cliente.

create or replace function public.provision_company_control_plane(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception 'Empresa inexistente.' using errcode = '23503';
  end if;

  insert into public.company_roles (company_id, code, name, description, base_role, is_system) values
    (p_company_id, 'COMPANY_OWNER', 'Administrador de empresa', 'Control completo dentro de la empresa, sin privilegios de plataforma.', 'SUPER_ADMIN', true),
    (p_company_id, 'HR_ADMIN', 'Administración RRHH', 'Gestión de personas y operaciones de RRHH.', 'ADMIN_RRHH', true),
    (p_company_id, 'PRODUCTION_SUPERVISOR', 'Supervisión Producción', 'Supervisión operacional con alcance de Producción.', 'SUPERVISOR_PRODUCTION', true),
    (p_company_id, 'INSTALLATION_SUPERVISOR', 'Supervisión Instalación', 'Supervisión operacional con alcance de Instalación.', 'SUPERVISOR_INSTALLATION', true),
    (p_company_id, 'AUDITOR', 'Auditor de solo lectura', 'Acceso de lectura definido por permisos, sin rol legacy.', null, true)
  on conflict (company_id, code) do nothing;

  insert into public.company_role_permissions (company_id, role_id, permission_code)
  select p_company_id, cr.id, pd.code
  from public.company_roles cr
  cross join public.permission_definitions pd
  where cr.company_id = p_company_id and cr.code = 'COMPANY_OWNER'
  on conflict do nothing;

  insert into public.company_role_permissions (company_id, role_id, permission_code)
  select p_company_id, cr.id, pd.code
  from public.company_roles cr
  join public.permission_definitions pd on pd.code in (
    'company.view', 'company.members.read', 'company.members.manage', 'modules.view',
    'organization.view', 'organization.manage', 'employees.read', 'employees.write',
    'attendance.read', 'attendance.manage', 'licenses.read', 'licenses.manage',
    'licenses.approve', 'documents.read', 'documents.manage', 'payroll.read',
    'payroll.manage', 'meals.manage', 'expenses.manage', 'analytics.read', 'audit.read'
  )
  where cr.company_id = p_company_id and cr.code = 'HR_ADMIN'
  on conflict do nothing;

  insert into public.company_role_permissions (company_id, role_id, permission_code)
  select p_company_id, cr.id, pd.code
  from public.company_roles cr
  join public.permission_definitions pd on pd.code in (
    'company.view', 'company.members.read', 'modules.view', 'organization.view',
    'employees.read', 'attendance.read', 'attendance.manage', 'licenses.read',
    'licenses.manage', 'documents.read', 'documents.manage', 'analytics.read'
  )
  where cr.company_id = p_company_id
    and cr.code in ('PRODUCTION_SUPERVISOR', 'INSTALLATION_SUPERVISOR')
  on conflict do nothing;

  insert into public.company_role_permissions (company_id, role_id, permission_code)
  select p_company_id, cr.id, pd.code
  from public.company_roles cr
  join public.permission_definitions pd on pd.code in (
    'company.view', 'company.members.read', 'modules.view', 'organization.view',
    'employees.read', 'attendance.read', 'licenses.read', 'documents.read',
    'analytics.read', 'audit.read'
  )
  where cr.company_id = p_company_id and cr.code = 'AUDITOR'
  on conflict do nothing;

  insert into public.company_modules (company_id, module_key, status)
  select p_company_id, mc.key,
    case when mc.key in ('core', 'organization')
      then 'SETUP_REQUIRED'::public.company_module_status
      else 'DISABLED'::public.company_module_status
    end
  from public.module_catalog mc
  where mc.active
  on conflict (company_id, module_key) do nothing;

  insert into public.company_onboarding_steps (company_id, step_key, status)
  select p_company_id, osc.key, 'NOT_STARTED'::public.company_onboarding_status
  from public.onboarding_step_catalog osc
  where osc.active
  on conflict (company_id, step_key) do nothing;

  insert into public.organization_units (company_id, code, name, unit_type, sort_order)
  select c.id, 'ROOT', c.name, 'COMPANY'::public.organization_unit_type, 0
  from public.companies c
  where c.id = p_company_id
  on conflict (company_id, code) do nothing;
end;
$$;

create or replace function public.provision_company_control_plane_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.provision_company_control_plane(new.id);
  return new;
end;
$$;

do $$
declare v_company_id uuid;
begin
  for v_company_id in select id from public.companies loop
    perform public.provision_company_control_plane(v_company_id);
  end loop;
end;
$$;

create trigger companies_provision_control_plane
  after insert on public.companies
  for each row execute function public.provision_company_control_plane_trigger();

-- ARCOTEX conserva exactamente los módulos ya implementados; los futuros no
-- se presentan como funcionalidad real.
update public.company_modules
set status = case
      when module_key in ('core', 'organization', 'attendance', 'licenses', 'documents', 'payroll', 'meals', 'analytics')
        then 'ENABLED'::public.company_module_status
      when module_key = 'workera' then 'SETUP_REQUIRED'::public.company_module_status
      else 'DISABLED'::public.company_module_status
    end,
    enabled_at = case
      when module_key in ('core', 'organization', 'attendance', 'licenses', 'documents', 'payroll', 'meals', 'analytics') then now()
      else null
    end
where company_id = '0a4c0000-0000-0000-0000-000000000001';

update public.company_onboarding_steps
set status = 'COMPLETE', completed_at = now()
where company_id = '0a4c0000-0000-0000-0000-000000000001';

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr
  on cr.company_id = cm.company_id
 and cr.code = case cm.role
   when 'SUPER_ADMIN' then 'COMPANY_OWNER'
   when 'ADMIN_RRHH' then 'HR_ADMIN'
   when 'SUPERVISOR_PRODUCTION' then 'PRODUCTION_SUPERVISOR'
   when 'SUPERVISOR_INSTALLATION' then 'INSTALLATION_SUPERVISOR'
 end
on conflict do nothing;

-- Organigrama inicial ARCOTEX: raíz + áreas operacionales existentes. Los
-- employee_groups siguen siendo clasificación de reglas; solo se usan para
-- el bootstrap, no se convierten en el árbol organizacional.
insert into public.organization_units (company_id, parent_id, code, name, unit_type, sort_order)
select eg.company_id, root.id, 'AREA_' || eg.code, eg.name, 'AREA', row_number() over (order by eg.name)::integer
from public.employee_groups eg
join public.organization_units root
  on root.company_id = eg.company_id and root.code = 'ROOT'
on conflict (company_id, code) do nothing;

insert into public.employee_org_assignments (
  company_id, employee_id, org_unit_id, effective_from, is_primary
)
select e.company_id, e.id, ou.id,
       coalesce((select min(ega.effective_from) from public.employee_group_assignments ega where ega.employee_id = e.id), current_date),
       true
from public.employees e
join public.employee_groups eg on eg.id = e.employee_group_id and eg.company_id = e.company_id
join public.organization_units ou on ou.company_id = e.company_id and ou.code = 'AREA_' || eg.code
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS del control plane y organización.

alter table public.module_catalog enable row level security;
alter table public.permission_definitions enable row level security;
alter table public.company_roles enable row level security;
alter table public.company_role_permissions enable row level security;
alter table public.company_membership_roles enable row level security;
alter table public.company_modules enable row level security;
alter table public.company_invitations enable row level security;
alter table public.onboarding_step_catalog enable row level security;
alter table public.company_onboarding_steps enable row level security;
alter table public.organization_units enable row level security;
alter table public.job_positions enable row level security;
alter table public.employee_org_assignments enable row level security;
alter table public.organization_unit_leads enable row level security;
alter table public.reporting_lines enable row level security;
alter table public.membership_org_scopes enable row level security;

create policy module_catalog_select on public.module_catalog
  for select to authenticated using (true);
create policy permission_definitions_select on public.permission_definitions
  for select to authenticated using (true);
create policy onboarding_step_catalog_select on public.onboarding_step_catalog
  for select to authenticated using (true);

create policy company_roles_select on public.company_roles
  for select to authenticated
  using (public.is_platform_admin() or public.is_active_company_member(company_id));
create policy company_roles_write on public.company_roles
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'company.roles.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'company.roles.manage'));

create policy company_role_permissions_select on public.company_role_permissions
  for select to authenticated
  using (public.is_platform_admin() or public.is_active_company_member(company_id));
create policy company_role_permissions_write on public.company_role_permissions
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'company.roles.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'company.roles.manage'));

create policy company_membership_roles_select on public.company_membership_roles
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.has_company_permission(company_id, 'company.members.read')
    or exists (
      select 1 from public.company_memberships cm
      where cm.id = membership_id and cm.user_id = auth.uid()
    )
  );
create policy company_membership_roles_write on public.company_membership_roles
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'));

create policy company_modules_select on public.company_modules
  for select to authenticated
  using (public.is_platform_admin() or public.is_active_company_member(company_id));
create policy company_modules_write on public.company_modules
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'modules.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'modules.manage'));

create policy company_invitations_select on public.company_invitations
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'company.members.read'));
create policy company_invitations_write on public.company_invitations
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'))
  with check (
    (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'))
    and invited_by = auth.uid()
  );

create policy company_onboarding_steps_select on public.company_onboarding_steps
  for select to authenticated
  using (public.is_platform_admin() or public.is_active_company_member(company_id));
create policy company_onboarding_steps_write on public.company_onboarding_steps
  for all to authenticated
  using (public.can_manage_platform())
  with check (public.can_manage_platform());

create policy organization_units_select on public.organization_units
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'organization.view'));
create policy organization_units_write on public.organization_units
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'));

create policy job_positions_select on public.job_positions
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'organization.view'));
create policy job_positions_write on public.job_positions
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'));

create policy employee_org_assignments_select on public.employee_org_assignments
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'organization.view'));
create policy employee_org_assignments_write on public.employee_org_assignments
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'));

create policy organization_unit_leads_select on public.organization_unit_leads
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'organization.view'));
create policy organization_unit_leads_write on public.organization_unit_leads
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'));

create policy reporting_lines_select on public.reporting_lines
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'organization.view'));
create policy reporting_lines_write on public.reporting_lines
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'organization.manage'));

create policy membership_org_scopes_select on public.membership_org_scopes
  for select to authenticated
  using (public.is_platform_admin() or public.has_company_permission(company_id, 'company.members.read'));
create policy membership_org_scopes_write on public.membership_org_scopes
  for all to authenticated
  using (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'))
  with check (public.can_manage_platform() or public.has_company_permission(company_id, 'company.members.manage'));

-- Gestión de membresías por permiso empresarial, además del control plane.
create policy company_memberships_select_company_admin on public.company_memberships
  for select to authenticated
  using (public.has_company_permission(company_id, 'company.members.read'));
create policy company_memberships_insert_company_admin on public.company_memberships
  for insert to authenticated
  with check (public.has_company_permission(company_id, 'company.members.manage'));
create policy company_memberships_update_company_admin on public.company_memberships
  for update to authenticated
  using (public.has_company_permission(company_id, 'company.members.manage'))
  with check (public.has_company_permission(company_id, 'company.members.manage'));

-- ---------------------------------------------------------------------------
-- Auditoría del control plane y proyección agregada del portafolio. El RPC
-- expone conteos, nunca nómina, datos médicos, documentos ni datos bancarios.

create table public.platform_audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid not null references public.profiles(id),
  company_id   uuid references public.companies(id),
  action       text not null,
  target_type  text not null,
  target_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint platform_audit_log_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);

alter table public.platform_audit_log enable row level security;
create policy platform_audit_log_select on public.platform_audit_log
  for select to authenticated using (public.is_platform_admin());
create policy platform_audit_log_insert on public.platform_audit_log
  for insert to authenticated
  with check (public.is_platform_admin() and actor_id = auth.uid());

create or replace function public.platform_company_portfolio()
returns table (
  company_id uuid,
  name text,
  slug text,
  legal_name text,
  status public.company_lifecycle_status,
  workspace_enabled boolean,
  plan_code text,
  created_at timestamptz,
  total_members bigint,
  active_members bigint,
  enabled_modules bigint,
  available_modules bigint,
  completed_steps bigint,
  total_steps bigint,
  next_step_label text,
  employee_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Acceso exclusivo del control plane.' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.name,
    c.slug,
    c.legal_name,
    c.status,
    c.workspace_enabled,
    c.plan_code,
    c.created_at,
    (select count(*) from public.company_memberships cm where cm.company_id = c.id),
    (select count(*) from public.company_memberships cm where cm.company_id = c.id and cm.active),
    (select count(*) from public.company_modules m where m.company_id = c.id and m.status in ('ENABLED', 'PILOT')),
    (select count(*) from public.company_modules m where m.company_id = c.id),
    (select count(*) from public.company_onboarding_steps os where os.company_id = c.id and os.status = 'COMPLETE'),
    (select count(*) from public.company_onboarding_steps os where os.company_id = c.id),
    (
      select osc.name
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key
      where os.company_id = c.id and os.status <> 'COMPLETE'
      order by osc.sort_order
      limit 1
    ),
    (select count(*) from public.employees e where e.company_id = c.id and e.active)
  from public.companies c
  order by c.created_at desc, c.name, c.id;
end;
$$;

grant execute on function public.platform_company_portfolio() to authenticated;
revoke all on function public.platform_company_portfolio() from anon, public;

-- Grants: RLS sigue siendo la autoridad real.
revoke all on table
  public.platform_memberships,
  public.module_catalog,
  public.permission_definitions,
  public.company_roles,
  public.company_role_permissions,
  public.company_membership_roles,
  public.company_modules,
  public.company_invitations,
  public.onboarding_step_catalog,
  public.company_onboarding_steps,
  public.organization_units,
  public.job_positions,
  public.employee_org_assignments,
  public.organization_unit_leads,
  public.reporting_lines,
  public.membership_org_scopes,
  public.platform_audit_log
from anon, public;

grant select, insert, update on public.companies to authenticated;
grant select, insert, update on public.company_memberships to authenticated;
grant select, insert, update on public.platform_memberships to authenticated;
grant select on public.module_catalog, public.permission_definitions, public.onboarding_step_catalog to authenticated;
grant select, insert, update, delete on
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
  public.membership_org_scopes
to authenticated;
grant select, insert on public.platform_audit_log to authenticated;

comment on table public.company_roles is
  'Roles extensibles por empresa. base_role mantiene compatibilidad temporal con el workspace ARCOTEX; la autoridad objetivo son company_role_permissions.';
comment on table public.company_modules is
  'Entitlements/configuración versionada por empresa. Ocultar navegación nunca sustituye la validación backend del módulo.';
comment on table public.organization_units is
  'Jerarquía organizacional real. employee_groups permanece separado como clasificación para reglas laborales.';
comment on table public.platform_audit_log is
  'Auditoría de acciones del control plane; no reemplaza audit_log de cada dominio/empresa.';

-- Supabase define EXECUTE explícito para anon/authenticated sobre funciones
-- nuevas. Revocar solo PUBLIC no basta cuando ya existe ese ACL explícito.
-- Se cierran tanto las funciones internas de esta migración como dos helpers
-- históricos cuyo lockdown incompleto aparece al reconstruir la base desde
-- cero. El pipeline conserva únicamente el permiso service_role que necesita.
revoke all on function
  public.prevent_last_platform_owner_removal(),
  public.prevent_organization_unit_cycle(),
  public.provision_company_control_plane(uuid),
  public.provision_company_control_plane_trigger()
from anon, authenticated, public;

revoke all on function
  public.recompute_employee_daily_bonus(uuid, date),
  public.reclaim_stale_workera_sync_runs(integer)
from anon, authenticated, public;
grant execute on function public.reclaim_stale_workera_sync_runs(integer) to service_role;

-- El evento crudo Workera es append/version-only también para service_role;
-- un grant por defecto no debe reintroducir DELETE/TRUNCATE.
revoke all on table public.workera_attendance_events from service_role;
grant select, insert, update on table public.workera_attendance_events to service_role;
