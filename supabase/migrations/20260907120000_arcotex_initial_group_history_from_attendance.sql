-- La reconstrucción inicial del historial de grupo incorporada en
-- 20260906210000 consideraba hechos derivados, pero no las marcaciones crudas
-- de Workera. Al importar una semana histórica para un trabajador nuevo, el
-- grupo interno comenzaba en su primer día ya derivado (o hoy), y el motor no
-- podía reconciliar atrasos/horas extra de los días crudos anteriores.
--
-- Solo se extiende hacia atrás la ÚNICA asignación inicial creada desde el
-- caché interno, sin sync_run y todavía alineada con el grupo actual. Nunca se
-- reescribe una historia real con más de un tramo ni una clasificación cuyo
-- origen sea Workera.
create or replace function private.extend_arcotex_initial_group_history(
  p_employee_id uuid,
  p_observed_date date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment_id uuid;
begin
  if p_employee_id is null or p_observed_date is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_id::text || '|initial-group-history', 11)
  );

  select ega.id
    into v_assignment_id
  from public.employee_group_assignments ega
  join public.employees e
    on e.id = ega.employee_id
   and e.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
   and e.employee_group_id = ega.employee_group_id
  where ega.employee_id = p_employee_id
    and ega.source = 'internal'
    and ega.sync_run_id is null
    and p_observed_date < ega.effective_from
    and (
      select pg_catalog.count(*)
      from public.employee_group_assignments history
      where history.employee_id = p_employee_id
    ) = 1
  for update of ega;

  if v_assignment_id is null then
    return false;
  end if;

  update public.employee_group_assignments
  set effective_from = p_observed_date
  where id = v_assignment_id;
  return true;
end;
$$;

comment on function private.extend_arcotex_initial_group_history(uuid, date) is
  'Extiende hacia una fecha cruda observada solo la asignación inicial interna única de ARCOTEX; preserva cualquier historial real o proveniente de Workera.';

revoke all on function private.extend_arcotex_initial_group_history(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function private.extend_arcotex_group_history_from_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid then
    perform private.extend_arcotex_initial_group_history(
      new.employee_id,
      new.work_date
    );
  end if;
  return new;
end;
$$;

revoke all on function private.extend_arcotex_group_history_from_attendance()
  from public, anon, authenticated, service_role;

drop trigger if exists workera_attendance_extend_arcotex_initial_group
  on public.workera_attendance_events;
create trigger workera_attendance_extend_arcotex_initial_group
  after insert on public.workera_attendance_events
  for each row execute function private.extend_arcotex_group_history_from_attendance();

-- Repara los eventos ya recolectados antes de instalar el trigger. El mínimo
-- por trabajador basta: el helper solo mueve el inicio hacia atrás.
do $backfill_arcotex_initial_group_history$
declare
  observed record;
begin
  for observed in
    select wae.employee_id, pg_catalog.min(wae.work_date) as first_work_date
    from public.workera_attendance_events wae
    where wae.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
    group by wae.employee_id
  loop
    perform private.extend_arcotex_initial_group_history(
      observed.employee_id,
      observed.first_work_date
    );
  end loop;
end;
$backfill_arcotex_initial_group_history$;

do $assert_arcotex_initial_group_history$
begin
  if exists (
    select 1
    from public.employees e
    join public.employee_group_assignments ega
      on ega.employee_id = e.id
     and ega.employee_group_id = e.employee_group_id
     and ega.source = 'internal'
     and ega.sync_run_id is null
    join lateral (
      select pg_catalog.min(wae.work_date) as first_work_date
      from public.workera_attendance_events wae
      where wae.company_id = e.company_id
        and wae.employee_id = e.id
    ) evidence on evidence.first_work_date is not null
    where e.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and (
        select pg_catalog.count(*)
        from public.employee_group_assignments history
        where history.employee_id = e.id
      ) = 1
      and ega.effective_from > evidence.first_work_date
  ) then
    raise exception 'No se pudo cubrir la marcación ARCOTEX más antigua con el historial de grupo inicial.'
      using errcode = '23514';
  end if;
end;
$assert_arcotex_initial_group_history$;
