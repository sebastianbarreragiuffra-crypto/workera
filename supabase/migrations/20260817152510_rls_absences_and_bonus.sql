-- Fase 3 — 21: RLS de ausencias y bono

alter table public.absence_decisions alter column decided_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- absence_records: lectura amplia. INSERT: registros manuales (L, L-M, V)
-- dentro del contexto del supervisor, con created_by forzado; registros
-- source=workera/system restringidos a ADMIN_RRHH (mismo criterio que
-- attendance_status_records — la vía normal para esos será el futuro sync
-- con service_role). Sin UPDATE para `authenticated`: absence_records es
-- inmutable tras insertar (trigger de Fase 2A, solo is_current es mutable) y
-- la resolución de conflictos/versionado es igual de sensible que en
-- asistencia — se restringe a ADMIN_RRHH.
alter table public.absence_records enable row level security;

create policy absence_records_select on public.absence_records
  for select to authenticated using (public.is_corporate_user());

create policy absence_records_insert on public.absence_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_admin_rrhh()
    end
  );

create policy absence_records_update_admin on public.absence_records
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- absence_decisions: mismo patrón que overtime_decisions/late_arrival_decisions
-- — confirmar/disputar/corregir el tipo de una ausencia es una decisión
-- operacional del supervisor a cargo, revisable por ADMIN_RRHH.
alter table public.absence_decisions enable row level security;

create policy absence_decisions_select on public.absence_decisions
  for select to authenticated using (public.is_corporate_user());

create policy absence_decisions_insert on public.absence_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and exists (
      select 1 from public.absence_records ar
      where ar.id = absence_record_id
        and public.can_manage_employee(ar.employee_id)
    )
  );

create policy absence_decisions_update_admin on public.absence_decisions
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- ---------------------------------------------------------------------------
-- employee_daily_bonuses: SIN policy de INSERT/UPDATE/DELETE para
-- `authenticated`, sin excepción — ni siquiera ADMIN_RRHH puede crear o
-- editar un bono vía la app en esta fase (sección 35: "EmployeeDailyBonus
-- debe permanecer controlado por lógica autorizada del backend/dominio...
-- No permitir UPDATE amount=999999 desde cliente"). La creación de bonos es
-- exclusiva de la futura capa de cálculo, ejecutada con `service_role`
-- (bypassea RLS por diseño) y ya validada por el trigger cruzado de Fase 2B
-- (validate_employee_daily_bonus). Lectura restringida a ADMIN_RRHH: el
-- listado explícito de permisos de supervisor (secciones 3/4 del encargo) NO
-- incluye "ver bonos" — solo RRHH lo tiene listado explícitamente
-- (sección 2, "ver bonos").
alter table public.employee_daily_bonuses enable row level security;

create policy employee_daily_bonuses_select_admin on public.employee_daily_bonuses
  for select to authenticated using (public.is_admin_rrhh());
