-- Administración de horarios y exención de control horario (MB-1).
--
-- Contexto: hasta esta migración `schedule_assignments` no tenía NINGUNA vía
-- de escritura fuera de SQL directo — `seed-known-schedules.ts` existía pero
-- sin llamador, y la app no tenía pantalla. Con 0 filas en esa tabla,
-- `resolveEffectiveSchedule` devuelve `NO_SCHEDULE_ASSIGNED` para todos y el
-- motor de reglas (atrasos/salida anticipada/horas extra) no produce nada.
--
-- Estas funciones NO son `security definer`: corren como el llamador, así que
-- la RLS existente (`schedule_assignments_write_admin` /
-- `employee_time_control_policies_write_admin`, ambas `is_privileged_admin()`)
-- sigue siendo el gate real de autorización. Lo único que aportan es
-- ATOMICIDAD: cerrar la asignación vigente e insertar la nueva deben ocurrir
-- en la misma transacción, o un fallo intermedio deja al trabajador sin
-- horario. Mismo criterio que `apply_personnel_roster_import`.
--
-- Detalle crítico del rango: los dos constraints de exclusión relevantes usan
-- `daterange(effective_from, effective_to, '[]')` — INCLUSIVO en ambos
-- extremos. Cerrar una asignación con `effective_to = p_effective_from` (como
-- hacía `seed-known-schedules.ts`) solapa con la nueva que empieza ese mismo
-- día y viola la exclusión. El cierre correcto es `p_effective_from - 1`.

-- ---------------------------------------------------------------------------
-- Horario: crear/actualizar la definición (cabecera + reglas por día)

