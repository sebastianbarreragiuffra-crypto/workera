-- GESTORA MT-3A -- proyección agregada y privada del organigrama.
--
-- El control plane necesita estructura y conteos, no filas que vinculen
-- personas concretas con unidades. Esta proyección evita el límite de 1.000
-- filas de PostgREST y reduce la exposición de identificadores laborales.

drop policy if exists employee_org_assignments_select on public.employee_org_assignments;
drop policy if exists employee_org_assignments_write on public.employee_org_assignments;
drop policy if exists organization_unit_leads_select on public.organization_unit_leads;
drop policy if exists organization_unit_leads_write on public.organization_unit_leads;
drop policy if exists reporting_lines_select on public.reporting_lines;
drop policy if exists reporting_lines_write on public.reporting_lines;

create policy employee_org_assignments_select on public.employee_org_assignments
  for select to authenticated
  using (public.has_company_permission(company_id, 'organization.view'));
create policy employee_org_assignments_write on public.employee_org_assignments
  for all to authenticated
  using (public.has_company_permission(company_id, 'organization.manage'))
  with check (public.has_company_permission(company_id, 'organization.manage'));

create policy organization_unit_leads_select on public.organization_unit_leads
  for select to authenticated
  using (public.has_company_permission(company_id, 'organization.view'));
create policy organization_unit_leads_write on public.organization_unit_leads
  for all to authenticated
  using (public.has_company_permission(company_id, 'organization.manage'))
  with check (public.has_company_permission(company_id, 'organization.manage'));

create policy reporting_lines_select on public.reporting_lines
  for select to authenticated
  using (public.has_company_permission(company_id, 'organization.view'));
create policy reporting_lines_write on public.reporting_lines
  for all to authenticated
  using (public.has_company_permission(company_id, 'organization.manage'))
  with check (public.has_company_permission(company_id, 'organization.manage'));

create or replace function public.platform_company_organization(p_company_id uuid)
returns table (
  unit_id uuid,
  parent_id uuid,
  name text,
  unit_type public.organization_unit_type,
  sort_order integer,
  direct_member_count bigint,
  has_leader boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_effective_date date;
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'Acceso exclusivo del control plane.' using errcode = '42501';
  end if;

  select pg_catalog.timezone(c.timezone, pg_catalog.transaction_timestamp())::date
    into v_effective_date
  from public.companies c
  where c.id = p_company_id;

  if not found then
    raise exception 'Empresa inexistente.' using errcode = '23503';
  end if;

  return query
  select
    ou.id,
    ou.parent_id,
    ou.name,
    ou.unit_type,
    ou.sort_order,
    (
      select count(distinct eoa.employee_id)
      from public.employee_org_assignments eoa
      join public.employees e
        on e.company_id = eoa.company_id and e.id = eoa.employee_id
      where eoa.company_id = ou.company_id
        and eoa.org_unit_id = ou.id
        and eoa.is_primary
        and eoa.effective_from <= v_effective_date
        and (eoa.effective_to is null or eoa.effective_to >= v_effective_date)
        and e.active
    ),
    exists (
      select 1
      from public.organization_unit_leads oul
      join public.employees leader
        on leader.company_id = oul.company_id and leader.id = oul.employee_id
      where oul.company_id = ou.company_id
        and oul.org_unit_id = ou.id
        and oul.effective_from <= v_effective_date
        and (oul.effective_to is null or oul.effective_to >= v_effective_date)
        and leader.active
    )
  from public.organization_units ou
  where ou.company_id = p_company_id
    and ou.active
  order by ou.sort_order, ou.name;
end;
$$;

comment on function public.platform_company_organization(uuid) is
  'Proyección agregada del organigrama para el control plane. No devuelve employee_id, nombres de trabajadores ni líneas de reporte.';

revoke all on function public.platform_company_organization(uuid)
  from public, anon, authenticated;
grant execute on function public.platform_company_organization(uuid)
  to authenticated;
