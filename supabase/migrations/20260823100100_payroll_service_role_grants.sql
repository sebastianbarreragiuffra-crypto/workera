-- Este proyecto no usa ALTER DEFAULT PRIVILEGES (Fase 3, grants_lockdown) --
-- toda tabla nueva necesita su GRANT explícito por rol, la policy RLS por sí
-- sola no basta. Mismo patrón ya usado en
-- 20260820100100_phase7_service_role_grants.sql para
-- employee_time_control_policies -- necesario para scripts/jobs
-- server-side (service_role) que operen sobre el maestro de proveedores.

grant select, insert, update on table public.suppliers to service_role;
grant select, insert on table public.payroll_batches to service_role;
grant select, insert on table public.payroll_batch_items to service_role;
