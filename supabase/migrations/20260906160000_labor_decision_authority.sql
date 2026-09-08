-- Autoridad empresarial canónica de Asistencia.
-- SUPER_ADMIN conserva lectura/auditoría y administración técnica, pero no
-- puede aparecer como autor de decisiones laborales ni reemplazar las de un
-- supervisor o RR. HH.

create or replace function public.can_manage_employee_on_date(p_employee_id uuid, p_work_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and (
        public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
        or exists (
          select 1
          from public.employee_group_assignments ega
          join public.employee_groups eg on eg.id = ega.employee_group_id
          where ega.employee_id = e.id
            and eg.company_id = e.company_id
            and p_work_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
            and (
              (eg.code = 'PRODUCTION' and public.has_company_app_role(e.company_id, 'SUPERVISOR_PRODUCTION'))
              or (eg.code = 'INSTALLATION' and public.has_company_app_role(e.company_id, 'SUPERVISOR_INSTALLATION'))
            )
        )
      )
  );
$$;

comment on function public.can_manage_employee_on_date(uuid, date) is
  'Autoriza la decisión laboral usando el grupo histórico efectivo en la fecha del hecho, no el grupo actual.';

revoke all on function public.can_manage_employee_on_date(uuid, date) from public, anon;
grant execute on function public.can_manage_employee_on_date(uuid, date) to authenticated;

create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_manage_employee_on_date(p_employee_id, current_date);
$$;

comment on function public.can_manage_employee(uuid) is
  'Autoriza mutaciones laborales solo a ADMIN_RRHH o al supervisor del área '
  'del trabajador, siempre dentro de su empresa activa. SUPER_ADMIN es solo lectura empresarial.';

revoke all on function public.can_manage_employee(uuid) from public, anon;
grant execute on function public.can_manage_employee(uuid) to authenticated;

-- Una ausencia puede atravesar un cambio de grupo. Para que un supervisor la
-- gestione debe tener autoridad sobre todo el intervalo, no solo sobre el
-- grupo actual ni sobre uno de los extremos. range_agg une tramos contiguos y
-- evita expandir rangos extensos dia por dia.
create or replace function public.can_manage_employee_for_date_range(
  p_employee_id uuid,
  p_start_date date,
  p_end_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_start_date is not null
    and p_end_date is not null
    and p_end_date >= p_start_date
    and exists (
      select 1
      from public.employees e
      where e.id = p_employee_id
        and (
          public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
          or coalesce((
            select pg_catalog.range_agg(
              pg_catalog.daterange(ega.effective_from, ega.effective_to, '[]')
            ) @> pg_catalog.daterange(p_start_date, p_end_date, '[]')
            from public.employee_group_assignments ega
            join public.employee_groups eg on eg.id = ega.employee_group_id
            where ega.employee_id = e.id
              and eg.company_id = e.company_id
              and (
                (eg.code = 'PRODUCTION' and public.has_company_app_role(e.company_id, 'SUPERVISOR_PRODUCTION'))
                or (eg.code = 'INSTALLATION' and public.has_company_app_role(e.company_id, 'SUPERVISOR_INSTALLATION'))
              )
          ), false)
        )
    );
$$;

comment on function public.can_manage_employee_for_date_range(uuid, date, date) is
  'Autoriza una ausencia solo si RR. HH. pertenece al tenant o el supervisor '
  'cubre con sus grupos autorizados cada fecha del intervalo.';

revoke all on function public.can_manage_employee_for_date_range(uuid, date, date)
  from public, anon;
grant execute on function public.can_manage_employee_for_date_range(uuid, date, date)
  to authenticated;

drop policy if exists overtime_decisions_insert on public.overtime_decisions;
create policy overtime_decisions_insert on public.overtime_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and is_current
    and exists (
      select 1 from public.overtime_records ovr
      where ovr.id = overtime_record_id
        and public.can_manage_employee_on_date(ovr.employee_id, ovr.work_date)
    )
  );

drop policy if exists late_arrival_decisions_insert on public.late_arrival_decisions;
create policy late_arrival_decisions_insert on public.late_arrival_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and is_current
    and exists (
      select 1 from public.late_arrival_records lar
      where lar.id = late_arrival_record_id
        and public.can_manage_employee_on_date(lar.employee_id, lar.work_date)
    )
  );

drop policy if exists early_departure_decisions_insert on public.early_departure_decisions;
create policy early_departure_decisions_insert on public.early_departure_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and is_current
    and exists (
      select 1 from public.early_departure_records edr
      where edr.id = early_departure_record_id
        and public.can_manage_employee_on_date(edr.employee_id, edr.work_date)
    )
  );

-- Ausencias: la competencia se evalua sobre todo el rango historico y RR. HH.
-- se deriva de la empresa del trabajador. Esto reemplaza las policies legacy
-- que combinaban el rol global de un usuario con la empresa activa.
drop policy if exists absence_records_insert on public.absence_records;
create policy absence_records_insert on public.absence_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid()
        and public.can_manage_employee_for_date_range(employee_id, start_date, end_date)
      else
        exists (
          select 1
          from public.employees e
          where e.id = employee_id
            and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
        )
    end
  );

