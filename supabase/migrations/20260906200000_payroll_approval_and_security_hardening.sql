-- Aprobación atómica de pre-nómina y cierre de los bypasses multiempresa.
--
-- READY_TO_CLOSE significa “APROBADO POR RR. HH.” y por tanto no puede ser
-- un UPDATE genérico. La aplicación calcula la cola completa sobre una
-- revisión MVCC; esta migración consume esa evidencia únicamente por una
-- frontera service_role, vuelve a validar actor/tenant/base/conflictos y
-- cambia el estado bajo el mismo lock de revisión.

create table public.reporting_period_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  reporting_period_id uuid not null references public.reporting_periods(id),
  approved_by uuid not null references public.profiles(id),
  accepted_workbook_version_id uuid not null references public.payroll_workbook_versions(id),
  source_revision bigint not null check (source_revision >= 0),
  readiness_sha256 text not null check (readiness_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null default clock_timestamp(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (
    (invalidated_at is null and invalidation_reason is null)
    or (invalidated_at is not null and length(btrim(coalesce(invalidation_reason, ''))) between 1 and 500)
  )
);

create unique index reporting_period_approvals_one_current_idx
  on public.reporting_period_approvals(reporting_period_id)
  where invalidated_at is null;
create index reporting_period_approvals_history_idx
  on public.reporting_period_approvals(company_id, reporting_period_id, approved_at desc);

alter table public.reporting_period_approvals enable row level security;
revoke all on public.reporting_period_approvals from public, anon, authenticated, service_role;
grant select on public.reporting_period_approvals to authenticated;

create policy reporting_period_approvals_read
  on public.reporting_period_approvals for select to authenticated
  using (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    or public.has_company_app_role(company_id, 'SUPER_ADMIN')
  );

comment on table public.reporting_period_approvals is
  'Historial inmutable de aprobaciones RR. HH. ligado a revisión de fuentes, versión ACCEPTED y digest de readiness.';

-- Ni siquiera un consumidor accidental de service_role puede fabricar un
-- período ya aprobado/cerrado al insertarlo. Todo ciclo nace OPEN y los demás
-- estados se alcanzan únicamente por sus transiciones auditadas.
create or replace function public.guard_reporting_period_initial_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'OPEN'
     or new.closed_by is not null
     or new.closed_at is not null
     or new.reopened_by is not null
     or new.reopened_at is not null
     or new.reopen_reason is not null then
    raise exception 'Un período nuevo debe comenzar OPEN y sin evidencia de cierre o reapertura.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_reporting_period_initial_state()
  from public, anon, authenticated, service_role;

drop trigger if exists reporting_periods_guard_initial_state on public.reporting_periods;
create trigger reporting_periods_guard_initial_state
  before insert on public.reporting_periods
  for each row execute function public.guard_reporting_period_initial_state();

-- Ningún READY_TO_CLOSE heredado puede considerarse aprobado por el nuevo
-- protocolo. Se devuelve a revisión sin borrar el estado histórico del
-- período; no se tocan períodos cerrados.
update public.reporting_periods
set status = 'IN_REVIEW'
where status = 'READY_TO_CLOSE';

-- Cada mutación de una fuente del Excel invalida inmediatamente una
-- aprobación aún abierta. El lock de payroll_source_revisions serializa esto
-- con la aprobación y con el cierre; si la mutación gana, el digest queda
-- obsoleto, y si la aprobación gana, la mutación la devuelve a revisión.
create or replace function private.bump_arcotex_payroll_source_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
begin
  insert into private.payroll_source_revisions as source_revision (
    company_id,
    revision,
    changed_at
  ) values (
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    1,
    clock_timestamp()
  )
  on conflict (company_id) do update
    set revision = source_revision.revision + 1,
        changed_at = excluded.changed_at;

  perform set_config('gestora.payroll_source_invalidation', 'true', true);
  for v_period_id in
    update public.reporting_periods rp
    set status = 'IN_REVIEW'
    where rp.status = 'READY_TO_CLOSE'
    returning rp.id
  loop
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'PAYROLL_APPROVAL_INVALIDATED_BY_SOURCE_CHANGE',
      'reporting_periods',
      v_period_id,
      jsonb_build_object('resulting_status', 'IN_REVIEW')
    );
  end loop;
  return null;
end;
$$;

