-- Reemplazo transaccional de decisiones laborales por RR. HH.
--
-- Una nueva decisión se inserta como una fila independiente. Si ya existe una
-- vigente sobre el mismo hecho, este trigger bloquea esa fila, verifica que el
-- actor sea ADMIN_RRHH, exige motivo y retira la vigencia anterior dentro de
-- la misma sentencia. Así no existe una ventana entre invalidar e insertar y
-- los supervisores no pueden reemplazar el veredicto ya registrado.

create or replace function public.prepare_rrhh_labor_decision_replacement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_id uuid;
  v_company_id uuid;
begin
  if not new.is_current then
    if auth.uid() is not null then
      raise exception 'Una sesión no puede insertar decisiones históricas no vigentes.' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_table_name = 'overtime_decisions' then
    select d.id, e.company_id into v_current_id, v_company_id
    from public.overtime_decisions d
    join public.overtime_records r on r.id = d.overtime_record_id
    join public.employees e on e.id = r.employee_id
    where d.overtime_record_id = new.overtime_record_id and d.is_current
    for update of d;
  elsif tg_table_name = 'late_arrival_decisions' then
    select d.id, e.company_id into v_current_id, v_company_id
    from public.late_arrival_decisions d
    join public.late_arrival_records r on r.id = d.late_arrival_record_id
    join public.employees e on e.id = r.employee_id
    where d.late_arrival_record_id = new.late_arrival_record_id and d.is_current
    for update of d;
  elsif tg_table_name = 'early_departure_decisions' then
    select d.id, e.company_id into v_current_id, v_company_id
    from public.early_departure_decisions d
    join public.early_departure_records r on r.id = d.early_departure_record_id
    join public.employees e on e.id = r.employee_id
    where d.early_departure_record_id = new.early_departure_record_id and d.is_current
    for update of d;
  elsif tg_table_name = 'absence_decisions' then
    select d.id, e.company_id into v_current_id, v_company_id
    from public.absence_decisions d
    join public.absence_records r on r.id = d.absence_record_id
    join public.employees e on e.id = r.employee_id
    where d.absence_record_id = new.absence_record_id and d.is_current
    for update of d;
  else
    raise exception 'Tabla de decisión laboral no soportada.' using errcode = '22023';
  end if;

  if v_current_id is null then
    return new;
  end if;

  if not coalesce(public.has_company_app_role(v_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'Solo RR. HH. puede reemplazar una decisión vigente.' using errcode = '42501';
  end if;
  if nullif(btrim(new.reason), '') is null then
    raise exception 'El reemplazo de una decisión exige motivo.' using errcode = '22023';
  end if;

  if tg_table_name = 'overtime_decisions' then
    update public.overtime_decisions set is_current = false where id = v_current_id;
  elsif tg_table_name = 'late_arrival_decisions' then
    update public.late_arrival_decisions set is_current = false where id = v_current_id;
  elsif tg_table_name = 'early_departure_decisions' then
    update public.early_departure_decisions set is_current = false where id = v_current_id;
  else
    update public.absence_decisions set is_current = false where id = v_current_id;
  end if;

  return new;
end;
$$;

revoke all on function public.prepare_rrhh_labor_decision_replacement()
  from public, anon, authenticated, service_role;

drop trigger if exists overtime_decisions_prepare_rrhh_replacement on public.overtime_decisions;
create trigger overtime_decisions_prepare_rrhh_replacement
  before insert on public.overtime_decisions
  for each row execute function public.prepare_rrhh_labor_decision_replacement();

drop trigger if exists late_arrival_decisions_prepare_rrhh_replacement on public.late_arrival_decisions;
create trigger late_arrival_decisions_prepare_rrhh_replacement
  before insert on public.late_arrival_decisions
  for each row execute function public.prepare_rrhh_labor_decision_replacement();

drop trigger if exists early_departure_decisions_prepare_rrhh_replacement on public.early_departure_decisions;
create trigger early_departure_decisions_prepare_rrhh_replacement
  before insert on public.early_departure_decisions
  for each row execute function public.prepare_rrhh_labor_decision_replacement();

drop trigger if exists absence_decisions_prepare_rrhh_replacement on public.absence_decisions;
create trigger absence_decisions_prepare_rrhh_replacement
  before insert on public.absence_decisions
  for each row execute function public.prepare_rrhh_labor_decision_replacement();

-- Una revisión de RR. HH. siempre es otra fila. Quitar UPDATE a las sesiones
-- evita que un cliente REST mutile la evidencia anterior en vez de pasar por
-- el reemplazo atómico del trigger.
drop policy if exists overtime_decisions_update_admin on public.overtime_decisions;
drop policy if exists late_arrival_decisions_update_admin on public.late_arrival_decisions;
drop policy if exists early_departure_decisions_update_admin on public.early_departure_decisions;
drop policy if exists absence_decisions_update_admin on public.absence_decisions;
revoke update on public.overtime_decisions from authenticated;
revoke update on public.late_arrival_decisions from authenticated;
revoke update on public.early_departure_decisions from authenticated;
revoke update on public.absence_decisions from authenticated;

comment on function public.prepare_rrhh_labor_decision_replacement() is
  'Reemplaza atómicamente la decisión laboral vigente solo para ADMIN_RRHH, '
  'con motivo obligatorio y conservación completa de la fila anterior.';
