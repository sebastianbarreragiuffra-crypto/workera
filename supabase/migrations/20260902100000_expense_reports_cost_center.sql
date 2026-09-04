-- GESTORA Rendiciones (centro de costo): conecta expense_reports.organization_unit_id
-- -- columna que ya existe desde EX-1 (20260901190000) y ya estaba en el
-- GRANT UPDATE de authenticated sobre expense_reports, pero nunca se pudo
-- usar desde la UI -- con el árbol organizacional real de la empresa.
--
-- El motivo por el que quedó sin usar: organization_units (MT-3A,
-- 20260901120000) solo es legible con el permiso de control plane
-- 'organization.view', que provision_expense_role_permissions() (EX-1)
-- nunca otorga -- un rol de Rendiciones puro (ej. PRODUCTION_SUPERVISOR con
-- solo expenses.submit) no puede ver la lista de unidades organizacionales
-- para elegir una al crear su rendición, aunque la columna que la
-- referencia sí sea suya para escribir.
--
-- Corrección mínima y de solo lectura: se agrega una condición adicional a
-- organization_units_select para que expenses.submit/expenses.manage
-- también concedan visibilidad -- nunca escritura (organization_units_write
-- no se toca) y nunca las tablas hermanas (job_positions,
-- employee_org_assignments, etc., que sí pueden llevar datos laborales
-- reales). organization_units en sí misma no contiene PII ni dato laboral
-- -- es solo id/company_id/parent_id/code/name/unit_type/active/sort_order,
-- el árbol de centros de costo, no personas asignadas a él.
drop policy if exists organization_units_select on public.organization_units;
create policy organization_units_select on public.organization_units
  for select to authenticated
  using (
    public.is_platform_admin()
    or public.has_company_permission(company_id, 'organization.view')
    or (
      public.company_has_module(company_id, 'expenses')
      and (public.has_company_permission(company_id, 'expenses.submit') or public.has_company_permission(company_id, 'expenses.manage'))
    )
  );

comment on policy organization_units_select on public.organization_units is
  'Lectura para control plane (organization.view/platform admin) MÁS, desde '
  'Rendiciones, cualquiera con expenses.submit/expenses.manage en una '
  'empresa con el módulo activo -- para poder etiquetar una rendición con '
  'centro de costo. Nunca escritura: organization_units_write sigue exigiendo '
  'organization.manage exclusivamente.';
