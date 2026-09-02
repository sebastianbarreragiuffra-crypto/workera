-- GESTORA MT-3B (recorte 1 de 1): capa de autorización consciente de empresa
-- para employees/employee_groups -- las dos únicas raíces laborales que ya
-- tienen company_id (agregado transicionalmente en MT-3A,
-- 20260901120000_platform_control_plane.sql).
--
-- Hallazgo: is_corporate_user()/is_admin_rrhh()/is_privileged_admin() y las
-- policies que los usan sobre employees, employee_groups y sus tablas de
-- asignación (employee_group_assignments, schedule_assignments,
-- supervisor_assignments) autorizan HOY solo por rol global, sin ningún
-- filtro de company_id -- cualquier corporativo puede leer/escribir
-- empleados de CUALQUIER empresa. Es inofensivo mientras ARCOTEX sea la
-- única empresa operativa, pero es exactamente el hueco que el gate de la
-- sección 4 de docs/PLATFORM_MULTI_COMPANY.md exige cerrar antes de
-- habilitar el workspace laboral de una segunda empresa.
--
-- El resto del dominio laboral (asistencia, horas extra, ausencias,
-- documentos, períodos, nómina, licencias médicas, colaciones, feriados,
-- catálogos) queda fuera de este recorte: ninguna de esas tablas tiene
-- company_id todavía, así que no hay nada que filtrar ahí -- vendrán en
-- migraciones separadas y pequeñas, por dominio, tal como exige el punto 2
-- de la sección 7 del roadmap.

-- ---------------------------------------------------------------------------
-- 1. company_memberships llevaba desde el bootstrap de MT-3A
--    (20260901100000_gestora_tenant_foundation.sql) sin sincronizarse: ese
--    insert fue un snapshot único de profiles.role/active en ese momento, y
--    assignRole() (src/lib/admin/user-management.ts) solo escribe
--    profiles.role desde entonces -- nunca company_memberships. Cualquier
--    cambio de rol posterior a ese bootstrap dejó company_memberships
--    desactualizado. Se corrige el drift acumulado y se agrega un trigger
--    para que profiles siga siendo la única fuente que RRHH edita, sin que
--    company_memberships se desincronice otra vez.
--
--    Esto es explícitamente un puente de compatibilidad, no el modelo
--    objetivo: profiles.role representa hoy únicamente el workspace ARCOTEX
--    (ver README, sección "Estado actual resumido" y
--    docs/PLATFORM_MULTI_COMPANY.md sección 6). Una empresa nueva NO deberá
--    heredar roles vía profiles.role -- usará company_role_permissions,
--    igual que ya hace Rendiciones.
insert into public.company_memberships (user_id, company_id, role, active)
select p.id, c.id, p.role, true
from public.profiles p
cross join (select id from public.companies where slug = 'arcotex') c
where p.role is not null and p.active
on conflict (user_id, company_id) do update set role = excluded.role, active = true;

update public.company_memberships cm
set active = false
from public.profiles p
cross join (select id from public.companies where slug = 'arcotex') c
where cm.user_id = p.id and cm.company_id = c.id
  and (p.role is null or not p.active) and cm.active;

create or replace function public.sync_arcotex_company_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_arcotex_id uuid;
begin
  select id into v_arcotex_id from public.companies where slug = 'arcotex';
  if v_arcotex_id is null then return new; end if;

  if new.role is not null and new.active then
    insert into public.company_memberships (user_id, company_id, role, active)
    values (new.id, v_arcotex_id, new.role, true)
    on conflict (user_id, company_id) do update set role = excluded.role, active = true;
  else
    update public.company_memberships
    set active = false
    where user_id = new.id and company_id = v_arcotex_id and active;
  end if;
  return new;
end;
$$;

comment on function public.sync_arcotex_company_membership() is
  'Puente de compatibilidad: mientras profiles.role siga siendo la fuente '
  'real de roles del workspace ARCOTEX, mantiene su reflejo en '
  'company_memberships al día en cada INSERT/UPDATE, para que '
  'is_active_company_member() nunca quede desincronizado de un cambio hecho '
  'por assignRole(). No aplica a ninguna empresa que no sea ARCOTEX.';