drop policy if exists absence_records_update_admin on public.absence_records;
create policy absence_records_update_admin on public.absence_records
  for update to authenticated
  using (
    exists (
      select 1 from public.employees e
      where e.id = employee_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  )
  with check (
    exists (
      select 1 from public.employees e
      where e.id = employee_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  );

drop policy if exists absence_decisions_insert on public.absence_decisions;
create policy absence_decisions_insert on public.absence_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and is_current
    and exists (
      select 1
      from public.absence_records ar
      where ar.id = absence_record_id
        and public.can_manage_employee_for_date_range(
          ar.employee_id,
          ar.start_date,
          ar.end_date
        )
    )
  );

-- El reemplazo de una fila vigente pertenece exclusivamente a RR. HH. de la
-- empresa del hecho. No se combina el rol legacy de ARCOTEX con otra membresía.
drop policy if exists overtime_decisions_update_admin on public.overtime_decisions;
create policy overtime_decisions_update_admin on public.overtime_decisions
  for update to authenticated
  using (
    exists (
      select 1
      from public.overtime_records ovr
      join public.employees e on e.id = ovr.employee_id
      where ovr.id = overtime_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  )
  with check (
    exists (
      select 1
      from public.overtime_records ovr
      join public.employees e on e.id = ovr.employee_id
      where ovr.id = overtime_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  );

drop policy if exists late_arrival_decisions_update_admin on public.late_arrival_decisions;
create policy late_arrival_decisions_update_admin on public.late_arrival_decisions
  for update to authenticated
  using (
    exists (
      select 1
      from public.late_arrival_records lar
      join public.employees e on e.id = lar.employee_id
      where lar.id = late_arrival_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  )
  with check (
    exists (
      select 1
      from public.late_arrival_records lar
      join public.employees e on e.id = lar.employee_id
      where lar.id = late_arrival_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  );

drop policy if exists early_departure_decisions_update_admin on public.early_departure_decisions;
create policy early_departure_decisions_update_admin on public.early_departure_decisions
  for update to authenticated
  using (
    exists (
      select 1
      from public.early_departure_records edr
      join public.employees e on e.id = edr.employee_id
      where edr.id = early_departure_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  )
  with check (
    exists (
      select 1
      from public.early_departure_records edr
      join public.employees e on e.id = edr.employee_id
      where edr.id = early_departure_record_id
        and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
    )
  );

-- Ninguna decision laboral puede aparecer dentro de un periodo cerrado. Los
-- reporting_periods son todavia el dominio legacy ARCOTEX, por lo que otros
-- tenants no quedan bloqueados por un rango de fechas ajeno.
create or replace function public.prevent_labor_decision_on_closed_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_start_date date;
  v_end_date date;
begin
  -- Mismo lock global que el cierre final. En el esquema final el trigger
  -- BEFORE STATEMENT ya lo toma; mantenerlo aquí hace explícita la frontera y
  -- evita una carrera si la función se reutiliza desde otro camino confiable.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if tg_table_name = 'overtime_decisions' then
    select e.company_id, r.work_date, r.work_date
      into v_company_id, v_start_date, v_end_date
    from public.overtime_records r
    join public.employees e on e.id = r.employee_id
    where r.id = new.overtime_record_id;
  elsif tg_table_name = 'late_arrival_decisions' then
    select e.company_id, r.work_date, r.work_date
      into v_company_id, v_start_date, v_end_date
    from public.late_arrival_records r
    join public.employees e on e.id = r.employee_id
    where r.id = new.late_arrival_record_id;
  elsif tg_table_name = 'early_departure_decisions' then
    select e.company_id, r.work_date, r.work_date
      into v_company_id, v_start_date, v_end_date
    from public.early_departure_records r
    join public.employees e on e.id = r.employee_id
    where r.id = new.early_departure_record_id;
  elsif tg_table_name = 'absence_decisions' then
    select e.company_id, r.start_date, r.end_date
      into v_company_id, v_start_date, v_end_date
    from public.absence_records r
    join public.employees e on e.id = r.employee_id
    where r.id = new.absence_record_id;
  else
    raise exception 'Tabla de decision laboral no soportada.' using errcode = '22023';
  end if;

  if v_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
     and exists (
       select 1
       from public.reporting_periods rp
       where rp.status = 'CLOSED'
         and pg_catalog.daterange(rp.period_start, rp.period_end, '[]')
           && pg_catalog.daterange(v_start_date, v_end_date, '[]')
     ) then
    raise exception 'No se puede decidir un hecho de asistencia dentro de un periodo cerrado.'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_labor_decision_on_closed_period()
  from public, anon, authenticated, service_role;

drop trigger if exists overtime_decisions_prevent_closed_period on public.overtime_decisions;
create trigger overtime_decisions_prevent_closed_period
  before insert on public.overtime_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists late_arrival_decisions_prevent_closed_period on public.late_arrival_decisions;
create trigger late_arrival_decisions_prevent_closed_period
  before insert on public.late_arrival_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists early_departure_decisions_prevent_closed_period on public.early_departure_decisions;
create trigger early_departure_decisions_prevent_closed_period
  before insert on public.early_departure_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists absence_decisions_prevent_closed_period on public.absence_decisions;
create trigger absence_decisions_prevent_closed_period
  before insert on public.absence_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();