revoke all on function private.bump_arcotex_payroll_source_revision()
  from public, anon, authenticated, service_role;

-- Reemplaza el guard anterior y reserva READY_TO_CLOSE al RPC confiable.
create or replace function public.guard_reporting_period_close_and_reopen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid;
  v_trusted_close boolean := false;
  v_trusted_approval boolean := false;
begin
  if new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end then
    raise exception 'El rango de un período existente es inmutable; crea otro período.'
      using errcode = '42501';
  end if;

  begin
    v_operation_id := nullif(current_setting('gestora.payroll_close_operation', true), '')::uuid;
  exception when invalid_text_representation then
    v_operation_id := null;
  end;

  if v_operation_id is not null then
    select exists (
      select 1
      from private.payroll_period_close_operations o
      where o.id = v_operation_id
        and o.reporting_period_id = old.id
        and o.actor_id = new.closed_by
        and o.status = 'PREPARED'
    ) into v_trusted_close;
  end if;

  v_trusted_approval := coalesce(
    auth.role() = 'service_role'
    and nullif(current_setting('gestora.payroll_ready_approval', true), '') = old.id::text,
    false
  );

  if new.status = 'READY_TO_CLOSE'
     and old.status <> 'READY_TO_CLOSE'
     and not v_trusted_approval then
    raise exception 'Aprobar una pre-nómina exige una comprobación conciliada y estable.'
      using errcode = '42501';
  end if;

  if new.status = 'CLOSED' and not v_trusted_close then
    raise exception 'Cerrar un período exige una operación de snapshot verificada.' using errcode = '42501';
  end if;

  if old.status = 'READY_TO_CLOSE' and new.status = 'IN_REVIEW' then
    update public.reporting_period_approvals a
    set invalidated_at = clock_timestamp(),
        invalidation_reason = case
          when current_setting('gestora.payroll_source_invalidation', true) = 'true'
            then 'DATOS_FUENTE_MODIFICADOS'
          else 'PERIODO_DEVUELTO_A_REVISION'
        end
    where a.reporting_period_id = old.id
      and a.invalidated_at is null;
  end if;

  if old.status = 'CLOSED' then
    perform public.enforce_mfa_for_privileged();
    if not coalesce(public.request_is_aal2(), false) then
      raise exception 'Reabrir un período exige segundo factor (MFA).'
        using errcode = '42501';
    end if;
    if new.status <> 'REOPENED'
       or auth.uid() is null
       or new.reopened_by is distinct from auth.uid()
       or new.reopened_at is null
       or new.reopened_at is not distinct from old.reopened_at
       or length(btrim(coalesce(new.reopen_reason, ''))) not between 1 and 2000
       or new.closed_by is distinct from old.closed_by
       or new.closed_at is distinct from old.closed_at then
      raise exception 'Reabrir exige actor, fecha y motivo nuevos, sin alterar la evidencia del cierre.'
        using errcode = '42501';
    end if;

    update public.reporting_period_approvals a
    set invalidated_at = clock_timestamp(),
        invalidation_reason = 'PERIODO_REABIERTO'
    where a.reporting_period_id = old.id
      and a.invalidated_at is null;
  elsif not v_trusted_close and (
    new.closed_by is distinct from old.closed_by
    or new.closed_at is distinct from old.closed_at
  ) then
    raise exception 'La evidencia de cierre no se puede editar directamente.' using errcode = '42501';
  end if;

  if not (old.status = 'CLOSED' and new.status = 'REOPENED') and (
    new.reopened_by is distinct from old.reopened_by
    or new.reopened_at is distinct from old.reopened_at
    or new.reopen_reason is distinct from old.reopen_reason
  ) then
    raise exception 'La evidencia de reapertura no se puede editar directamente.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_reporting_period_close_and_reopen()
  from public, anon, authenticated, service_role;

drop policy if exists reporting_periods_insert_admin on public.reporting_periods;
create policy reporting_periods_insert_admin on public.reporting_periods
  for insert to authenticated
  with check (
    public.has_company_app_role(
      '0a4c0000-0000-0000-0000-000000000001'::uuid,
      'ADMIN_RRHH'
    )
    and coalesce(public.request_is_aal2(), false)
    and status = 'OPEN'
    and closed_by is null
    and closed_at is null
    and reopened_by is null
    and reopened_at is null
    and reopen_reason is null
  );

