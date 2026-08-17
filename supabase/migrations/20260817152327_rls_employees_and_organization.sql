-- Fase 3 — 18: RLS de employees y tablas organizacionales
--
-- employees: lectura amplia confirmada explícitamente (sección 3/4/30 del
-- encargo: "supervisores pueden ver todos los trabajadores de Arcotex").
-- Escritura restringida a ADMIN_RRHH — los supervisores nunca editan
-- Employee directamente, actúan mediante las tablas de decisión/corrección
-- (sección 2: gestión de datos maestros es atribución de RRHH).
alter table public.employees enable row level security;

create policy employees_select on public.employees
  for select to authenticated using (public.is_corporate_user());

create policy employees_write_admin on public.employees
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- employee_group_assignments / schedule_assignments / supervisor_assignments:
-- lectura amplia (contexto operacional útil para cualquier corporativo);
-- escritura ADMIN_RRHH únicamente — "cambiar asignaciones supervisor/
-- trabajador" es explícitamente una atribución de RRHH (sección 2 del
-- encargo), nunca de los propios supervisores (evita que un supervisor se
-- auto-asigne trabajadores o reasigne su propio contexto de autorización).
alter table public.employee_group_assignments enable row level security;
alter table public.schedule_assignments enable row level security;
alter table public.supervisor_assignments enable row level security;

create policy employee_group_assignments_select on public.employee_group_assignments
  for select to authenticated using (public.is_corporate_user());
create policy employee_group_assignments_write_admin on public.employee_group_assignments
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy schedule_assignments_select on public.schedule_assignments
  for select to authenticated using (public.is_corporate_user());
create policy schedule_assignments_write_admin on public.schedule_assignments
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

create policy supervisor_assignments_select on public.supervisor_assignments
  for select to authenticated using (public.is_corporate_user());
create policy supervisor_assignments_write_admin on public.supervisor_assignments
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());
