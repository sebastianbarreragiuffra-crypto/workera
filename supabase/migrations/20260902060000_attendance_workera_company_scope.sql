-- MT-3B, recorte 2: aislamiento por empresa del dominio de asistencia.
--
-- El recorte anterior hizo tenant-aware el núcleo laboral (employees,
-- grupos, horarios y supervisión). Este recorte propaga esa frontera a la
-- ingesta Workera, los hechos diarios y las bitácoras automáticas. ARCOTEX es
-- la única empresa operacional existente; el UUID explícito se usa SOLO para
-- backfill de datos históricos. Las columnas nuevas quedan sin DEFAULT para
-- que toda corrida futura declare su tenant.

do $$
begin
  if not exists (
    select 1
    from public.companies
    where id = '0a4c0000-0000-0000-0000-000000000001'
      and slug = 'arcotex'
  ) then
    raise exception 'MT-3B attendance backfill requires the canonical ARCOTEX company';
  end if;
end;
$$;

-- ADD COLUMN con default constante rellena filas históricas sin disparar los
-- triggers de inmutabilidad. El default se retira inmediatamente después.
alter table public.sync_runs
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';
alter table public.attendance_records
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';
alter table public.attendance_status_records
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';
alter table public.attendance_corrections
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';
alter table public.workera_attendance_events
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';
alter table public.rule_engine_runs
  add column company_id uuid not null default '0a4c0000-0000-0000-0000-000000000001';

alter table public.sync_runs alter column company_id drop default;
alter table public.attendance_records alter column company_id drop default;
alter table public.attendance_status_records alter column company_id drop default;
alter table public.attendance_corrections alter column company_id drop default;
alter table public.workera_attendance_events alter column company_id drop default;
alter table public.rule_engine_runs alter column company_id drop default;

comment on column public.sync_runs.company_id is
  'Tenant explícito de la corrida Workera. Sin default: todo job debe declarar la empresa.';
comment on column public.rule_engine_runs.company_id is
  'Tenant explícito de la corrida del motor. Sin default: todo job debe declarar la empresa.';

-- El tenant de un hecho ligado a empleado se deriva de la identidad interna,
-- nunca de un dato externo. Esto conserva compatibilidad con inserciones SQL
-- históricas y falla cerrado si un llamador intenta declarar otra empresa.
create or replace function public.bind_employee_company_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select e.company_id
    into v_company_id
  from public.employees e
  where e.id = new.employee_id;

  if v_company_id is null then
    raise exception 'Employee % does not exist or has no company scope', new.employee_id
      using errcode = '23503';
  end if;

  if new.company_id is null then
    new.company_id := v_company_id;
  elsif new.company_id <> v_company_id then
    raise exception 'Employee % belongs to company %, not %',
      new.employee_id, v_company_id, new.company_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.bind_employee_company_scope() from public, anon, authenticated;

create trigger attendance_records_bind_company
  before insert on public.attendance_records
  for each row execute function public.bind_employee_company_scope();
create trigger attendance_status_records_bind_company
  before insert on public.attendance_status_records
  for each row execute function public.bind_employee_company_scope();
create trigger attendance_corrections_bind_company
  before insert on public.attendance_corrections
  for each row execute function public.bind_employee_company_scope();
create trigger workera_attendance_events_bind_company
  before insert on public.workera_attendance_events
  for each row execute function public.bind_employee_company_scope();

-- Claves compuestas: ninguna referencia puede cruzar empresas aunque un bug
-- de service_role envíe UUIDs válidos de tenants distintos.
alter table public.sync_runs
  add constraint sync_runs_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint sync_runs_company_id_id_key unique (company_id, id);

alter table public.attendance_records
  drop constraint attendance_records_employee_id_fkey,
  drop constraint attendance_records_sync_run_id_fkey,
  drop constraint attendance_records_version_key,
  add constraint attendance_records_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint attendance_records_company_id_id_key unique (company_id, id),
  add constraint attendance_records_company_employee_fkey
    foreign key (company_id, employee_id) references public.employees(company_id, id),
  add constraint attendance_records_company_sync_run_fkey
    foreign key (company_id, sync_run_id) references public.sync_runs(company_id, id),
  add constraint attendance_records_version_key
    unique (company_id, employee_id, work_date, source_version);

alter table public.attendance_status_records
  drop constraint attendance_status_records_employee_id_fkey,
  drop constraint attendance_status_records_sync_run_id_fkey,
  drop constraint attendance_status_records_version_key,
  add constraint attendance_status_records_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint attendance_status_records_company_id_id_key unique (company_id, id),
  add constraint attendance_status_records_company_employee_fkey
    foreign key (company_id, employee_id) references public.employees(company_id, id),
  add constraint attendance_status_records_company_sync_run_fkey
    foreign key (company_id, sync_run_id) references public.sync_runs(company_id, id),
  add constraint attendance_status_records_version_key
    unique (company_id, employee_id, work_date, source_version);

alter table public.attendance_corrections
  drop constraint attendance_corrections_attendance_record_id_fkey,
  drop constraint attendance_corrections_employee_id_fkey,
  add constraint attendance_corrections_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint attendance_corrections_company_employee_fkey
    foreign key (company_id, employee_id) references public.employees(company_id, id),
  add constraint attendance_corrections_company_record_fkey
    foreign key (company_id, attendance_record_id) references public.attendance_records(company_id, id);

alter table public.workera_attendance_events
  drop constraint workera_attendance_events_employee_id_fkey,
  drop constraint workera_attendance_events_sync_run_id_fkey,
  drop constraint workera_attendance_events_fingerprint_version_key,
  add constraint workera_attendance_events_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint workera_attendance_events_company_employee_fkey
    foreign key (company_id, employee_id) references public.employees(company_id, id),
  add constraint workera_attendance_events_company_sync_run_fkey
    foreign key (company_id, sync_run_id) references public.sync_runs(company_id, id),
  add constraint workera_attendance_events_fingerprint_version_key
    unique (company_id, external_fingerprint, source_version);