drop policy if exists reporting_periods_update_admin on public.reporting_periods;
create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (public.has_company_app_role(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    'ADMIN_RRHH'
  ) and coalesce(public.request_is_aal2(), false))
  with check (
    public.has_company_app_role(
      '0a4c0000-0000-0000-0000-000000000001'::uuid,
      'ADMIN_RRHH'
    )
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

create or replace function public.approve_reporting_period_ready(
  p_actor_id uuid,
  p_company_id uuid,
  p_reporting_period_id uuid,
  p_expected_status public.reporting_period_status,
  p_expected_source_revision bigint,
  p_expected_accepted_version_id uuid,
  p_readiness_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_period public.reporting_periods%rowtype;
  v_source_revision bigint;
  v_latest_accepted_id uuid;
  v_approval_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'La aprobación conciliada pertenece al servicio de pre-nómina.' using errcode = '42501';
  end if;
  if p_company_id is distinct from '0a4c0000-0000-0000-0000-000000000001'::uuid
     or p_expected_status not in ('IN_REVIEW', 'REOPENED')
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_readiness_sha256 is null
     or p_readiness_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'La evidencia de aprobación no es válida.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles p
    join public.company_memberships cm
      on cm.user_id = p.id
     and cm.company_id = p_company_id
     and cm.active
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id
     and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id
     and cr.id = cmr.role_id
     and cr.active
     and cr.base_role = 'ADMIN_RRHH'
    join public.companies c
      on c.id = cm.company_id
     and c.active
     and c.status = 'ACTIVE'
     and c.workspace_enabled
    where p.id = p_actor_id
      and p.active
  ) then
    raise exception 'La autoridad de RR. HH. ya no está vigente.' using errcode = '42501';
  end if;

  -- Orden global de locks: advisory de fuentes -> revisión -> libro/período
  -- -> fila del período. Coincide con cada writer y evita ciclos de espera.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select r.revision into v_source_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id
  for update;
  if v_source_revision is distinct from p_expected_source_revision then
    raise exception 'Los datos de pago cambiaron durante la aprobación.' using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payroll-workbook|' || p_company_id::text || '|' || p_reporting_period_id::text,
      0
    )
  );

  select * into v_period
  from public.reporting_periods rp
  where rp.id = p_reporting_period_id
  for update;
  if not found
     or v_period.status is distinct from p_expected_status
     or v_period.period_end is distinct from
       (date_trunc('month', v_period.period_end)::date + 14)
     or v_period.period_start is distinct from
       ((date_trunc('month', v_period.period_end) - interval '1 month')::date + 15) then
    raise exception 'El período cambió o no corresponde al ciclo 16-15.' using errcode = '40001';
  end if;

  select v.id into v_latest_accepted_id
  from public.payroll_workbook_versions v
  where v.company_id = p_company_id
    and v.reporting_period_id = p_reporting_period_id
    and v.period_start = v_period.period_start
    and v.period_end = v_period.period_end
    and v.status = 'ACCEPTED'
  order by v.version_number desc
  limit 1;
  if v_latest_accepted_id is distinct from p_expected_accepted_version_id then
    raise exception 'La versión aceptada cambió durante la aprobación.' using errcode = '40001';
  end if;
  if not exists (
    select 1
    from private.payroll_workbook_source_attestations a
    where a.workbook_version_id = v_latest_accepted_id
      and a.company_id = p_company_id
      and a.source_revision = v_source_revision
  ) then
    raise exception 'La versión aceptada quedó obsoleta. Vuelve a compararla y confirmarla.'
      using errcode = '40001';
  end if;
  if exists (
    select 1
    from public.payroll_workbook_conflicts c
    where c.company_id = p_company_id
      and c.reporting_period_id = p_reporting_period_id
      and c.resolved_at is null
  ) then
    raise exception 'Quedan conflictos Workera/RR. HH. sin resolver.' using errcode = '55000';
  end if;

  perform set_config('gestora.payroll_ready_approval', p_reporting_period_id::text, true);
  update public.reporting_periods
  set status = 'READY_TO_CLOSE'
  where id = p_reporting_period_id
    and status = p_expected_status;
  if not found then
    raise exception 'El período cambió durante la aprobación.' using errcode = '40001';
  end if;

  insert into public.reporting_period_approvals (
    company_id,
    reporting_period_id,
    approved_by,
    accepted_workbook_version_id,
    source_revision,
    readiness_sha256
  ) values (
    p_company_id,
    p_reporting_period_id,
    p_actor_id,
    p_expected_accepted_version_id,
    p_expected_source_revision,
    p_readiness_sha256
  ) returning id into v_approval_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'PAYROLL_PERIOD_APPROVED_BY_RRHH',
    'reporting_periods',
    p_reporting_period_id,
    jsonb_build_object(
      'approval_id', v_approval_id,
      'accepted_workbook_version_id', p_expected_accepted_version_id,
      'source_revision', p_expected_source_revision,
      'readiness_sha256', p_readiness_sha256
    )
  );

  return v_approval_id;