revoke all on function public.sync_arcotex_company_membership() from public, anon, authenticated;

create trigger profiles_sync_arcotex_membership
  after insert or update of role, active on public.profiles
  for each row execute function public.sync_arcotex_company_membership();

-- ---------------------------------------------------------------------------
-- 2. Helper para las tablas de asignación (employee_group_assignments,
--    schedule_assignments, supervisor_assignments): no tienen company_id
--    propio todavía, solo employee_id -- se resuelve la empresa real del
--    trabajador y se exige membresía activa ahí.
create or replace function public.employee_belongs_to_active_company(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and public.is_active_company_member(e.company_id)
  );
$$;

comment on function public.employee_belongs_to_active_company(uuid) is
  'true si el usuario actual es miembro activo de la empresa DUEÑA de este '
  'trabajador específico -- is_corporate_user()/is_admin_rrhh() por sí solos '
  'no distinguen de qué empresa es el dato, esta función sí.';

revoke all on function public.employee_belongs_to_active_company(uuid) from public, anon;
grant execute on function public.employee_belongs_to_active_company(uuid) to authenticated;

-- can_manage_employee(): mismo criterio interno de siempre (admin
-- privilegiado, o supervisor cuyo grupo coincide con el grupo vigente del
-- trabajador), ahora exigiendo ADEMÁS pertenencia activa a la empresa real
-- del trabajador -- se propaga automáticamente a todo lo que ya compone
-- sobre esta función (attendance_status_records, absence_records, etc.),
-- sin tocar esas tablas.
create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.employee_belongs_to_active_company(p_employee_id)
    and (
      public.is_privileged_admin()
      or exists (
        select 1
        from public.employees e
        join public.employee_groups eg on eg.id = e.employee_group_id
        where e.id = p_employee_id
          and (
            (eg.code = 'PRODUCTION' and public.is_supervisor_production())
            or (eg.code = 'INSTALLATION' and public.is_supervisor_installation())
          )
      )
    );
$$;

comment on function public.can_manage_employee(uuid) is
  'true si el usuario actual puede escribir sobre este trabajador Y además '
  'es miembro activo de la empresa real dueña del registro (MT-3B): '
  'SUPER_ADMIN/ADMIN_RRHH siempre que pertenezcan a esa empresa, o el '
  'supervisor cuyo grupo coincide con el employee_group ACTUAL del '
  'trabajador, también sujeto a esa misma pertenencia.';

-- ---------------------------------------------------------------------------
-- 3. RLS: agrega el filtro de empresa a las policies existentes de
--    employees/employee_groups y sus tablas de asignación, sin tocar el
--    criterio de rol que ya tenían.
drop policy employees_select on public.employees;
create policy employees_select on public.employees
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

drop policy employees_write_admin on public.employees;
create policy employees_write_admin on public.employees
  for all to authenticated
  using (public.is_privileged_admin() and public.is_active_company_member(company_id))
  with check (public.is_privileged_admin() and public.is_active_company_member(company_id));

drop policy employee_groups_select on public.employee_groups;
create policy employee_groups_select on public.employee_groups
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

drop policy employee_group_assignments_select on public.employee_group_assignments;
create policy employee_group_assignments_select on public.employee_group_assignments
  for select to authenticated
  using (public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id));

drop policy employee_group_assignments_write_admin on public.employee_group_assignments;
create policy employee_group_assignments_write_admin on public.employee_group_assignments
  for all to authenticated
  using (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id));

drop policy schedule_assignments_select on public.schedule_assignments;
create policy schedule_assignments_select on public.schedule_assignments
  for select to authenticated
  using (public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id));

drop policy schedule_assignments_write_admin on public.schedule_assignments;
create policy schedule_assignments_write_admin on public.schedule_assignments
  for all to authenticated
  using (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id));

drop policy supervisor_assignments_select on public.supervisor_assignments;
create policy supervisor_assignments_select on public.supervisor_assignments
  for select to authenticated
  using (public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id));

drop policy supervisor_assignments_write_admin on public.supervisor_assignments;
create policy supervisor_assignments_write_admin on public.supervisor_assignments
  for all to authenticated
  using (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id));
