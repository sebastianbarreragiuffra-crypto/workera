-- GESTORA MT-3B (recorte 2, parte 3): autorización por empresa sobre horas
-- extra, atrasos, salidas anticipadas, ausencias, bono diario, políticas de
-- excepción de control horario y cumpleaños -- mismo hueco que recorte 2
-- parte 1 cerró para el núcleo de asistencia (20260902060000): estas tablas
-- autorizaban solo por rol global (is_corporate_user()/is_admin_rrhh()/
-- is_privileged_admin()), sin ningún filtro de company_id.
--
-- Ninguna necesita columna company_id propia: todas resuelven el tenant vía
-- employee_id (directo) o, en overtime_policies/late_arrival_policies, vía
-- employee_group_id -- exactamente el mismo criterio que recorte 1 y recorte
-- 2 parte 1 ya establecieron. Se agrega un único helper nuevo,
-- employee_group_belongs_to_active_company(), análogo a
-- employee_belongs_to_active_company() pero resolviendo por grupo en vez de
-- por trabajador individual.
--
-- Fuera de este recorte, deliberadamente: work_schedules/work_schedule_rules/
-- bonus_policies (catálogos sin ningún vínculo a employee/employee_group hoy
-- -- decidir si se vuelven per-company o quedan como catálogo compartido es
-- una decisión de producto aparte, no un fix de aislamiento), motor de
-- reglas (ya cerrado en recorte 2 parte 2) y supporting_documents/Storage
-- (dominio propio, con sus propias policies de bucket -- punto 4 de la
-- sección 4 del roadmap, pendiente en una migración dedicada).

-- ---------------------------------------------------------------------------
-- Helper nuevo: mismo patrón que employee_belongs_to_active_company(), pero
-- para tablas de política ancladas en employee_group_id en vez de
-- employee_id (overtime_policies, late_arrival_policies).
create or replace function public.employee_group_belongs_to_active_company(p_employee_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.employee_groups eg
    where eg.id = p_employee_group_id
      and public.is_active_company_member(eg.company_id)
  );
$$;

comment on function public.employee_group_belongs_to_active_company(uuid) is
  'true si el usuario actual es miembro activo de la empresa DUEÑA de este '
  'grupo de trabajadores específico -- análogo a '
  'employee_belongs_to_active_company() pero para policies ancladas en '
  'employee_group_id (overtime_policies, late_arrival_policies).';

revoke all on function public.employee_group_belongs_to_active_company(uuid) from public, anon;
grant execute on function public.employee_group_belongs_to_active_company(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- overtime_records / late_arrival_records / early_departure_records: hecho
-- calculado, solo SELECT para authenticated.
drop policy if exists overtime_records_select on public.overtime_records;
create policy overtime_records_select on public.overtime_records
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists late_arrival_records_select on public.late_arrival_records;
create policy late_arrival_records_select on public.late_arrival_records
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists early_departure_records_select on public.early_departure_records;
create policy early_departure_records_select on public.early_departure_records
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

-- ---------------------------------------------------------------------------
-- overtime_decisions / late_arrival_decisions / early_departure_decisions:
-- no tienen employee_id propio -- se resuelve vía el *_record referenciado,
-- mismo join que sus policies de INSERT ya usaban con can_manage_employee().
drop policy if exists overtime_decisions_select on public.overtime_decisions;
create policy overtime_decisions_select on public.overtime_decisions
  for select to authenticated using (
    public.is_corporate_user()
    and exists (
      select 1 from public.overtime_records ovr
      where ovr.id = overtime_record_id
        and public.employee_belongs_to_active_company(ovr.employee_id)
    )
  );

drop policy if exists overtime_decisions_update_admin on public.overtime_decisions;
create policy overtime_decisions_update_admin on public.overtime_decisions
  for update to authenticated
  using (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.overtime_records ovr
      where ovr.id = overtime_record_id
        and public.employee_belongs_to_active_company(ovr.employee_id)
    )
  )
  with check (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.overtime_records ovr
      where ovr.id = overtime_record_id
        and public.employee_belongs_to_active_company(ovr.employee_id)
    )
  );

drop policy if exists late_arrival_decisions_select on public.late_arrival_decisions;
create policy late_arrival_decisions_select on public.late_arrival_decisions
  for select to authenticated using (
    public.is_corporate_user()
    and exists (
      select 1 from public.late_arrival_records lar
      where lar.id = late_arrival_record_id
        and public.employee_belongs_to_active_company(lar.employee_id)
    )
  );

drop policy if exists late_arrival_decisions_update_admin on public.late_arrival_decisions;
create policy late_arrival_decisions_update_admin on public.late_arrival_decisions
  for update to authenticated
  using (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.late_arrival_records lar
      where lar.id = late_arrival_record_id
        and public.employee_belongs_to_active_company(lar.employee_id)
    )
  )
  with check (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.late_arrival_records lar
      where lar.id = late_arrival_record_id
        and public.employee_belongs_to_active_company(lar.employee_id)
    )
  );

