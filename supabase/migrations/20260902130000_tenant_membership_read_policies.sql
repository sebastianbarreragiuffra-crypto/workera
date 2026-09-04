-- MT-3B: las lecturas del pipeline Workera y sus políticas operacionales
-- deben autorizarse por la membresía/permiso de la empresa dueña, no por el
-- rol legacy global de profiles. Un usuario de un tenant nuevo puede tener
-- profiles.role = null y aun así ser HR_ADMIN válido mediante el control
-- plane de esa empresa.

-- La bitácora técnica de sincronización/motor no forma parte de la
-- asistencia operativa que ven supervisores y auditores. Mantenerla bajo
-- attendance.read expondría reintentos y error_summary innecesariamente.
insert into public.permission_definitions (code, module_key, description)
values (
  'attendance.sync.read',
  'attendance',
  'Ver el estado técnico de sincronizaciones y corridas del motor de reglas.'
)
on conflict (code) do update
set module_key = excluded.module_key,
    description = excluded.description;

-- Empresas/roles existentes.
insert into public.company_role_permissions (company_id, role_id, permission_code)
select cr.company_id, cr.id, 'attendance.sync.read'
from public.company_roles cr
where cr.code in ('COMPANY_OWNER', 'HR_ADMIN')
on conflict do nothing;

-- Empresas creadas después de esta migración: COMPANY_OWNER ya recibe el
-- catálogo completo desde provision_company_control_plane(); este trigger
-- cubre además HR_ADMIN sin redefinir esa función core por cada permiso
-- específico que agregue un módulo.
create or replace function public.provision_attendance_sync_read_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.code in ('COMPANY_OWNER', 'HR_ADMIN') then
    insert into public.company_role_permissions (company_id, role_id, permission_code)
    values (new.company_id, new.id, 'attendance.sync.read')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.provision_attendance_sync_read_permission() from public, anon, authenticated;

create trigger company_roles_provision_attendance_sync_read
  after insert on public.company_roles
  for each row execute function public.provision_attendance_sync_read_permission();

create or replace function public.has_employee_group_company_permission(
  p_employee_group_id uuid,
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
    from public.employee_groups eg
    where eg.id = p_employee_group_id
      and public.has_company_permission(eg.company_id, p_permission_code)
  );
$$;

revoke all on function public.has_employee_group_company_permission(uuid, text) from public, anon;
grant execute on function public.has_employee_group_company_permission(uuid, text) to authenticated;

drop policy if exists sync_runs_select_admin on public.sync_runs;
create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.sync.read')
  );

drop policy if exists rule_engine_runs_select on public.rule_engine_runs;
create policy rule_engine_runs_select on public.rule_engine_runs
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.sync.read')
  );

drop policy if exists workera_attendance_events_select on public.workera_attendance_events;
create policy workera_attendance_events_select on public.workera_attendance_events
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.read')
  );

drop policy if exists overtime_policies_select on public.overtime_policies;
create policy overtime_policies_select on public.overtime_policies
  for select to authenticated using (
    public.has_employee_group_company_permission(employee_group_id, 'attendance.read')
  );

drop policy if exists late_arrival_policies_select on public.late_arrival_policies;
create policy late_arrival_policies_select on public.late_arrival_policies
  for select to authenticated using (
    public.has_employee_group_company_permission(employee_group_id, 'attendance.read')
  );
