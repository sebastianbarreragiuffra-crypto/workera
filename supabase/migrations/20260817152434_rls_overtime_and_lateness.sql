-- Fase 3 — 20: RLS de horas extra y atrasos

-- decided_by no tenía DEFAULT en Fase 2A — se agrega por conveniencia; la
-- policy de INSERT exige igualmente decided_by = auth.uid() vía WITH CHECK.
alter table public.overtime_decisions alter column decided_by set default auth.uid();
alter table public.late_arrival_decisions alter column decided_by set default auth.uid();

-- late_arrival_daily_totals (Fase 2B) es una vista sobre late_arrival_records/
-- late_arrival_decisions. Por defecto en Postgres, una vista ejecuta con los
-- privilegios de su DUEÑO (security_invoker = false), lo que bypassearía el
-- RLS que se está a punto de habilitar sobre las tablas base — exactamente el
-- tipo de brecha que la sección 24 pide evitar. Se fuerza security_invoker
-- para que la vista respete el RLS del usuario que realmente consulta.
alter view public.late_arrival_daily_totals set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- overtime_records / late_arrival_records: hecho calculado por el sistema.
-- Lectura amplia. CERO policies de escritura para `authenticated` (sección
-- 33: "no permitir que supervisor manipule candidate_minutes") — estos
-- valores los produce el motor de cálculo (fase futura, vía backend/
-- service_role), nunca el cliente.
alter table public.overtime_records enable row level security;
alter table public.late_arrival_records enable row level security;

create policy overtime_records_select on public.overtime_records
  for select to authenticated using (public.is_corporate_user());
create policy late_arrival_records_select on public.late_arrival_records
  for select to authenticated using (public.is_corporate_user());

-- ---------------------------------------------------------------------------
-- overtime_decisions: INSERT restringido al contexto operacional
-- (can_manage_employee sobre el trabajador del overtime_record referenciado),
-- con decided_by forzado a auth.uid(). UPDATE (solo is_current, por el
-- trigger de Fase 2A) restringido a ADMIN_RRHH: revisar/anular una decisión
-- ya tomada es autoridad de RRHH (sección 7/8 — "RRHH REVIEW/OVERRIDE").
-- Nota: el índice único parcial `overtime_decisions_current_key` (Fase 2A) ya
-- impide que exista más de una decisión vigente por overtime_record — un
-- supervisor no puede "reemplazar" su propia decisión insertando una nueva
-- mientras la anterior siga vigente, solo ADMIN_RRHH puede desactivar la
-- vigente (UPDATE is_current) para habilitar una nueva.
alter table public.overtime_decisions enable row level security;

create policy overtime_decisions_select on public.overtime_decisions
  for select to authenticated using (public.is_corporate_user());

create policy overtime_decisions_insert on public.overtime_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and exists (
      select 1 from public.overtime_records ovr
      where ovr.id = overtime_record_id
        and public.can_manage_employee(ovr.employee_id)
    )
  );

create policy overtime_decisions_update_admin on public.overtime_decisions
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- late_arrival_decisions: mismo patrón exacto que overtime_decisions.
alter table public.late_arrival_decisions enable row level security;

create policy late_arrival_decisions_select on public.late_arrival_decisions
  for select to authenticated using (public.is_corporate_user());

create policy late_arrival_decisions_insert on public.late_arrival_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and exists (
      select 1 from public.late_arrival_records lar
      where lar.id = late_arrival_record_id
        and public.can_manage_employee(lar.employee_id)
    )
  );

create policy late_arrival_decisions_update_admin on public.late_arrival_decisions
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());
