-- Fase 3 — 17: RLS de catálogos y tablas de política
--
-- Deny-by-default: enable RLS + solo las policies explícitas listadas aquí
-- otorgan acceso. anon nunca aparece en ninguna policy de estas tablas —
-- queda denegado por la ausencia de regla, no por una regla negativa.

-- ---------------------------------------------------------------------------
-- Catálogos de solo lectura por la aplicación en esta fase (employee_groups,
-- overtime_types, absence_types, attendance_statuses, bonus_types): lectura
-- para cualquier usuario corporativo autenticado; sin policy de escritura
-- para `authenticated` en absoluto — agregar/renombrar un código sigue siendo
-- una decisión de migración, no una operación de la app en Fase 3 (documentado
-- como simplificación deliberada, no un descuido).
alter table public.employee_groups enable row level security;
alter table public.overtime_types enable row level security;
alter table public.absence_types enable row level security;
alter table public.attendance_statuses enable row level security;
alter table public.bonus_types enable row level security;

create policy employee_groups_select on public.employee_groups
  for select to authenticated using (public.is_corporate_user());
create policy overtime_types_select on public.overtime_types
  for select to authenticated using (public.is_corporate_user());
create policy absence_types_select on public.absence_types
  for select to authenticated using (public.is_corporate_user());
create policy attendance_statuses_select on public.attendance_statuses
  for select to authenticated using (public.is_corporate_user());
create policy bonus_types_select on public.bonus_types
  for select to authenticated using (public.is_corporate_user());

-- ---------------------------------------------------------------------------
-- Tablas de política/configuración (work_schedules, work_schedule_rules,
-- overtime_policies, late_arrival_policies, bonus_policies): lectura para
-- cualquier corporativo (los supervisores necesitan ver qué política aplica
-- para entender un candidato de horas extra/atraso); escritura únicamente
-- ADMIN_RRHH — son decisiones administrativas (sección 2 del encargo:
-- "corregir registros autorizados" es una atribución de RRHH).
alter table public.work_schedules enable row level security;
alter table public.work_schedule_rules enable row level security;
alter table public.overtime_policies enable row level security;
alter table public.late_arrival_policies enable row level security;
alter table public.bonus_policies enable row level security;

create policy work_schedules_select on public.work_schedules
  for select to authenticated using (public.is_corporate_user());
create policy work_schedules_write_admin on public.work_schedules
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy work_schedule_rules_select on public.work_schedule_rules
  for select to authenticated using (public.is_corporate_user());
create policy work_schedule_rules_write_admin on public.work_schedule_rules
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy overtime_policies_select on public.overtime_policies
  for select to authenticated using (public.is_corporate_user());
create policy overtime_policies_write_admin on public.overtime_policies
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy late_arrival_policies_select on public.late_arrival_policies
  for select to authenticated using (public.is_corporate_user());
create policy late_arrival_policies_write_admin on public.late_arrival_policies
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy bonus_policies_select on public.bonus_policies
  for select to authenticated using (public.is_corporate_user());
create policy bonus_policies_write_admin on public.bonus_policies
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

-- Nota: `for all` cubre INSERT/UPDATE/DELETE/SELECT; se combina con la
-- policy `_select` (que también permite a supervisores) sin conflicto: RLS
-- evalúa las policies aplicables a cada comando con OR — un supervisor sigue
-- pudiendo leer vía `_select`, y `_write_admin` es la única que habilita
-- escritura, restringida a ADMIN_RRHH.
