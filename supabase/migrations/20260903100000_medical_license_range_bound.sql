-- Cota al rango confirmado al aprobar una licencia médica.
--
-- Hallazgo: `approve_medical_license` recorre el rango día por día con un
-- `while`, y cada vuelta hace un SELECT, un UPDATE y un INSERT sobre
-- `attendance_status_records`. La función validaba el rol y que la fecha de
-- término no fuera anterior a la de inicio, pero NADA acotaba el largo del
-- rango -- ni la función, ni la Server Action, que solo comparaba ambas fechas
-- entre sí.
--
-- Confirmar 1900-01-01 a 2999-12-31 significaba ~401.000 vueltas y más de un
-- millón de sentencias en una sola transacción: la petición queda colgada y el
-- historial de asistencia de esa persona termina con cientos de miles de "L".
-- No hace falta mala intención: el aprobador puede editar el rango propuesto
-- en el panel de aprobación, así que escribir 2926 en vez de 2026 basta.
--
-- El límite se aplica ACÁ, que es el enforcement real -- la validación
-- equivalente en la Server Action es una segunda capa con mejor mensaje, nunca
-- la única barrera. 366 días cubre con holgura incluso una licencia prolongada
-- de un año completo; un reposo más largo se registra como licencias
-- sucesivas, que es como ya funciona el trámite.

create or replace function public.approve_medical_license(
  p_approval_id uuid,
  p_confirmed_start_date date,
  p_confirmed_end_date date
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_absence_record_id uuid;
  v_employee_id uuid;
  v_l_status_id uuid;
  v_date date;
  v_current_id uuid;
  v_current_version integer;
  v_max_days constant integer := 366;
begin
  if not public.is_medical_license_approver() then
    raise exception 'No autorizado para aprobar licencias médicas.';
  end if;
  if p_confirmed_end_date < p_confirmed_start_date then
    raise exception 'La fecha de término no puede ser anterior a la fecha de inicio.';
  end if;
  if (p_confirmed_end_date - p_confirmed_start_date) + 1 > v_max_days then
    raise exception
      'El rango confirmado (% días) supera el máximo de % días para una licencia médica.',
      (p_confirmed_end_date - p_confirmed_start_date) + 1, v_max_days;
  end if;

  select absence_record_id into v_absence_record_id
    from public.medical_license_approvals
    where id = p_approval_id and status = 'PENDING_RRHH_APPROVAL';
  if v_absence_record_id is null then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;

  select employee_id into v_employee_id from public.absence_records where id = v_absence_record_id;
  select id into v_l_status_id from public.attendance_statuses where code = 'L';
  if v_l_status_id is null then
    raise exception 'No se encontró el código de asistencia "L" en el catálogo.';
  end if;

  v_date := p_confirmed_start_date;
  while v_date <= p_confirmed_end_date loop
    select id, source_version into v_current_id, v_current_version
      from public.attendance_status_records
      where employee_id = v_employee_id and work_date = v_date and is_current;

    if v_current_id is not null then
      update public.attendance_status_records set is_current = false where id = v_current_id;
    end if;

    insert into public.attendance_status_records (
      employee_id, work_date, attendance_status_id, source, source_hash, source_version, created_by, reason
    ) values (
      v_employee_id, v_date, v_l_status_id, 'manual',
      md5(v_employee_id::text || '|' || v_date::text || '|L|' || p_approval_id::text),
      coalesce(v_current_version, 0) + 1,
      auth.uid(),
      'Licencia médica aprobada'
    );

    v_current_id := null;
    v_current_version := null;
    v_date := v_date + 1;
  end loop;

  update public.medical_license_approvals
    set status = 'APPROVED',
        approved_by = auth.uid(),
        approved_at = now(),
        confirmed_start_date = p_confirmed_start_date,
        confirmed_end_date = p_confirmed_end_date
    where id = p_approval_id;
end;
$$;

comment on function public.approve_medical_license(uuid, date, date) is
  'Aprueba una licencia médica y proyecta "L" en attendance_status_records '
  'para cada día del rango confirmado. El rango está acotado a 366 días: la '
  'función escribe una fila por día, así que un rango sin límite es una '
  'amplificación de escritura sobre el historial de asistencia.';

grant execute on function public.approve_medical_license(uuid, date, date) to authenticated;
