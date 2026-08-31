-- GESTORA — fundación de multi-tenancy (MT-1 + MT-2, alcance MÍNIMO seguro).
--
-- Esta migración es PURAMENTE ADITIVA:
--   - crea 2 tablas nuevas (companies, company_memberships)
--   - NO agrega columnas a ninguna tabla existente
--   - NO modifica ninguna policy RLS existente
--   - NO modifica ningún trigger/función existente
--   - bootstrapea ARCOTEX como companies(id=... , slug='arcotex') y crea
--     una company_membership derivada de cada profiles.role actual
--     (capa de compatibilidad, PASO 6 del encargo: "Current global profile
--     roles may remain temporarily through a compatibility layer")
--
-- Por qué esto y no más en esta pasada: el comité (ver
-- GESTORA_MULTI_TENANT_FOUNDATION_REPORT, sección D/N) concluyó que
-- reescribir RLS de las ~30 tablas de negocio, resolver las 4 unique
-- constraints globales que colisionarían entre tenants
-- (employees.external_workera_id, employees.rut, employee_groups.code,
-- suppliers.normalized_name), y rediseñar profiles/authorized_email_roles
-- para ser company-aware, es un cambio de alto riesgo sobre un sistema con
-- datos reales de asistencia/nómina/licencias médicas -- eso requiere una
-- fase propia con su propia revisión (MT-3 en adelante), no esta migración.
-- Esta fase solo prueba que el modelo de datos objetivo (companies +
-- memberships + resolver) es viable sin tocar nada que ya funciona.

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint companies_slug_key unique (slug)
);

comment on table public.companies is
  'GESTORA -- catálogo de empresas/tenants. Tabla GLOBAL_PLATFORM (no tiene '
  'company_id, ES la raíz de company_id). Población vía migración/gestión de '
  'plataforma únicamente en esta fase -- sin policy de INSERT/UPDATE/DELETE '
  'para `authenticated` todavía (deny-by-default real).';

alter table public.companies enable row level security;
revoke all on public.companies from anon, public;
grant select on public.companies to authenticated;
-- La policy real (companies_select_member) se crea MÁS ABAJO, después de
-- company_memberships (referencia esa tabla en su USING -- debe existir
-- primero). Hasta entonces companies queda deny-by-default (RLS habilitada,
-- sin policy = ninguna fila visible para `authenticated`).

create table public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id),
  company_id  uuid not null references public.companies(id),
  role        public.app_role not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint company_memberships_user_company_key unique (user_id, company_id)
);

comment on table public.company_memberships is
  'GESTORA -- membresía de un usuario en una empresa, con su rol DENTRO de '
  'esa empresa. Reutiliza `public.app_role` (SUPER_ADMIN/ADMIN_RRHH/'
  'SUPERVISOR_*) como capa de compatibilidad -- NO se crea un enum nuevo '
  'todavía (encargo Fase 1, sección 6). `role` acá es el modelo OBJETIVO; '
  '`profiles.role` sigue siendo el modelo ACTIVO real hasta que una fase '
  'futura (MT-3+) rehaga la autorización de la aplicación para leer desde '
  'acá. Esta tabla NO está conectada a ningún gate de autorización real '
  'todavía -- ver resolveActiveCompany() en src/lib/tenant/, que la lee '
  'pero no la usa desde ninguna página/Server Action existente.';

alter table public.company_memberships enable row level security;
revoke all on public.company_memberships from anon, public;
grant select on public.company_memberships to authenticated;
-- Un usuario ve SOLO sus propias membresías -- nunca las de otro usuario ni
-- de otra empresa (impide enumerar quién trabaja en qué tenant).
create policy company_memberships_select_own on public.company_memberships
  for select
  to authenticated
  using (user_id = auth.uid());
-- Sin policy de INSERT/UPDATE/DELETE para `authenticated`: la gestión de
-- membresías es de plataforma en esta fase (deny-by-default), igual
-- criterio que authorized_email_roles.

create index company_memberships_company_id_idx on public.company_memberships (company_id);
create index company_memberships_user_id_idx on public.company_memberships (user_id);

-- SELECT amplio para `authenticated`: necesario para que el resolver de
-- tenant (SECURITY DEFINER, ver función más abajo) pueda validar
-- membresías, y para que un futuro selector de compañía muestre nombre/slug
-- de las empresas donde el usuario SÍ es miembro (nunca las demás -- eso lo
-- filtra la query de la aplicación via company_memberships, no esta policy;
-- documentado como riesgo pendiente en el reporte del comité, sección H).
create policy companies_select_member on public.companies
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = companies.id
        and cm.user_id = auth.uid()
        and cm.active
    )
  );

-- ---------------------------------------------------------------------------
-- Resolver de tenant activo (SECURITY DEFINER, mismo patrón que
-- current_user_role() -- necesario para que RLS de company_memberships no
-- se auto-referencie en un ciclo al evaluarse desde otra policy futura).
-- Devuelve NULL si el usuario no tiene ninguna membresía activa: "0
-- memberships -> access denied" (encargo sección 7) se decide en la
-- aplicación a partir de este NULL, nunca aquí.
create or replace function public.active_company_memberships()
returns setof public.company_memberships
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from public.company_memberships
  where user_id = auth.uid()
    and active
    and exists (
      select 1 from public.companies c
      where c.id = company_memberships.company_id and c.active
    );
$$;

comment on function public.active_company_memberships() is
  'GESTORA -- membresías activas del usuario actual, en empresas activas. '
  'Fuente para el resolver de tenant en la aplicación '
  '(src/lib/tenant/resolve-active-company.ts). NO se usa todavía desde '
  'ninguna policy RLS de las tablas de negocio existentes -- eso es MT-3+.';

grant execute on function public.active_company_memberships() to authenticated;
revoke all on function public.active_company_memberships() from anon, public;

-- ---------------------------------------------------------------------------
-- Bootstrap: ARCOTEX = tenant 1. Slug fijo y predecible (nunca aleatorio)
-- para que el resolver de la aplicación pueda referenciarlo de forma
-- estable si hace falta durante la migración de compatibilidad.
insert into public.companies (id, name, slug, active)
values ('0a4c0000-0000-0000-0000-000000000001', 'ARCOTEX', 'arcotex', true)
on conflict (slug) do nothing;

-- Cada profile EXISTENTE recibe una membresía en ARCOTEX con su rol actual
-- -- ningún dato de negocio (employees/attendance/etc.) se toca; esto solo
-- puebla la tabla de compatibilidad nueva. Idempotente (ON CONFLICT).
insert into public.company_memberships (user_id, company_id, role, active)
select p.id, c.id, p.role, p.active
from public.profiles p
cross join (select id from public.companies where slug = 'arcotex') c
where p.role is not null
on conflict (user_id, company_id) do update set role = excluded.role, active = excluded.active;
