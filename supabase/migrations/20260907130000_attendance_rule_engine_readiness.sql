-- El motor no puede abrir una corrida autoritativa sobre una fuente vacía,
-- fallida o todavía no normalizada. La comprobación vive dentro del mismo
-- advisory lock que serializa sync y reglas, evitando un TOCTOU entre el
-- chequeo operativo y la creación del lease.
create or replace function public.begin_attendance_rule_engine_run(
  p_company_id uuid,
  p_work_date date,
  p_triggered_by text,
  p_triggered_by_profile uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_input_revision bigint;
  v_day_input_revision bigint;
  v_sync public.sync_runs%rowtype;
  v_sync_required_from date;
begin
  if p_company_id is null or p_work_date is null
     or p_triggered_by not in ('CRON', 'MANUAL') then
    raise exception 'Comando de inicio del motor invalido.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.active) then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if exists (
    select 1 from public.sync_runs sr
    where sr.company_id = p_company_id
      and sr.status = 'RUNNING'
      and p_work_date between sr.target_period_start and sr.target_period_end
  ) or exists (
    select 1 from public.rule_engine_runs rr
    where rr.company_id = p_company_id
      and rr.work_date = p_work_date
      and rr.status = 'RUNNING'
  ) then
    return null;
  end if;

  select r.required_from into v_sync_required_from
  from private.workera_sync_requirements r
  where r.company_id = p_company_id;

  select sr.* into v_sync
  from public.sync_runs sr
  where sr.company_id = p_company_id
    and p_work_date between sr.target_period_start and sr.target_period_end
  order by sr.started_at desc, sr.id desc
  limit 1;

  if v_sync.id is null then
    if v_sync_required_from is not null and p_work_date >= v_sync_required_from then
      raise exception 'Falta una sincronizacion Workera valida para la fecha solicitada.'
        using errcode = '55000';
    end if;
  elsif v_sync.status <> 'SUCCEEDED' or v_sync.finished_at is null then
    raise exception 'La ultima sincronizacion Workera de la fecha no termino correctamente.'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.workera_attendance_events wae
    where wae.company_id = p_company_id
      and wae.work_date = p_work_date
      and wae.is_current
      and wae.attendance_status = 'UNKNOWN_EXTERNAL_STATUS'
  ) then
    raise exception 'La fuente contiene estados Workera sin normalizar.'
      using errcode = '55000';
  end if;

  insert into private.attendance_engine_input_revisions as r (
    company_id, revision, changed_at
  ) values (
    p_company_id, 1, pg_catalog.clock_timestamp()
  ) on conflict (company_id) do update
    set revision = r.revision
  returning revision into v_input_revision;
  insert into private.attendance_engine_day_input_revisions as r (
    company_id, work_date, revision, changed_at
  ) values (
    p_company_id, p_work_date, 0, pg_catalog.clock_timestamp()
  ) on conflict (company_id, work_date) do update
    set revision = r.revision
  returning revision into v_day_input_revision;

  insert into public.rule_engine_runs (
    company_id, work_date, status, triggered_by, triggered_by_profile,
    input_revision, day_input_revision
  ) values (
    p_company_id, p_work_date, 'RUNNING', p_triggered_by,
    p_triggered_by_profile, v_input_revision, v_day_input_revision
  ) returning id into v_run_id;
  return v_run_id;
end;
$$;

revoke all on function public.begin_attendance_rule_engine_run(uuid, date, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_attendance_rule_engine_run(uuid, date, text, uuid)
  to service_role;

-- El helper queda en un esquema no expuesto y solo devuelve un booleano. Así
-- la vista puede ser security_invoker (sin saltarse RLS) aunque las revisiones
-- subyacentes continúen completamente privadas.
create or replace function private.attendance_rule_engine_input_is_fresh(
  p_company_id uuid,
  p_work_date date,
  p_finished_at timestamptz,
  p_input_revision bigint,
  p_day_input_revision bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with latest_sync as (
    select sr.status, sr.finished_at
    from public.sync_runs sr
    where sr.company_id = p_company_id
      and p_work_date between sr.target_period_start and sr.target_period_end
    order by sr.started_at desc, sr.id desc
    limit 1
  )
  select
    p_finished_at is not null
    and exists (
      select 1
      from private.attendance_engine_input_revisions r
      where r.company_id = p_company_id
        and r.revision = p_input_revision
    )
    and exists (
      select 1
      from private.attendance_engine_day_input_revisions r
      where r.company_id = p_company_id
        and r.work_date = p_work_date
        and r.revision = p_day_input_revision
    )
    and (
      (
        not exists (select 1 from latest_sync)
        and not exists (
          select 1
          from private.workera_sync_requirements requirement
          where requirement.company_id = p_company_id
            and p_work_date >= requirement.required_from
        )
      )
      or exists (
        select 1
        from latest_sync sync
        where sync.status = 'SUCCEEDED'
          and sync.finished_at is not null
          and p_finished_at >= sync.finished_at
      )
    );
$$;

revoke all on function private.attendance_rule_engine_input_is_fresh(
  uuid, date, timestamptz, bigint, bigint
) from public, anon, authenticated, service_role;
grant execute on function private.attendance_rule_engine_input_is_fresh(
  uuid, date, timestamptz, bigint, bigint
) to service_role;

-- Superficie agregada y de solo lectura para el preflight. Publica únicamente
-- el último ledger diario y una señal booleana de frescura; las revisiones
-- privadas y los datos personales nunca salen de la base.
create or replace view public.attendance_rule_engine_day_readiness
with (security_invoker = true, security_barrier = true)
as
with ranked_rules as (
  select
    rr.*,
    pg_catalog.row_number() over (
      partition by rr.company_id, rr.work_date
      order by rr.started_at desc, rr.id desc
    ) as readiness_rank
  from public.rule_engine_runs rr
),
latest_rules as (
  select * from ranked_rules where readiness_rank = 1
)
select
  rr.id as rule_engine_run_id,
  rr.company_id,
  rr.work_date,
  rr.status,
  rr.started_at,
  rr.finished_at,
  rr.employees_processed,
  rr.attendance_derived,
  rr.late_candidates,
  rr.early_departure_candidates,
  rr.overtime_candidates,
  rr.without_schedule,
  rr.failure_count,
  private.attendance_rule_engine_input_is_fresh(
    rr.company_id,
    rr.work_date,
    rr.finished_at,
    rr.input_revision,
    rr.day_input_revision
  ) as is_input_fresh
from latest_rules rr;

comment on view public.attendance_rule_engine_day_readiness is
  'Última corrida diaria y señal agregada de vigencia causal contra sync y revisiones privadas; sin PII.';

revoke all on public.attendance_rule_engine_day_readiness
  from public, anon, authenticated, service_role;
grant select on public.attendance_rule_engine_day_readiness to service_role;