end;
$$;

revoke all on function public.approve_reporting_period_ready(
  uuid, uuid, uuid, public.reporting_period_status, bigint, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.approve_reporting_period_ready(
  uuid, uuid, uuid, public.reporting_period_status, bigint, uuid, text
) to service_role;

comment on function public.approve_reporting_period_ready(
  uuid, uuid, uuid, public.reporting_period_status, bigint, uuid, text
) is
  'Commit service_role-only de la aprobación RR. HH.; serializa revisión, base ACCEPTED, conflictos, estado e historial.';

-- RLS final de libros: el rol y la membresía deben pertenecer a la MISMA
-- empresa. Nunca se combina el rol legacy de ARCOTEX con otra membresía.
drop policy if exists payroll_workbook_versions_read on public.payroll_workbook_versions;
create policy payroll_workbook_versions_read
  on public.payroll_workbook_versions for select to authenticated
  using (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    or public.has_company_app_role(company_id, 'SUPER_ADMIN')
  );

drop policy if exists payroll_workbook_changes_read on public.payroll_workbook_changes;
create policy payroll_workbook_changes_read
  on public.payroll_workbook_changes for select to authenticated
  using (exists (
    select 1
    from public.payroll_workbook_versions v
    where v.id = workbook_version_id
      and (
        public.has_company_app_role(v.company_id, 'ADMIN_RRHH')
        or public.has_company_app_role(v.company_id, 'SUPER_ADMIN')
      )
  ));

drop policy if exists payroll_workbook_conflicts_read on public.payroll_workbook_conflicts;
create policy payroll_workbook_conflicts_read
  on public.payroll_workbook_conflicts for select to authenticated
  using (
    public.has_company_app_role(company_id, 'ADMIN_RRHH')
    or public.has_company_app_role(company_id, 'SUPER_ADMIN')
  );

-- Convierte de forma segura el primer segmento de Storage. CASE evita que un
-- nombre malicioso fuerce un cast UUID antes de que RLS pueda rechazarlo.
drop policy if exists payroll_workbooks_storage_insert on storage.objects;
create policy payroll_workbooks_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payroll-workbooks'
    and owner_id = auth.uid()::text
    and public.has_company_app_role(
      case
        when split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then split_part(name, '/', 1)::uuid
        else null
      end,
      'ADMIN_RRHH'
    )
  );

drop policy if exists payroll_workbooks_storage_read on storage.objects;
create policy payroll_workbooks_storage_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payroll-workbooks'
    and (
      public.has_company_app_role(
        case
          when split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            then split_part(name, '/', 1)::uuid
          else null
        end,
        'ADMIN_RRHH'
      )
      or public.has_company_app_role(
        case
          when split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            then split_part(name, '/', 1)::uuid
          else null
        end,
        'SUPER_ADMIN'
      )
    )
  );

drop policy if exists payroll_workbooks_storage_delete_orphan_owner on storage.objects;
create policy payroll_workbooks_storage_delete_orphan_owner
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'payroll-workbooks'
    and owner_id = auth.uid()::text
    and public.has_company_app_role(
      case
        when split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then split_part(name, '/', 1)::uuid
        else null
      end,
      'ADMIN_RRHH'
    )
    and not exists (
      select 1 from public.payroll_workbook_versions v where v.storage_path = name
    )
    and not exists (
      select 1
      from private.payroll_period_close_operations o
      where o.storage_path = name
        and o.status = 'PREPARED'
        and o.expires_at > statement_timestamp()
    )
  );

