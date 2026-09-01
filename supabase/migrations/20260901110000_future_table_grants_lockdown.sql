-- Seguridad: privilegios mínimos para relaciones creadas después del
-- lockdown original (20260817153423).
--
-- Supabase concede por defecto TRUNCATE/REFERENCES/TRIGGER a `anon` y
-- `authenticated` cuando el dueño es `postgres`. RLS no protege TRUNCATE,
-- por lo que una tabla nueva podía quedar expuesta aunque sus policies
-- fueran correctas. Esta migración:
--   1) corrige todas las relaciones de aplicación afectadas hasta MT-2;
--   2) conserva únicamente los permisos DML que sus policies esperan; y
--   3) cambia los privilegios por defecto de futuras tablas creadas por el
--      rol que ejecuta migraciones. Cada migración futura deberá otorgar
--      explícitamente sus permisos mínimos, como ya documenta el proyecto.

-- Rehacer desde cero evita conservar privilegios accidentales. `service_role`
-- no se modifica: sus grants explícitos pertenecen a los procesos backend.
revoke all on table
  public.attendance_effective_punches,
  public.supporting_documents_metadata,
  public.employee_time_control_policies,
  public.early_departure_records,
  public.early_departure_decisions,
  public.employee_birthdays,
  public.suppliers,
  public.payroll_batches,
  public.payroll_batch_items,
  public.supplier_master_imports,
  public.medical_license_approvals,
  public.colaciones_discount_workbooks,
  public.companies,
  public.company_memberships
from anon, authenticated;

-- Vistas operacionales: solo lectura.
grant select on table
  public.attendance_effective_punches,
  public.supporting_documents_metadata
to authenticated;

-- Configuración administrativa con RLS de administrador.
grant select, insert, update, delete on table
  public.employee_time_control_policies,
  public.employee_birthdays,
  public.suppliers
to authenticated;

-- Hechos calculados por backend: solo lectura desde sesiones de usuario.
grant select on table public.early_departure_records to authenticated;

-- Decisiones operacionales controladas por sus policies RLS.
grant select, insert, update on table
  public.early_departure_decisions,
  public.supplier_master_imports,
  public.medical_license_approvals,
  public.colaciones_discount_workbooks
to authenticated;

-- Lotes de nómina son append-only para usuarios autenticados.
grant select, insert on table
  public.payroll_batches,
  public.payroll_batch_items
to authenticated;

-- Fundación multi-tenant: por ahora solo lectura y siempre filtrada por RLS.
grant select on table
  public.companies,
  public.company_memberships
to authenticated;

-- Prevención de recurrencia. Aplica a tablas y vistas futuras creadas por el
-- rol de migración actual (`postgres` en Supabase CLI/SQL migrations).
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