drop policy if exists early_departure_decisions_select on public.early_departure_decisions;
create policy early_departure_decisions_select on public.early_departure_decisions
  for select to authenticated using (
    public.is_corporate_user()
    and exists (
      select 1 from public.early_departure_records edr
      where edr.id = early_departure_record_id
        and public.employee_belongs_to_active_company(edr.employee_id)
    )
  );

drop policy if exists early_departure_decisions_update_admin on public.early_departure_decisions;
create policy early_departure_decisions_update_admin on public.early_departure_decisions
  for update to authenticated
  using (
    public.is_privileged_admin()
    and exists (
      select 1 from public.early_departure_records edr
      where edr.id = early_departure_record_id
        and public.employee_belongs_to_active_company(edr.employee_id)
    )
  )
  with check (
    public.is_privileged_admin()
    and exists (
      select 1 from public.early_departure_records edr
      where edr.id = early_departure_record_id
        and public.employee_belongs_to_active_company(edr.employee_id)
    )
  );

-- ---------------------------------------------------------------------------
-- absence_records: SELECT, la rama no-manual del INSERT y el UPDATE
-- administrativo -- la rama manual ya hereda el filtro de
-- can_manage_employee().
drop policy if exists absence_records_select on public.absence_records;
create policy absence_records_select on public.absence_records
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists absence_records_insert on public.absence_records;
create policy absence_records_insert on public.absence_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id)
    end
  );

drop policy if exists absence_records_update_admin on public.absence_records;
create policy absence_records_update_admin on public.absence_records
  for update to authenticated
  using (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id));

-- ---------------------------------------------------------------------------
-- absence_decisions: mismo patrón exists() que overtime/late_arrival.
drop policy if exists absence_decisions_select on public.absence_decisions;
create policy absence_decisions_select on public.absence_decisions
  for select to authenticated using (
    public.is_corporate_user()
    and exists (
      select 1 from public.absence_records ar
      where ar.id = absence_record_id
        and public.employee_belongs_to_active_company(ar.employee_id)
    )
  );

drop policy if exists absence_decisions_update_admin on public.absence_decisions;
create policy absence_decisions_update_admin on public.absence_decisions
  for update to authenticated
  using (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.absence_records ar
      where ar.id = absence_record_id
        and public.employee_belongs_to_active_company(ar.employee_id)
    )
  )
  with check (
    public.is_admin_rrhh()
    and exists (
      select 1 from public.absence_records ar
      where ar.id = absence_record_id
        and public.employee_belongs_to_active_company(ar.employee_id)
    )
  );

-- ---------------------------------------------------------------------------
-- employee_daily_bonuses: única policy es de lectura administrativa.
drop policy if exists employee_daily_bonuses_select_admin on public.employee_daily_bonuses;
create policy employee_daily_bonuses_select_admin on public.employee_daily_bonuses
  for select to authenticated using (
    public.is_admin_rrhh() and public.employee_belongs_to_active_company(employee_id)
  );

-- ---------------------------------------------------------------------------
-- employee_time_control_policies: excepciones de control horario por
-- trabajador (employee_id directo).
drop policy if exists employee_time_control_policies_select on public.employee_time_control_policies;
create policy employee_time_control_policies_select on public.employee_time_control_policies
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists employee_time_control_policies_write_admin on public.employee_time_control_policies;
create policy employee_time_control_policies_write_admin on public.employee_time_control_policies
  for all to authenticated
  using (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id));

-- ---------------------------------------------------------------------------
-- employee_birthdays.
drop policy if exists employee_birthdays_select on public.employee_birthdays;
create policy employee_birthdays_select on public.employee_birthdays
  for select to authenticated using (
    public.is_corporate_user() and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists employee_birthdays_write_admin on public.employee_birthdays;
create policy employee_birthdays_write_admin on public.employee_birthdays
  for all to authenticated
  using (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id))
  with check (public.is_privileged_admin() and public.employee_belongs_to_active_company(employee_id));

-- ---------------------------------------------------------------------------
-- overtime_policies / late_arrival_policies: ancladas en employee_group_id,
-- no en employee_id -- usan el helper nuevo.
drop policy if exists overtime_policies_select on public.overtime_policies;
create policy overtime_policies_select on public.overtime_policies
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  );
drop policy if exists overtime_policies_write_admin on public.overtime_policies;
create policy overtime_policies_write_admin on public.overtime_policies
  for all to authenticated
  using (
    public.is_admin_rrhh()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  )
  with check (
    public.is_admin_rrhh()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  );

drop policy if exists late_arrival_policies_select on public.late_arrival_policies;
create policy late_arrival_policies_select on public.late_arrival_policies
  for select to authenticated using (
    public.is_corporate_user()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  );
drop policy if exists late_arrival_policies_write_admin on public.late_arrival_policies;
create policy late_arrival_policies_write_admin on public.late_arrival_policies
  for all to authenticated
  using (
    public.is_admin_rrhh()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  )
  with check (
    public.is_admin_rrhh()
    and public.employee_group_belongs_to_active_company(employee_group_id)
  );
