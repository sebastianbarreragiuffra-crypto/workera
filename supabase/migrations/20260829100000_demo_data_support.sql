-- Soporte para datos de demostración en STAGING (Fase 9 -- multi-user demo).
--
-- Reutiliza EXACTAMENTE el mismo patrón ya establecido por el bootstrap de
-- roster por Excel (20260826100000_employee_roster_bootstrap.sql):
-- `employees.source` ya distingue el origen de cada fila ('workera' vs
-- 'excel_roster') -- esta migración solo agrega un tercer valor, 'demo',
-- al mismo CHECK, sin crear una tabla ni un modelo paralelo.
--
-- Identificación: SOLO `employees.source = 'demo'` es el marcador raíz. Todas
-- las tablas dependientes (absence_records, late_arrival_records,
-- overtime_records, early_departure_records, medical_license_approvals,
-- supporting_documents, attendance_status_records, attendance_records) se
-- identifican transitivamente vía `employee_id` -- exactamente el mismo
-- criterio de "fuente de verdad única" que el resto del esquema ya usa
-- (ninguna de esas tablas necesita su propia columna 'source=demo': ya
-- están, sin excepción, atadas a un employee_id).
--
-- Limpieza seguro: `cleanup_demo_data()` borra en orden de dependencia FK
-- (ninguna FK de este esquema usa ON DELETE CASCADE -- todas son NO ACTION
-- por diseño, ver comentarios de las migraciones originales), y solo afecta
-- filas cuyo employee_id pertenezca a un empleado 'demo'. No hay ninguna vía
-- para que esta función toque un empleado real -- el WHERE de cada DELETE
-- siempre pasa por el subquery de employees.source = 'demo'.

alter table public.employees
  drop constraint employees_source_check,
  add constraint employees_source_check check (source in ('workera', 'excel_roster', 'demo'));

comment on column public.employees.source is
  'Origen de la fila -- "excel_roster" (bootstrap administrativo, planilla de '
  'personal), "workera" (roster real confirmado), o "demo" (datos sintéticos '
  'de demostración en STAGING, ver cleanup_demo_data()). "demo" nunca debe '
  'existir en un ambiente con datos reales de producción.';

create or replace function public.cleanup_demo_data()
returns table (table_name text, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  if not public.is_super_admin() then
    raise exception 'Solo SUPER_ADMIN puede ejecutar la limpieza de datos de demostración.';
  end if;

  -- Orden de dependencia FK: primero las hojas (decisiones/documentos), al
  -- final employees. Cada DELETE queda acotado por el mismo subquery de
  -- empleados 'demo' -- nunca toca una fila de un empleado real.
  delete from public.medical_license_approvals where absence_record_id in (
    select id from public.absence_records where employee_id in (select id from public.employees where source = 'demo')
  );
  get diagnostics v_count = row_count; table_name := 'medical_license_approvals'; rows_deleted := v_count; return next;

  delete from public.supporting_documents where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'supporting_documents'; rows_deleted := v_count; return next;

  delete from public.attendance_status_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'attendance_status_records'; rows_deleted := v_count; return next;

  delete from public.absence_decisions where absence_record_id in (
    select id from public.absence_records where employee_id in (select id from public.employees where source = 'demo')
  );
  get diagnostics v_count = row_count; table_name := 'absence_decisions'; rows_deleted := v_count; return next;

  delete from public.absence_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'absence_records'; rows_deleted := v_count; return next;

  delete from public.late_arrival_decisions where late_arrival_record_id in (
    select id from public.late_arrival_records where employee_id in (select id from public.employees where source = 'demo')
  );
  get diagnostics v_count = row_count; table_name := 'late_arrival_decisions'; rows_deleted := v_count; return next;

  delete from public.late_arrival_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'late_arrival_records'; rows_deleted := v_count; return next;

  delete from public.early_departure_decisions where early_departure_record_id in (
    select id from public.early_departure_records where employee_id in (select id from public.employees where source = 'demo')
  );
  get diagnostics v_count = row_count; table_name := 'early_departure_decisions'; rows_deleted := v_count; return next;

  delete from public.early_departure_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'early_departure_records'; rows_deleted := v_count; return next;

  delete from public.employee_daily_bonuses where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'employee_daily_bonuses'; rows_deleted := v_count; return next;

  delete from public.overtime_decisions where overtime_record_id in (
    select id from public.overtime_records where employee_id in (select id from public.employees where source = 'demo')
  );
  get diagnostics v_count = row_count; table_name := 'overtime_decisions'; rows_deleted := v_count; return next;

  delete from public.overtime_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'overtime_records'; rows_deleted := v_count; return next;

  delete from public.attendance_missing_punch_flags where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'attendance_missing_punch_flags'; rows_deleted := v_count; return next;

  delete from public.attendance_records where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'attendance_records'; rows_deleted := v_count; return next;

  delete from public.employee_birthdays where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'employee_birthdays'; rows_deleted := v_count; return next;

  delete from public.schedule_assignments where employee_id in (select id from public.employees where source = 'demo');
  get diagnostics v_count = row_count; table_name := 'schedule_assignments'; rows_deleted := v_count; return next;

  delete from public.employees where source = 'demo';
  get diagnostics v_count = row_count; table_name := 'employees'; rows_deleted := v_count; return next;

  return;
end;
$$;

comment on function public.cleanup_demo_data() is
  'Borra TODOS los datos de demostración (employees.source=''demo'' y todo lo '
  'que cuelga de su employee_id) en orden seguro de dependencia FK. Exclusivo '
  'de SUPER_ADMIN (mismo criterio que otras operaciones destructivas de '
  'administración). Nunca toca un empleado con source IN (''workera'', '
  '''excel_roster''). SECURITY DEFINER (mismo patrón que '
  'apply_personnel_roster_import/approve_medical_license): estas tablas no '
  'tienen policy de DELETE para authenticated (deny-by-default), así que el '
  'borrado real necesita privilegios elevados -- el único gate de '
  'autorización es el chequeo is_super_admin() explícito de arriba, antes de '
  'tocar cualquier tabla.';

revoke all on function public.cleanup_demo_data() from public, anon;
grant execute on function public.cleanup_demo_data() to authenticated;