alter table public.rule_engine_runs
  add constraint rule_engine_runs_company_id_fkey foreign key (company_id) references public.companies(id);

alter table public.sync_runs
  drop constraint sync_runs_retry_of_fkey,
  add constraint sync_runs_company_retry_of_fkey
    foreign key (company_id, retry_of) references public.sync_runs(company_id, id);

-- Idempotencia y locks son por tenant, no globales.
drop index public.attendance_records_current_key;
create unique index attendance_records_current_key
  on public.attendance_records (company_id, employee_id, work_date)
  where is_current;
drop index public.attendance_records_source_external_id_key;
create unique index attendance_records_source_external_id_key
  on public.attendance_records (company_id, source, external_id)
  where external_id is not null;

drop index public.attendance_status_records_current_key;
create unique index attendance_status_records_current_key
  on public.attendance_status_records (company_id, employee_id, work_date)
  where is_current;
drop index public.attendance_status_records_source_external_id_key;
create unique index attendance_status_records_source_external_id_key
  on public.attendance_status_records (company_id, source, external_id)
  where external_id is not null;

drop index public.attendance_corrections_current_key;
create unique index attendance_corrections_current_key
  on public.attendance_corrections (company_id, attendance_record_id)
  where is_current;

drop index public.workera_attendance_events_fingerprint_current_key;
create unique index workera_attendance_events_fingerprint_current_key
  on public.workera_attendance_events (company_id, external_fingerprint)
  where is_current;

drop index public.sync_runs_no_concurrent_running_key;
create unique index sync_runs_no_concurrent_running_key
  on public.sync_runs (company_id, target_period_start, target_period_end)
  where status = 'RUNNING';

drop index public.rule_engine_runs_no_concurrent_running_key;
create unique index rule_engine_runs_no_concurrent_running_key
  on public.rule_engine_runs (company_id, work_date)
  where status = 'RUNNING';

create index sync_runs_company_started_idx
  on public.sync_runs (company_id, started_at desc);
create index rule_engine_runs_company_work_date_idx
  on public.rule_engine_runs (company_id, work_date desc, started_at desc);

-- Reclaim explícito por tenant. Se elimina la firma global para impedir que
-- una corrida de una empresa modifique locks abandonados de otra.
drop function public.reclaim_stale_workera_sync_runs(integer);
create function public.reclaim_stale_workera_sync_runs(
  p_company_id uuid,
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count integer;
begin
  update public.sync_runs
    set status = 'FAILED',
        finished_at = now(),
        error_category = 'CONCURRENCY',
        error_summary = jsonb_build_object(
          'reason', 'STALE_RUNNING_RECLAIMED',
          'started_at', started_at
        )
  where company_id = p_company_id
    and status = 'RUNNING'
    and started_at < now() - make_interval(secs => p_stale_after_seconds);

  get diagnostics v_row_count = row_count;
  return v_row_count;
end;
$$;
revoke all on function public.reclaim_stale_workera_sync_runs(uuid, integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_workera_sync_runs(uuid, integer) to service_role;

drop function public.reclaim_stale_rule_engine_runs(integer);
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
revoke all on function public.reclaim_stale_rule_engine_runs(uuid, integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_rule_engine_runs(uuid, integer) to service_role;

-- Lectura operacional aislada por membresía activa. Los checks de rol
-- existentes se conservan; la pertenencia al tenant se suma, no los reemplaza.
drop policy attendance_records_select on public.attendance_records;
create policy attendance_records_select on public.attendance_records
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

drop policy attendance_corrections_select on public.attendance_corrections;
create policy attendance_corrections_select on public.attendance_corrections
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));
drop policy attendance_corrections_insert on public.attendance_corrections;
create policy attendance_corrections_insert on public.attendance_corrections
  for insert to authenticated
  with check (
    corrected_by = auth.uid()
    and public.is_active_company_member(company_id)
    and public.can_manage_employee(employee_id)
  );
drop policy attendance_corrections_update_admin on public.attendance_corrections;
create policy attendance_corrections_update_admin on public.attendance_corrections
  for update to authenticated
  using (public.is_admin_rrhh() and public.is_active_company_member(company_id))
  with check (public.is_admin_rrhh() and public.is_active_company_member(company_id));

drop policy attendance_status_records_select on public.attendance_status_records;
create policy attendance_status_records_select on public.attendance_status_records
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));
drop policy attendance_status_records_insert on public.attendance_status_records;
create policy attendance_status_records_insert on public.attendance_status_records
  for insert to authenticated
  with check (
    public.is_active_company_member(company_id)
    and case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else public.is_admin_rrhh()
    end
  );
drop policy attendance_status_records_update_admin on public.attendance_status_records;
create policy attendance_status_records_update_admin on public.attendance_status_records
  for update to authenticated
  using (public.is_admin_rrhh() and public.is_active_company_member(company_id))
  with check (public.is_admin_rrhh() and public.is_active_company_member(company_id));

drop policy sync_runs_select_admin on public.sync_runs;
create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated
  using (public.is_admin_rrhh() and public.is_active_company_member(company_id));

drop policy workera_attendance_events_select on public.workera_attendance_events;
create policy workera_attendance_events_select on public.workera_attendance_events
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

drop policy rule_engine_runs_select on public.rule_engine_runs;
create policy rule_engine_runs_select on public.rule_engine_runs
  for select to authenticated
  using (public.is_corporate_user() and public.is_active_company_member(company_id));

