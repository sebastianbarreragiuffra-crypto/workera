-- Una corrida SUCCEEDED sólo es evidencia útil si también demuestra qué
-- personas procesó. El alcance explícito se persiste como cantidad + SHA-256
-- canónico de UUIDs ordenados; no se guardan listas adicionales ni PII.
alter table public.rule_engine_runs
  add column employee_scope_size integer,
  add column employee_scope_sha256 text,
  add constraint rule_engine_runs_employee_scope_attestation_chk
    check (
      (employee_scope_size is null and employee_scope_sha256 is null)
      or (
        employee_scope_size between 1 and 10000
        and employee_scope_sha256 ~ '^[0-9a-f]{64}$'
      )
    );

comment on column public.rule_engine_runs.employee_scope_size is
  'Cantidad de UUID únicos de un alcance explícito; NULL identifica una corrida histórica/de tenant completo.';
comment on column public.rule_engine_runs.employee_scope_sha256 is
  'SHA-256 de los UUID canónicos ordenados y separados por salto de línea; no contiene nombres ni códigos externos.';

-- Sobrecarga cerrada para padrones explícitos. La firma antigua de cuatro
-- argumentos se conserva para los demás tenants; ARCOTEX usa siempre ésta.
-- Toda la validación ocurre dentro del mismo advisory lock que la apertura.
create or replace function public.begin_attendance_rule_engine_run(
  p_company_id uuid,
  p_work_date date,
  p_triggered_by text,
  p_triggered_by_profile uuid,
  p_employee_ids uuid[]
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
  v_scope_size integer;
  v_scope_sha256 text;
begin
  if p_company_id is null or p_work_date is null
     or p_triggered_by not in ('CRON', 'MANUAL')
     or p_employee_ids is null then
    raise exception 'Comando de inicio del motor invalido.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.active) then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '42501';
  end if;

  v_scope_size := pg_catalog.cardinality(p_employee_ids);
  if v_scope_size < 1 or v_scope_size > 10000 then
    raise exception 'El alcance explicito del motor es invalido.' using errcode = '22023';
  end if;
  if p_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
     and v_scope_size <> 45 then
    raise exception 'El alcance autorizado de ARCOTEX debe contener exactamente 45 empleados.'
      using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(distinct scoped.employee_id)
    from pg_catalog.unnest(p_employee_ids) as scoped(employee_id)
  ) <> v_scope_size then
    raise exception 'El alcance explicito contiene UUID nulos o duplicados.' using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(*)
    from public.employees e
    where e.company_id = p_company_id
      and e.id = any(p_employee_ids)
  ) <> v_scope_size then
    raise exception 'El alcance explicito no pertenece integramente a la empresa.' using errcode = '42501';
  end if;

  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.string_agg(scoped.employee_id::text, E'\n' order by scoped.employee_id::text),
      'sha256'
    ),
    'hex'
  )
  into v_scope_sha256
  from pg_catalog.unnest(p_employee_ids) as scoped(employee_id);

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
      and wae.employee_id = any(p_employee_ids)
      and wae.attendance_status = 'UNKNOWN_EXTERNAL_STATUS'
  ) then
    raise exception 'La fuente contiene estados Workera sin normalizar dentro del alcance autorizado.'
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
    input_revision, day_input_revision, employee_scope_size,
    employee_scope_sha256
  ) values (
    p_company_id, p_work_date, 'RUNNING', p_triggered_by,
    p_triggered_by_profile, v_input_revision, v_day_input_revision,
    v_scope_size, v_scope_sha256
  ) returning id into v_run_id;
  return v_run_id;
end;
$$;

revoke all on function public.begin_attendance_rule_engine_run(
  uuid, date, text, uuid, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.begin_attendance_rule_engine_run(
  uuid, date, text, uuid, uuid[]
) to service_role;

comment on function public.begin_attendance_rule_engine_run(
  uuid, date, text, uuid, uuid[]
) is
  'Abre una corrida fenced sobre un padrón explícito validado y deja una atestación SHA-256 del alcance.';

-- Se agregan al final para conservar el orden/nombre de las columnas ya
-- publicadas por CREATE OR REPLACE VIEW.
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
  ) as is_input_fresh,
  rr.employee_scope_size,
  rr.employee_scope_sha256
from latest_rules rr;

comment on view public.attendance_rule_engine_day_readiness is
  'Última corrida diaria, vigencia causal y atestación agregada de alcance; sin PII.';
