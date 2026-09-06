-- Cierra tres ventanas de consistencia del motor de asistencia:
--   1. una decisión no puede nacer sobre un candidato o attendance histórico;
--   2. salida anticipada tiene la misma unicidad vigente que atraso/overtime;
--   3. el reclaim de corridas queda aislado por empresa.

-- Reconciliación defensiva previa al índice. Si una carrera histórica dejó más
-- de una salida vigente, conserva solo la versión calculada más reciente.
with ranked_current as (
  select
    id,
    row_number() over (
      partition by employee_id, work_date
      order by calculation_version desc, calculated_at desc, id desc
    ) as position
  from public.early_departure_records
  where is_current
)
update public.early_departure_records edr
set is_current = false
from ranked_current ranked
where edr.id = ranked.id
  and ranked.position > 1;

create unique index if not exists early_departure_records_current_per_day_key
  on public.early_departure_records (employee_id, work_date)
  where is_current;

create index if not exists early_departure_records_attendance_record_id_idx
  on public.early_departure_records (attendance_record_id);

-- El chequeo de aplicación mejora el mensaje, pero no resuelve la carrera
-- SELECT -> INSERT. Este trigger bloquea la fila candidata dentro de la misma
-- transacción del INSERT y valida también la asistencia raíz. Se bloquea en el
-- mismo orden usado por la reconciliación (candidato -> asistencia raíz). Si
-- el motor ganó la carrera y retiró cualquiera de los dos, la decisión se
-- rechaza; si la decisión ganó, el recálculo espera.
create or replace function public.assert_decision_candidate_is_current()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate_id uuid;
  v_attendance_record_id uuid;
  v_candidate_is_current boolean;
  v_attendance_is_current boolean;
begin
  case tg_table_name
    when 'late_arrival_decisions' then
      select lar.id, lar.attendance_record_id, lar.is_current
        into v_candidate_id, v_attendance_record_id, v_candidate_is_current
      from public.late_arrival_records lar
      where lar.id = new.late_arrival_record_id
      for update;
    when 'early_departure_decisions' then
      select edr.id, edr.attendance_record_id, edr.is_current
        into v_candidate_id, v_attendance_record_id, v_candidate_is_current
      from public.early_departure_records edr
      where edr.id = new.early_departure_record_id
      for update;
    when 'overtime_decisions' then
      select ovr.id, ovr.attendance_record_id, ovr.is_current
        into v_candidate_id, v_attendance_record_id, v_candidate_is_current
      from public.overtime_records ovr
      where ovr.id = new.overtime_record_id
      for update;
    else
      raise exception 'assert_decision_candidate_is_current attached to unsupported table %', tg_table_name;
  end case;

  if v_candidate_id is null or v_candidate_is_current is distinct from true then
    raise exception 'Cannot decide a stale or missing attendance candidate.';
  end if;

  select ar.is_current
    into v_attendance_is_current
  from public.attendance_records ar
  where ar.id = v_attendance_record_id
  for update;

  if v_attendance_is_current is distinct from true then
    raise exception 'Cannot decide a candidate whose attendance record is stale or missing.';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_decision_candidate_is_current() from public, anon, authenticated;

drop trigger if exists late_arrival_decisions_candidate_current_guard
  on public.late_arrival_decisions;
create trigger late_arrival_decisions_candidate_current_guard
  before insert on public.late_arrival_decisions
  for each row execute function public.assert_decision_candidate_is_current();

drop trigger if exists early_departure_decisions_candidate_current_guard
  on public.early_departure_decisions;
create trigger early_departure_decisions_candidate_current_guard
  before insert on public.early_departure_decisions
  for each row execute function public.assert_decision_candidate_is_current();

drop trigger if exists overtime_decisions_candidate_current_guard
  on public.overtime_decisions;
create trigger overtime_decisions_candidate_current_guard
  before insert on public.overtime_decisions
  for each row execute function public.assert_decision_candidate_is_current();

-- La firma anterior solo recibía el umbral y barría todos los tenants. Se
-- elimina para que ningún caller nuevo pueda omitir accidentalmente empresa.
drop function if exists public.reclaim_stale_rule_engine_runs(integer);

create function public.reclaim_stale_rule_engine_runs(
  p_company_id uuid,
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_company_id is null then
    raise exception 'p_company_id is required';
  end if;
  if p_stale_after_seconds < 1 then
    raise exception 'p_stale_after_seconds must be positive';
  end if;

  update public.rule_engine_runs
    set status = 'FAILED',
        finished_at = now(),
        error_summary = 'Corrida abandonada: superó el umbral sin finalizar.'
  where company_id = p_company_id
    and status = 'RUNNING'
    and started_at < now() - make_interval(secs => p_stale_after_seconds);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.reclaim_stale_rule_engine_runs(uuid, integer) is
  'Marca FAILED únicamente las corridas RUNNING abandonadas de la empresa explícita.';

revoke all on function public.reclaim_stale_rule_engine_runs(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.reclaim_stale_rule_engine_runs(uuid, integer)
  to service_role;