-- ---------------------------------------------------------------------------
-- Exenciones de control horario: misma empresa, autoridad exacta e historial.
-- Las funciones heredadas confiaban en profiles.role + una membresía activa
-- cualquiera y aceptaban un actor enviado por el cliente. Se conserva la
-- firma para no romper la UI, pero el actor se deriva y se comprueba contra la
-- sesión; la tabla deja de tener una vía de escritura directa.

drop policy if exists employee_time_control_policies_select
  on public.employee_time_control_policies;
create policy employee_time_control_policies_select
  on public.employee_time_control_policies for select to authenticated
  using (exists (
    select 1
    from public.employees e
    where e.id = employee_id
      and public.has_company_permission(e.company_id, 'attendance.read')
  ));

drop policy if exists employee_time_control_policies_write_admin
  on public.employee_time_control_policies;
revoke insert, update, delete on public.employee_time_control_policies
  from authenticated, service_role;

create or replace function public.set_time_control_exemption(
  p_employee_id uuid,
  p_legal_basis text,
  p_effective_from date,
  p_reason text,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_company_id uuid;
  v_current public.employee_time_control_policies%rowtype;
  v_had_current boolean := false;
  v_changed boolean := false;
begin
  if v_actor is null or p_actor_id is distinct from v_actor then
    raise exception 'La identidad de quien confirma la exención no es válida.'
      using errcode = '42501';
  end if;

  select e.company_id into v_company_id
  from public.employees e
  where e.id = p_employee_id;
  if v_company_id is null
     or not public.has_company_app_role(v_company_id, 'ADMIN_RRHH') then
    raise exception 'Solo RR. HH. de la empresa puede confirmar una exención.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if p_effective_from is null
     or p_legal_basis not in ('NO_MARKING_REQUIRED', 'ARTICLE_22', 'OTHER')
     or length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception 'La vigencia, fundamento y motivo de la exención son obligatorios.'
      using errcode = '22023';
  end if;

  -- Mismo orden que aprobación/cierre y luego el lock por trabajador.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('time-control|' || p_employee_id::text, 0)
  );

  -- Una fila que ya alcanzo su fecha de vigencia es evidencia laboral. No se
  -- elimina ni se reescribe desde su mismo inicio: para terminarla se indica
  -- un dia posterior, conservando el tramo historico mediante effective_to.
  if exists (
    select 1
    from public.employee_time_control_policies p
    where p.employee_id = p_employee_id
      and p.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
      and p.effective_from >= p_effective_from
      and p.effective_from <= current_date
  ) then
    raise exception 'Una exencion ya vigente no puede borrarse desde su fecha inicial; terminala desde un dia posterior.'
      using errcode = '55000';
  end if;

  select * into v_current
  from public.employee_time_control_policies p
  where p.employee_id = p_employee_id
    and p.effective_from <= p_effective_from
    and (p.effective_to is null or p.effective_to >= p_effective_from)
  order by p.effective_from desc
  limit 1
  for update;
  v_had_current := found;

  if v_had_current
     and v_current.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
     and v_current.legal_basis = p_legal_basis
     and v_current.reason is not distinct from btrim(p_reason) then
    return;
  end if;

  perform private.assert_arcotex_payroll_range_mutable(
    v_company_id,
    p_effective_from,
    case when v_had_current then v_current.effective_to else null end
  );

  if v_had_current and v_current.effective_from = p_effective_from then
    update public.employee_time_control_policies
    set policy_code = 'EXEMPT_FROM_TIME_CONTROL',
        legal_basis = p_legal_basis,
        reason = btrim(p_reason)
    where id = v_current.id;
    v_changed := true;
  else
    if v_had_current then
      update public.employee_time_control_policies
      set effective_to = p_effective_from - 1
      where id = v_current.id;
    end if;

    if exists (
      select 1
      from public.employee_time_control_policies p
      where p.employee_id = p_employee_id
        and p.effective_from > p_effective_from
    ) then
      raise exception 'El trabajador tiene una política futura; resuélvela antes de cambiar esta vigencia.'
        using errcode = '55000';
    end if;

    insert into public.employee_time_control_policies (
      employee_id, policy_code, legal_basis, effective_from, effective_to,
      reason, created_by
    ) values (
      p_employee_id, 'EXEMPT_FROM_TIME_CONTROL', p_legal_basis,
      p_effective_from,
      case when v_had_current then v_current.effective_to else null end,
      btrim(p_reason), v_actor
    );
    v_changed := true;
  end if;

  if v_changed then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      v_actor,
      'TIME_CONTROL_EXEMPTION_SET_BY_RRHH',
      'employee_time_control_policies',
      p_employee_id,
      jsonb_build_object(
        'company_id', v_company_id,
        'effective_from', p_effective_from,
        'legal_basis', p_legal_basis,
        'previous_policy_id', v_current.id,
        'previous_legal_basis', v_current.legal_basis,
        'previous_reason', v_current.reason
      )
    );
  end if;
