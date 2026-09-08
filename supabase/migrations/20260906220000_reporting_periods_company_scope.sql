-- Pre-nomina multiempresa, fase 1: el periodo deja de ser global.
--
-- Todo el historial existente pertenece a ARCOTEX. El UUID sentinel se usa
-- solo para ese backfill y como compatibilidad temporal de inserts SQL
-- antiguos; la aplicacion pasa company_id de forma explicita. No habilita el
-- workspace laboral de otra empresa ni modifica datos productivos por si sola.

alter table public.reporting_periods
  add column company_id uuid
    references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';

update public.reporting_periods
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;

alter table public.reporting_periods
  alter column company_id set not null;

alter table public.reporting_periods
  drop constraint reporting_periods_no_overlap;

alter table public.reporting_periods
  add constraint reporting_periods_company_id_id_key unique (company_id, id),
  add constraint reporting_periods_company_dates_key
    unique (company_id, period_start, period_end),
  add constraint reporting_periods_no_overlap
    exclude using gist (
      company_id with =,
      daterange(period_start, period_end, '[]') with &&
    );

create index reporting_periods_company_recent_idx
  on public.reporting_periods(company_id, period_start desc);

comment on column public.reporting_periods.company_id is
  'Empresa duena del ciclo 16-15. El mismo rango puede existir en empresas distintas; nunca se comparte estado, aprobacion ni cierre.';

-- Las versiones y operaciones de cierre ya declaraban company_id, pero sus
-- FKs validaban solo el UUID global del periodo. Las relaciones compuestas
-- impiden enlazar una version, conflicto, aprobacion u operacion a un periodo
-- de otra empresa, incluso desde service_role.
alter table public.payroll_workbook_versions
  add constraint payroll_workbook_versions_company_id_id_key
    unique (company_id, id),
  drop constraint payroll_workbook_versions_reporting_period_id_fkey,
  add constraint payroll_workbook_versions_company_period_fkey
    foreign key (company_id, reporting_period_id)
    references public.reporting_periods(company_id, id);

alter table public.payroll_workbook_conflicts
  drop constraint payroll_workbook_conflicts_reporting_period_id_fkey,
  add constraint payroll_workbook_conflicts_company_period_fkey
    foreign key (company_id, reporting_period_id)
    references public.reporting_periods(company_id, id);

alter table public.reporting_period_approvals
  drop constraint reporting_period_approvals_reporting_period_id_fkey,
  drop constraint reporting_period_approvals_accepted_workbook_version_id_fkey,
  add constraint reporting_period_approvals_company_period_fkey
    foreign key (company_id, reporting_period_id)
    references public.reporting_periods(company_id, id),
  add constraint reporting_period_approvals_company_version_fkey
    foreign key (company_id, accepted_workbook_version_id)
    references public.payroll_workbook_versions(company_id, id);

alter table private.payroll_period_close_operations
  drop constraint payroll_period_close_operations_reporting_period_id_fkey,
  drop constraint payroll_period_close_operations_base_version_id_fkey,
  drop constraint payroll_period_close_operations_snapshot_version_id_fkey,
  add constraint payroll_period_close_operations_company_period_fkey
    foreign key (company_id, reporting_period_id)
    references public.reporting_periods(company_id, id),
  add constraint payroll_period_close_operations_company_base_version_fkey
    foreign key (company_id, base_version_id)
    references public.payroll_workbook_versions(company_id, id),
  add constraint payroll_period_close_operations_company_snapshot_version_fkey
    foreign key (company_id, snapshot_version_id)
    references public.payroll_workbook_versions(company_id, id);

-- RLS por tenant. El gate workspace_enabled conserva el NO-GO vigente para
-- cualquier segundo workspace laboral hasta completar MT-3B-D.
drop policy if exists reporting_periods_select on public.reporting_periods;
drop policy if exists reporting_periods_insert_admin on public.reporting_periods;
drop policy if exists reporting_periods_update_admin on public.reporting_periods;

