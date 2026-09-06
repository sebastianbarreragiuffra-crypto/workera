-- Corrige una regresión introducida al aislar bonos por empresa: la policy
-- quedó restringida a ADMIN_RRHH y, por lo tanto, SUPER_ADMIN no podía leer
-- los bonos automáticos que necesita el export de nómina.
--
-- El alcance sigue siendo fail-closed y tenant-aware: ser administrador
-- privilegiado no basta; el trabajador debe pertenecer a una empresa activa
-- de la que el usuario actual sea miembro activo.
drop policy if exists employee_daily_bonuses_select_admin
  on public.employee_daily_bonuses;

create policy employee_daily_bonuses_select_admin
  on public.employee_daily_bonuses
  for select
  to authenticated
  using (
    public.is_privileged_admin()
    and public.employee_belongs_to_active_company(employee_id)
  );

comment on policy employee_daily_bonuses_select_admin
  on public.employee_daily_bonuses is
  'SUPER_ADMIN y ADMIN_RRHH pueden leer bonos únicamente de trabajadores '
  'pertenecientes a una de sus empresas activas. Supervisores y usuarios sin '
  'membresía activa permanecen sin acceso.';