create or replace function public.upsert_work_schedule(
  p_schedule_id uuid,
  p_name text,
  p_rules jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_schedule_id uuid;
  r jsonb;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'El nombre del horario no puede estar vacío.';
  end if;

  if p_schedule_id is null then
    insert into public.work_schedules (name) values (btrim(p_name))
    returning id into v_schedule_id;
  else
    update public.work_schedules set name = btrim(p_name)
    where id = p_schedule_id
    returning id into v_schedule_id;

    if v_schedule_id is null then
      raise exception 'El horario indicado no existe.';
    end if;
  end if;

  -- Las reglas se reemplazan completas: es la única forma de expresar "este
  -- día pasó a ser libre" sin una semántica de borrado parcial ambigua.
  -- `work_schedule_rules` tiene ON DELETE CASCADE hacia work_schedules, pero
  -- acá el borrado es explícito porque la cabecera se conserva.
  delete from public.work_schedule_rules where work_schedule_id = v_schedule_id;

  for r in select * from jsonb_array_elements(p_rules)
  loop
    insert into public.work_schedule_rules (work_schedule_id, day_of_week, scheduled_start, scheduled_end)
    values (
      v_schedule_id,
      (r->>'day_of_week')::smallint,
      nullif(r->>'scheduled_start', '')::time,
      nullif(r->>'scheduled_end', '')::time
    );
  end loop;

  return v_schedule_id;
end;
$$;

comment on function public.upsert_work_schedule(uuid, text, jsonb) is
  'Crea o actualiza un horario y reemplaza sus reglas por día en una sola '
  'transacción. SECURITY INVOKER: la RLS work_schedules_write_admin sigue '
  'siendo el gate de autorización.';

-- ---------------------------------------------------------------------------
-- Asignación de horario a un trabajador

create or replace function public.apply_schedule_assignment(
  p_employee_id uuid,
  p_work_schedule_id uuid,
  p_effective_from date
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current record;
begin
  select id, work_schedule_id, effective_from, effective_to
    into v_current
  from public.schedule_assignments
  where employee_id = p_employee_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to >= p_effective_from)
  limit 1;

  -- Ya rige exactamente este horario en esa fecha: idempotente, no versiona
  -- por versionar (evita ensuciar el historial al reaplicar la acción masiva).
  if found and v_current.work_schedule_id = p_work_schedule_id then
    return;
  end if;

  -- Una asignación que EMPIEZA el mismo día se corrige en su lugar; cerrarla
  -- en `p_effective_from - 1` produciría un rango invertido.
  if found and v_current.effective_from = p_effective_from then
    update public.schedule_assignments
      set work_schedule_id = p_work_schedule_id
    where id = v_current.id;
    return;
  end if;

  if found then
    update public.schedule_assignments
      set effective_to = p_effective_from - 1
    where id = v_current.id;
  end if;

  -- Una asignación FUTURA no se toca en silencio: cambiar el horario vigente
  -- sin avisar que hay otro programado más adelante sería engañoso.
  if exists (
    select 1 from public.schedule_assignments
    where employee_id = p_employee_id and effective_from > p_effective_from
  ) then
    raise exception 'Este trabajador ya tiene un horario programado a futuro. Elimínalo antes de reasignar desde %.', p_effective_from;
  end if;

  insert into public.schedule_assignments (employee_id, work_schedule_id, effective_from)
  values (p_employee_id, p_work_schedule_id, p_effective_from);
end;
$$;

comment on function public.apply_schedule_assignment(uuid, uuid, date) is
  'Cierra la asignación vigente en effective_from - 1 (el rango de exclusión '
  'es inclusivo en ambos extremos) e inserta la nueva, atómicamente. '
  'Idempotente si ya rige el mismo horario.';

-- ---------------------------------------------------------------------------
-- Acción masiva: horario base para quien todavía no tiene ninguno

create or replace function public.assign_schedule_to_unassigned(
  p_work_schedule_id uuid,
  p_effective_from date
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer := 0;
  e record;
begin
  for e in
    select emp.id
    from public.employees emp
    where emp.active
      and not exists (
        select 1 from public.schedule_assignments sa
        where sa.employee_id = emp.id
          and sa.effective_from <= p_effective_from
          and (sa.effective_to is null or sa.effective_to >= p_effective_from)
      )
      -- Un trabajador exento de control horario no necesita horario: asignarle
      -- uno sería ruido, y `resolveEffectiveSchedule` corta en la exención
      -- antes de siquiera mirar `schedule_assignments`.
      and not exists (
        select 1 from public.employee_time_control_policies tcp
        where tcp.employee_id = emp.id
          and tcp.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
          and tcp.effective_from <= p_effective_from
          and (tcp.effective_to is null or tcp.effective_to >= p_effective_from)
      )
  loop
    perform public.apply_schedule_assignment(e.id, p_work_schedule_id, p_effective_from);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.assign_schedule_to_unassigned(uuid, date) is
  'Asigna el horario indicado a todo trabajador activo que no tenga uno '
  'vigente en esa fecha y no esté exento de control horario. Devuelve cuántos '
  'quedaron asignados. Nunca pisa una asignación existente.';

-- ---------------------------------------------------------------------------
-- Exención de control horario

create or replace function public.set_time_control_exemption(
  p_employee_id uuid,
  p_legal_basis text,
  p_effective_from date,
  p_reason text,
  p_actor_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current record;
begin
  select id, policy_code, legal_basis, effective_from
    into v_current
  from public.employee_time_control_policies
  where employee_id = p_employee_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to >= p_effective_from)
  limit 1;

  if found
     and v_current.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
     and v_current.legal_basis = p_legal_basis then
    return;
  end if;

  if found and v_current.effective_from = p_effective_from then
    update public.employee_time_control_policies
      set policy_code = 'EXEMPT_FROM_TIME_CONTROL',
          legal_basis = p_legal_basis,
          reason = p_reason
    where id = v_current.id;
    return;
  end if;

  if found then
    update public.employee_time_control_policies
      set effective_to = p_effective_from - 1
    where id = v_current.id;
  end if;

  insert into public.employee_time_control_policies
    (employee_id, policy_code, legal_basis, effective_from, reason, created_by)
  values
    (p_employee_id, 'EXEMPT_FROM_TIME_CONTROL', p_legal_basis, p_effective_from, p_reason, p_actor_id);
end;
$$;

comment on function public.set_time_control_exemption(uuid, text, date, text, uuid) is
  'Marca a un trabajador como exento de control horario desde una fecha, '
  'cerrando la política vigente. Idempotente si ya rige la misma exención.';

create or replace function public.clear_time_control_exemption(
  p_employee_id uuid,
  p_effective_from date
)
returns void
language plpgsql
set search_path = public
as $$
begin
  -- Una exención que YA estuvo vigente se cierra, nunca se borra: el registro
  -- histórico de que la persona estuvo exenta se conserva (mismo patrón de
  -- hecho-inmutable-versionado del resto del esquema).
  update public.employee_time_control_policies
    set effective_to = p_effective_from - 1
  where employee_id = p_employee_id
    and policy_code = 'EXEMPT_FROM_TIME_CONTROL'
    and effective_to is null
    and effective_from < p_effective_from;

  -- Una que empieza hoy o a futuro sí se borra: nunca llegó a producir ningún
  -- efecto sobre el motor de reglas, así que es la corrección de un error de
  -- carga, no un hecho histórico que valga la pena conservar. Sin esto,
  -- cancelar el mismo día una exención recién creada no haría nada (el UPDATE
  -- de arriba exige effective_from < p_effective_from).
  delete from public.employee_time_control_policies
  where employee_id = p_employee_id
    and policy_code = 'EXEMPT_FROM_TIME_CONTROL'
    and effective_from >= p_effective_from;
end;
$$;

comment on function public.clear_time_control_exemption(uuid, date) is
  'Devuelve a un trabajador a control horario normal cerrando su exención '
  'vigente. La exención pasada se conserva como historial.';

-- ---------------------------------------------------------------------------
-- Grants: mismos que el resto de RPC de administración. La autorización real
-- la sigue aplicando la RLS de cada tabla (is_privileged_admin()), no el grant.

grant execute on function public.upsert_work_schedule(uuid, text, jsonb) to authenticated;
grant execute on function public.apply_schedule_assignment(uuid, uuid, date) to authenticated;
grant execute on function public.assign_schedule_to_unassigned(uuid, date) to authenticated;
grant execute on function public.set_time_control_exemption(uuid, text, date, text, uuid) to authenticated;
grant execute on function public.clear_time_control_exemption(uuid, date) to authenticated;