create policy reporting_periods_select on public.reporting_periods
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and exists (
      select 1 from public.companies c
      where c.id = company_id
        and c.active
        and c.status = 'ACTIVE'
        and c.workspace_enabled
    )
  );

create policy reporting_periods_insert_admin on public.reporting_periods
  for insert to authenticated
  with check (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    and coalesce(public.request_is_aal2(), false)
    and status = 'OPEN'
    and closed_by is null
    and closed_at is null
    and reopened_by is null
    and reopened_at is null
    and reopen_reason is null
    and exists (
      select 1 from public.companies c
      where c.id = company_id
        and c.active
        and c.status = 'ACTIVE'
        and c.workspace_enabled
    )
  );

create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    and coalesce(public.request_is_aal2(), false)
  )
  with check (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    and coalesce(public.request_is_aal2(), false)
    and status not in ('READY_TO_CLOSE', 'CLOSED')
    and (
      status <> 'REOPENED'
      or (
        reopened_by = auth.uid()
        and reopened_at is not null
        and length(btrim(coalesce(reopen_reason, ''))) between 1 and 2000
      )
    )
  );

-- Los tres overloads internos del commit de XLSX resolvian el periodo solo
-- por fechas. Se conserva su validacion exhaustiva y se agrega la empresa a
-- esa resolucion. El reemplazo falla cerrado si una migracion previa cambia
-- el cuerpo esperado, en vez de dejar una funcion parcialmente tenant-aware.
do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  foreach v_signature in array array[
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure,
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)'::regprocedure,
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_signature);

    if position('select id into v_period' in v_definition) > 0 then
      v_old := '  select id into v_period
  from public.reporting_periods
  where period_start = p_period_start
    and period_end = p_period_end;';
      v_new := '  select id into v_period
  from public.reporting_periods
  where company_id = p_company_id
    and period_start = p_period_start
    and period_end = p_period_end;';
    else
      v_old := '  select rp.id into v_period_id
  from public.reporting_periods rp
  where rp.period_start = p_period_start
    and rp.period_end = p_period_end;';
      v_new := '  select rp.id into v_period_id
  from public.reporting_periods rp
  where rp.company_id = p_company_id
    and rp.period_start = p_period_start
    and rp.period_end = p_period_end;';
    end if;

    if position(v_old in v_definition) = 0 then
      raise exception 'No se encontro la resolucion legacy de periodo en %', v_signature
        using errcode = '55000';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    execute v_definition;
  end loop;
end;
$$;

-- Los commits service_role de aprobacion y cierre reciben company_id. Las FKs
-- compuestas ya hacen rollback ante un cruce; estos checks adelantan el error
-- y evitan tocar siquiera la fila equivocada dentro de la transaccion.
create or replace function private.assert_reporting_period_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.reporting_periods rp
    where rp.id = new.reporting_period_id
      and rp.company_id = new.company_id
  ) then
    raise exception 'El periodo no pertenece a la empresa indicada.'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function private.assert_reporting_period_company()
  from public, anon, authenticated, service_role;

create trigger payroll_workbook_versions_period_company_guard
  before insert or update of company_id, reporting_period_id
  on public.payroll_workbook_versions
  for each row execute function private.assert_reporting_period_company();

create trigger payroll_workbook_conflicts_period_company_guard
  before insert or update of company_id, reporting_period_id
  on public.payroll_workbook_conflicts
  for each row execute function private.assert_reporting_period_company();

create trigger reporting_period_approvals_period_company_guard
  before insert or update of company_id, reporting_period_id
  on public.reporting_period_approvals
  for each row execute function private.assert_reporting_period_company();

create trigger payroll_close_operations_period_company_guard
  before insert or update of company_id, reporting_period_id
  on private.payroll_period_close_operations
  for each row execute function private.assert_reporting_period_company();
