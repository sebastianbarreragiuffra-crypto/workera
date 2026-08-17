-- Fase 3 — 19: RLS de asistencia (source Workera inmutable, correcciones,
-- códigos diarios, sync_runs)

-- attendance_status_records.created_by no tenía DEFAULT (Fase 2B) — se agrega
-- por conveniencia; la policy de INSERT exige igualmente created_by =
-- auth.uid() vía WITH CHECK, el DEFAULT solo evita que el cliente deba
-- enviarlo explícitamente.
alter table public.attendance_status_records
  alter column created_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- attendance_records: el hecho crudo de Workera. Lectura amplia (sección 31
-- del encargo). CERO policies de escritura para `authenticated` — ni
-- supervisor ni ADMIN_RRHH pueden modificar este dato vía la app (sección
-- 10/32: "RRHH tampoco debe destruir el source original"). La única vía de
-- escritura es `service_role` (sincronización futura), que Postgres/Supabase
-- hace bypassear RLS por diseño — no requiere ninguna policy explícita aquí,
-- y por eso mismo el backend de sincronización nunca debe exponerse al
-- navegador (sección 25/26).
alter table public.attendance_records enable row level security;

create policy attendance_records_select on public.attendance_records
  for select to authenticated using (public.is_corporate_user());

-- ---------------------------------------------------------------------------
-- attendance_corrections: lectura amplia; INSERT restringido al contexto
-- operacional del supervisor (o ADMIN_RRHH sin restricción) vía
-- can_manage_employee, con corrected_by forzado a auth.uid() — nunca un valor
-- de cliente (sección 11/37). UPDATE (solo puede tocar is_current, por el
-- trigger de inmutabilidad de Fase 3-15) restringido a ADMIN_RRHH: invalidar
-- una corrección ya registrada es una revisión administrativa (sección 7 —
-- "RRHH REVIEW/OVERRIDE"), no algo que un supervisor haga unilateralmente
-- sobre su propio trabajo pasado.
alter table public.attendance_corrections enable row level security;

create policy attendance_corrections_select on public.attendance_corrections
  for select to authenticated using (public.is_corporate_user());

create policy attendance_corrections_insert on public.attendance_corrections
  for insert to authenticated
  with check (
    corrected_by = auth.uid()
    and public.can_manage_employee(employee_id)
  );

create policy attendance_corrections_update_admin on public.attendance_corrections
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- attendance_status_records: lectura amplia. INSERT: cualquier corporativo
-- dentro de su contexto (novedades manuales, sección 11), con created_by
-- forzado cuando source = manual. Los registros source = workera/system no
-- deberían insertarse desde el navegador — se restringen adicionalmente a
-- ADMIN_RRHH (en la práctica, esta vía la usará el futuro sync con
-- service_role, que de todas formas bypassea RLS; esta rama solo cubre el
-- caso de que un ADMIN_RRHH necesite forzar un registro fuera del flujo
-- automático). UPDATE (solo is_current) restringido a ADMIN_RRHH — resolver
-- un SYNC_CONFLICT/duplicado es una decisión administrativa.
alter table public.attendance_status_records enable row level security;

create policy attendance_status_records_select on public.attendance_status_records
  for select to authenticated using (public.is_corporate_user());

create policy attendance_status_records_insert on public.attendance_status_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_admin_rrhh()
    end
  );

create policy attendance_status_records_update_admin on public.attendance_status_records
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- sync_runs: visibilidad operacional/técnica — se restringe a ADMIN_RRHH
-- (monitoreo de sincronización), no es información que los supervisores
-- necesiten para su trabajo diario (no listado en sus permisos, sección 3/4).
-- Sin policies de escritura para `authenticated`: sync_runs lo escribe
-- exclusivamente el futuro proceso de sincronización con `service_role`.
alter table public.sync_runs enable row level security;

create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated using (public.is_admin_rrhh());