end;
$$;

create or replace function public.clear_time_control_exemption(
  p_employee_id uuid,
  p_effective_from date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_company_id uuid;
  v_active_id uuid;
  v_active_effective_to date;
  v_future record;
  v_future_count integer := 0;
  v_changed boolean := false;
begin
  select e.company_id into v_company_id
  from public.employees e
  where e.id = p_employee_id;
  if v_actor is null
     or p_effective_from is null
     or v_company_id is null
     or not public.has_company_app_role(v_company_id, 'ADMIN_RRHH') then
    raise exception 'Solo RR. HH. de la empresa puede terminar una exención.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  -- Global antes del lock por trabajador: el cierre y esta mutación no pueden
  -- cruzarse entre la comprobación de estado y el DML.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('time-control|' || p_employee_id::text, 0)
  );

  if exists (
    select 1
    from public.employee_time_control_policies p
    where p.employee_id = p_employee_id
      and p.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
      and p.effective_from >= p_effective_from
      and p.effective_from <= current_date
  ) then
    raise exception 'Una exención ya vigente no se elimina; termínala desde un día posterior.'
      using errcode = '55000';
  end if;

  select p.id, p.effective_to into v_active_id, v_active_effective_to
  from public.employee_time_control_policies p
  where p.employee_id = p_employee_id
    and p.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
    and p.effective_from < p_effective_from
    and (p.effective_to is null or p.effective_to >= p_effective_from)
  order by p.effective_from desc
  limit 1
  for update;
  if v_active_id is not null then
    perform private.assert_arcotex_payroll_range_mutable(
      v_company_id,
      p_effective_from,
      v_active_effective_to
    );
    update public.employee_time_control_policies
    set effective_to = p_effective_from - 1
    where id = v_active_id;
    v_changed := true;
  end if;

  for v_future in
    select p.effective_from, p.effective_to
    from public.employee_time_control_policies p
    where p.employee_id = p_employee_id
      and p.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
      and p.effective_from >= p_effective_from
      and p.effective_from > current_date
    order by p.effective_from
    for update
  loop
    perform private.assert_arcotex_payroll_range_mutable(
      v_company_id,
      v_future.effective_from,
      v_future.effective_to
    );
    v_future_count := v_future_count + 1;
  end loop;
  if v_future_count > 0 then
    -- Las filas aún no vigentes se corrigen; el evento de auditoría conserva
    -- quién las invalidó y desde cuándo. Ninguna historia ya efectiva se borra.
    delete from public.employee_time_control_policies p
      where p.employee_id = p_employee_id
      and p.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
      and p.effective_from >= p_effective_from
      and p.effective_from > current_date;
    v_changed := true;
  end if;

  if v_changed then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      v_actor,
      'TIME_CONTROL_EXEMPTION_CLEARED_BY_RRHH',
      'employee_time_control_policies',
      p_employee_id,
      jsonb_build_object(
        'company_id', v_company_id,
        'effective_from', p_effective_from,
        'cancelled_future_rows', v_future_count
      )
    );
  end if;
end;
$$;

revoke all on function public.set_time_control_exemption(uuid, text, date, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_time_control_exemption(uuid, text, date, text, uuid)
  to authenticated;
revoke all on function public.clear_time_control_exemption(uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.clear_time_control_exemption(uuid, date)
  to authenticated;

comment on function public.set_time_control_exemption(uuid, text, date, text, uuid) is
  'Solo ADMIN_RRHH de la empresa del trabajador y con MFA; actor derivado, vigencia serializada y auditoría.';
comment on function public.clear_time_control_exemption(uuid, date) is
  'Solo ADMIN_RRHH de la empresa del trabajador y con MFA; conserva historia efectiva y audita la invalidación.';
