-- GESTORA MT-3B (recorte 2, parte 1: núcleo de asistencia) — cierra el hueco
-- que 20260902050000_labor_domain_authorization_company_scope.sql dejó
-- explícito en su propio encabezado: employees/employee_groups ya filtran
-- por empresa, pero attendance_records, attendance_corrections,
-- attendance_status_records y attendance_missing_punch_flags seguían
-- autorizando solo por rol global (is_corporate_user()/is_admin_rrhh()), sin
-- ningún filtro de company_id -- cualquier corporativo podía leer/escribir
-- asistencia de CUALQUIER empresa.
--
-- Ninguna de estas cuatro tablas necesita una columna company_id propia: ya
-- tienen employee_id (o, en attendance_missing_punch_flags, lo tienen
-- directo), y employees.company_id ya existe desde MT-3A -- el mismo criterio
-- que recorte 1 usó para employee_group_assignments/schedule_assignments/
-- supervisor_assignments. Se reutiliza employee_belongs_to_active_company(),
-- ya definida en recorte 1, sin duplicar lógica de resolución de tenant.
--
-- Tampoco hay riesgo de colisión de claves entre empresas: todas las claves
-- únicas de estas tablas (attendance_records_version_key,
-- attendance_status_records_version_key,
-- attendance_missing_punch_flags_record_key) están ancladas en employee_id o
-- en una FK hacia una fila ya propia de un employee_id -- un employee_id
-- pertenece siempre a una sola empresa, así que no hace falta componer la
-- clave con company_id.
--
-- Fuera de este recorte, deliberadamente: horas extra, atrasos, salidas
-- anticipadas, ausencias, horarios/turnos, motor de reglas y sincronización
-- Workera -- cada uno vendrá en su propia migración pequeña, tal como exige
-- el punto 2 de la sección 7 del roadmap (docs/PLATFORM_MULTI_COMPANY.md).

-- ---------------------------------------------------------------------------
-- attendance_records: agrega el filtro de empresa a la única policy que
-- tenía (SELECT). No hay policies de escritura para `authenticated` que
-- tocar -- el hecho crudo de Workera solo lo escribe service_role.
drop policy if exists attendance_records_select on public.attendance_records;
create policy attendance_records_select on public.attendance_records
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_belongs_to_active_company(employee_id)
  );

-- ---------------------------------------------------------------------------
-- attendance_corrections: SELECT y el UPDATE administrativo (ADMIN_RRHH)
-- necesitan el filtro -- el INSERT ya lo hereda de can_manage_employee(), que
-- recorte 1 dejó company-aware.
drop policy if exists attendance_corrections_select on public.attendance_corrections;
create policy attendance_corrections_select on public.attendance_corrections
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists attendance_corrections_update_admin on public.attendance_corrections;
create policy attendance_corrections_update_admin on public.attendance_corrections
  for update to authenticated
  using (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id));

-- ---------------------------------------------------------------------------
-- attendance_status_records: SELECT, la rama no-manual del INSERT (hoy en la
-- práctica la usa el futuro sync con service_role, que bypassea RLS; esta
-- rama cubre a un ADMIN_RRHH forzando un registro fuera del flujo automático)
-- y el UPDATE administrativo. La rama manual ya hereda el filtro de
-- can_manage_employee().
drop policy if exists attendance_status_records_select on public.attendance_status_records;
create policy attendance_status_records_select on public.attendance_status_records
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists attendance_status_records_insert on public.attendance_status_records;
create policy attendance_status_records_insert on public.attendance_status_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id)
    end
  );

drop policy if exists attendance_status_records_update_admin on public.attendance_status_records;
create policy attendance_status_records_update_admin on public.attendance_status_records
  for update to authenticated
  using (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id));

-- ---------------------------------------------------------------------------
-- attendance_missing_punch_flags: SELECT y la rama ADMIN_RRHH del UPDATE
-- necesitan el filtro -- la rama can_manage_employee() ya lo hereda.
drop policy if exists attendance_missing_punch_flags_select on public.attendance_missing_punch_flags;
create policy attendance_missing_punch_flags_select on public.attendance_missing_punch_flags
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists attendance_missing_punch_flags_update on public.attendance_missing_punch_flags;
create policy attendance_missing_punch_flags_update on public.attendance_missing_punch_flags
  for update to authenticated
  using (
    (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id))
    or public.can_manage_employee(employee_id)
  )
  with check (
    (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id))
    or public.can_manage_employee(employee_id)
  );
