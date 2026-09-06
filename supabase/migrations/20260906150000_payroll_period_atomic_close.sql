-- Cierre final de pre-nómina con evidencia exacta y revisión de fuentes.
--
-- La versión ACCEPTED conserva sin cambios los bytes que subió RR. HH. El
-- cierre genera otra versión, CLOSED_SNAPSHOT, desde datos laborales vivos y
-- reaplica únicamente los ajustes empresariales aceptados. Una revisión
-- monotónica compartida por todas las fuentes del export evita que el libro
-- se confirme si Workera cambia durante o después del cálculo.
--
-- Storage no comparte transacción con Postgres. Por eso el protocolo tiene:
--   1. prepare_payroll_period_close (sesión ADMIN_RRHH + MFA),
--   2. upload privado a una ruta nueva,
--   3. verificación SHA-256 de los bytes reales en un límite server-only,
--   4. commit_payroll_period_close (solo service_role).
-- El último RPC inserta CLOSED_SNAPSHOT, cambia a CLOSED y escribe audit_log
-- en una sola transacción.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- La unicidad histórica por hash impedía volver a cerrar un período reabierto
-- con un resultado legítimamente idéntico. Los ACCEPTED conservan su
-- idempotencia histórica; cada cierre obtiene su propia versión/ruta.
do $migration$
declare
  v_constraint name;
  v_removed boolean := false;
begin
  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.payroll_workbook_versions'::regclass
      and c.contype = 'u'
      and pg_catalog.pg_get_constraintdef(c.oid)
        like 'UNIQUE% (company_id, reporting_period_id, content_sha256)%'
  loop
    execute pg_catalog.format(
      'alter table public.payroll_workbook_versions drop constraint %I',
      v_constraint
    );
    v_removed := true;
  end loop;
  if not v_removed then
    raise exception 'No se encontró la restricción histórica de hash de payroll_workbook_versions.';
  end if;
end;
$migration$;

create index payroll_workbook_versions_accepted_hash_idx
  on public.payroll_workbook_versions(company_id, reporting_period_id, content_sha256)
  where status = 'ACCEPTED';

alter table public.payroll_workbook_versions
  add column source_revision bigint,
  add column close_operation_id uuid unique;

alter table public.payroll_workbook_versions
  add constraint payroll_workbook_versions_source_revision_chk check (
    source_revision is null or source_revision >= 0
  ),
  add constraint payroll_workbook_versions_close_evidence_chk check (
    (status = 'CLOSED_SNAPSHOT' and source_revision is not null and close_operation_id is not null)
    or (status <> 'CLOSED_SNAPSHOT' and close_operation_id is null)
  );

-- ---------------------------------------------------------------------------
-- Revisión monotónica de todas las fuentes que alimentan el XLSX.

create table private.payroll_source_revisions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  changed_at timestamptz not null default clock_timestamp()
);

alter table private.payroll_source_revisions enable row level security;
revoke all on table private.payroll_source_revisions from public, anon, authenticated, service_role;

insert into private.payroll_source_revisions(company_id, revision)
select c.id, 0
from public.companies c
where c.id = '0a4c0000-0000-0000-0000-000000000001'::uuid
on conflict (company_id) do nothing;

comment on table private.payroll_source_revisions is
  'Fence MVCC global del workspace laboral ARCOTEX. Toda fuente del Excel lo incrementa antes de mutar.';

create or replace function private.bump_arcotex_payroll_source_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Es BEFORE STATEMENT a propósito: toma el mismo lock de fila que prepare y
  -- commit antes de modificar una fuente. Si el writer gana, el cierre verá
  -- otra revisión; si el cierre gana, la mutación ocurre después de CLOSED.
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
  return null;
end;
$$;

revoke all on function private.bump_arcotex_payroll_source_revision()
  from public, anon, authenticated, service_role;

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles',
    'employee_groups',
    'employees',
    'holidays',
    'rule_engine_runs',
    'attendance_records',
    'attendance_corrections',
    'attendance_statuses',
    'attendance_status_records',
    'late_arrival_records',
    'late_arrival_decisions',
    'early_departure_records',
    'early_departure_decisions',
    'overtime_types',
    'overtime_policies',
    'overtime_records',
    'overtime_decisions',
    'bonus_policies',
    'employee_daily_bonuses',
    'attendance_missing_punch_flags',
    'absence_records',
    'absence_decisions',
    'organization_units',
    'employee_org_assignments',
    'work_schedules',
    'work_schedule_rules',
    'schedule_assignments',
    'employee_time_control_policies',
    'payroll_workbook_conflicts'
  ]
  loop
    execute pg_catalog.format(
      'create trigger payroll_source_revision_fence '
      || 'before insert or update or delete on public.%I '
      || 'for each statement execute function private.bump_arcotex_payroll_source_revision()',
      v_table
    );
  end loop;
end;
$triggers$;

create or replace function public.get_payroll_source_revision(p_company_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  if auth.uid() is null
     or p_company_id is distinct from '0a4c0000-0000-0000-0000-000000000001'::uuid
     or not coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'La revisión de pago no está disponible para esta sesión.' using errcode = '42501';
  end if;

  select r.revision into v_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id;
  if v_revision is null then
    raise exception 'No existe revisión de fuentes para la empresa.' using errcode = '55000';
  end if;
  return v_revision;
end;
$$;

revoke all on function public.get_payroll_source_revision(uuid) from public, anon;
grant execute on function public.get_payroll_source_revision(uuid) to authenticated;

-- Una aceptación queda atestada contra la revisión que el servidor leyó
-- antes y después de regenerar su base. Si el hash ya existía, se conserva el
-- mismo archivo exacto y se añade una nueva atestación, sin reescribirlo.
create table private.payroll_workbook_source_attestations (
  workbook_version_id uuid not null references public.payroll_workbook_versions(id),
  company_id uuid not null references public.companies(id),
  source_revision bigint not null check (source_revision >= 0),
  attested_by uuid not null references public.profiles(id),
  attested_at timestamptz not null default clock_timestamp(),
  primary key (workbook_version_id, source_revision)
);

alter table private.payroll_workbook_source_attestations enable row level security;
revoke all on table private.payroll_workbook_source_attestations
  from public, anon, authenticated, service_role;

-- La firma antigua no conoce la revisión y queda como implementación interna
-- llamada únicamente por el wrapper nuevo.
revoke all on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb
) from public, anon, authenticated;

create or replace function public.register_accepted_payroll_workbook(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_base_version_id uuid,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text,
  p_general_reason text,
  p_changes jsonb,
  p_expected_source_revision bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_period_id uuid;
  v_current_revision bigint;
  v_version_id uuid;
begin
  if v_actor is null
     or p_company_id is distinct from '0a4c0000-0000-0000-0000-000000000001'::uuid
     or not coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'Solo RR. HH. puede confirmar una pre-nómina.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  select rp.id into v_period_id
  from public.reporting_periods rp
  where rp.period_start = p_period_start
    and rp.period_end = p_period_end;
  if v_period_id is null then
    raise exception 'El período no existe para esta empresa.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select r.revision into v_current_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id
  for update;
  if v_current_revision is distinct from p_expected_source_revision then
    raise exception 'Los datos de Workera cambiaron durante la aceptación. Vuelve a comparar.'
      using errcode = '40001';
  end if;

  v_version_id := public.register_accepted_payroll_workbook(
    p_company_id,
    p_period_start,
    p_period_end,
    p_expected_base_version_id,
    p_content_sha256,
    p_file_size,
    p_storage_path,
    p_general_reason,
    p_changes
  );

  -- La revision no puede cambiar mientras conservamos el advisory global y el
  -- lock de su fila. Los conflictos ya resueltos que registra esta aceptacion
  -- son historia; no forman parte del conjunto abierto del gate.
  select r.revision into v_current_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id;

  if v_current_revision is distinct from p_expected_source_revision then
    raise exception 'Una escritura interna altero la revision durante la aceptacion.'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from public.payroll_workbook_versions v
    where v.id = v_version_id
      and v.company_id = p_company_id
      and v.reporting_period_id = v_period_id
      and v.status = 'ACCEPTED'
  ) then
    raise exception 'La versión confirmada no corresponde a la empresa y período.' using errcode = '23503';
  end if;

  insert into private.payroll_workbook_source_attestations (
    workbook_version_id,
    company_id,
    source_revision,
    attested_by
  ) values (
    v_version_id,
    p_company_id,
    v_current_revision,
    v_actor
  )
  on conflict (workbook_version_id, source_revision) do nothing;

  return v_version_id;
end;
$$;

revoke all on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb, bigint
) from public, anon;
grant execute on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb, bigint
) to authenticated;

-- ---------------------------------------------------------------------------
-- Operación preparada: autorización humana corta antes de subir los bytes.

create table private.payroll_period_close_operations (
  id uuid primary key,
  company_id uuid not null references public.companies(id),
  reporting_period_id uuid not null references public.reporting_periods(id),
  actor_id uuid not null references public.profiles(id),
  expected_status public.reporting_period_status not null,
  base_version_id uuid not null references public.payroll_workbook_versions(id),
  source_revision bigint not null check (source_revision >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  file_size integer not null check (file_size between 1 and 15728640),
  storage_path text not null unique,
  mfa_aal text not null check (mfa_aal = 'aal2'),
  status text not null default 'PREPARED' check (status in ('PREPARED', 'ABORTED', 'COMMITTED')),
  prepared_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  snapshot_version_id uuid references public.payroll_workbook_versions(id),
  constraint payroll_period_close_operations_state_evidence_chk check (
    (status = 'COMMITTED' and committed_at is not null and snapshot_version_id is not null)
    or (
      status in ('PREPARED', 'ABORTED')
      and committed_at is null
      and snapshot_version_id is null
    )
  )
);

alter table private.payroll_period_close_operations enable row level security;
revoke all on table private.payroll_period_close_operations
  from public, anon, authenticated, service_role;

create index payroll_period_close_operations_expiry_idx
  on private.payroll_period_close_operations(expires_at)
  where status = 'PREPARED';

create or replace function public.prepare_payroll_period_close(
  p_operation_id uuid,
  p_company_id uuid,
  p_reporting_period_id uuid,
  p_expected_status public.reporting_period_status,
  p_expected_base_version_id uuid,
  p_expected_source_revision bigint,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_period public.reporting_periods%rowtype;
  v_latest uuid;
  v_current_revision bigint;
  v_existing private.payroll_period_close_operations%rowtype;
begin
  if v_actor is null
     or p_company_id is distinct from '0a4c0000-0000-0000-0000-000000000001'::uuid
     or not coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'Solo RR. HH. de la empresa activa puede preparar el cierre.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if p_operation_id is null
     or p_reporting_period_id is null
     or p_expected_status is distinct from 'READY_TO_CLOSE'::public.reporting_period_status
     or p_expected_base_version_id is null
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[a-f0-9]{64}$'
     or p_file_size is null
     or p_file_size not between 1 and 15728640 then
    raise exception 'La evidencia preparada del cierre es inválida.' using errcode = '22023';
  end if;

  select * into v_existing
  from private.payroll_period_close_operations o
  where o.id = p_operation_id
  for update;
  if found then
    if v_existing.actor_id = v_actor
       and v_existing.company_id = p_company_id
       and v_existing.reporting_period_id = p_reporting_period_id
       and v_existing.base_version_id = p_expected_base_version_id
       and v_existing.source_revision = p_expected_source_revision
       and v_existing.content_sha256 = p_content_sha256
       and v_existing.file_size = p_file_size
       and v_existing.storage_path = p_storage_path
       and v_existing.status = 'PREPARED'
       and v_existing.expires_at > statement_timestamp() then
      return v_existing.id;
    end if;
    raise exception 'El identificador de cierre ya pertenece a otra operación.' using errcode = '23505';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select r.revision into v_current_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id
  for update;
  if v_current_revision is distinct from p_expected_source_revision then
    raise exception 'Los datos de Workera cambiaron durante el cierre. Vuelve a comprobarlos.'
      using errcode = '40001';
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
  if not found or v_period.status is distinct from p_expected_status then
    raise exception 'El período cambió de estado durante el cierre. Vuelve a comprobarlo.'
      using errcode = '40001';
  end if;
  if v_period.period_end <> (date_trunc('month', v_period.period_end)::date + 14)
     or v_period.period_start <> (
       (date_trunc('month', v_period.period_end)::date - 1) - interval '15 days'
     )::date then
    raise exception 'El cierre final exige el corte de pago exacto 16-15.' using errcode = '22023';
  end if;

  if p_storage_path is null or p_storage_path !~ (
    '^' || p_company_id::text || '/'
    || v_period.period_start::text || '_' || v_period.period_end::text
    || '/closed/' || p_reporting_period_id::text || '/' || p_operation_id::text || '[.]xlsx$'
  ) then
    raise exception 'La ruta privada del snapshot no corresponde a la operación.' using errcode = '22023';
  end if;

  select v.id into v_latest
  from public.payroll_workbook_versions v
  where v.company_id = p_company_id
    and v.reporting_period_id = p_reporting_period_id
    and v.status = 'ACCEPTED'
  order by v.version_number desc
  limit 1;
  if v_latest is distinct from p_expected_base_version_id then
    raise exception 'La pre-nómina aceptada cambió durante el cierre. Vuelve a comprobarla.'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from private.payroll_workbook_source_attestations a
    where a.workbook_version_id = v_latest
      and a.company_id = p_company_id
      and a.source_revision = v_current_revision
  ) then
    raise exception 'La versión aceptada quedó obsoleta tras cambios en Workera. Vuelve a compararla y confirmarla.'
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

  insert into private.payroll_period_close_operations (
    id,
    company_id,
    reporting_period_id,
    actor_id,
    expected_status,
    base_version_id,
    source_revision,
    content_sha256,
    file_size,
    storage_path,
    mfa_aal,
    expires_at
  ) values (
    p_operation_id,
    p_company_id,
    p_reporting_period_id,
    v_actor,
    p_expected_status,
    v_latest,
    v_current_revision,
    p_content_sha256,
    p_file_size,
    p_storage_path,
    auth.jwt() ->> 'aal',
    statement_timestamp() + interval '15 minutes'
  );

  return p_operation_id;
end;
$$;

revoke all on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, integer, text
) from public, anon;
grant execute on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, integer, text
) to authenticated;

create or replace function public.abort_payroll_period_close(p_operation_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'La operación no está disponible.' using errcode = '42501';
  end if;

  update private.payroll_period_close_operations o
  set status = 'ABORTED'
  where o.id = p_operation_id
    and o.actor_id = v_actor
    and o.status = 'PREPARED';
  return found;
end;
$$;

revoke all on function public.abort_payroll_period_close(uuid) from public, anon;
grant execute on function public.abort_payroll_period_close(uuid) to authenticated;

-- Mientras el período está CLOSED no puede aparecer otra base aceptada. Tras
-- REOPENED vuelve a ser posible revalidar o aceptar una revisión distinta.
create or replace function public.prevent_payroll_workbook_acceptance_while_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'ACCEPTED'
     and exists (
       select 1
       from public.reporting_periods rp
       where rp.id = new.reporting_period_id
         and rp.status = 'CLOSED'
     ) then
    raise exception 'Reabre el período antes de aceptar otra versión de pre-nómina.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger payroll_workbook_versions_no_accept_while_closed
  before insert or update of status, reporting_period_id
  on public.payroll_workbook_versions
  for each row
  execute function public.prevent_payroll_workbook_acceptance_while_closed();

revoke all on function public.prevent_payroll_workbook_acceptance_while_closed()
  from public, anon, authenticated, service_role;

create or replace function public.prevent_payroll_workbook_conflict_change_while_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reporting_period_id uuid := case when tg_op = 'DELETE'
    then old.reporting_period_id else new.reporting_period_id end;
begin
  if exists (
    select 1
    from public.reporting_periods rp
    where rp.id = v_reporting_period_id
      and rp.status = 'CLOSED'
  ) then
    raise exception 'Reabre el período antes de cambiar sus conflictos de pre-nómina.'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger payroll_workbook_conflicts_no_change_while_closed
  before insert or update or delete on public.payroll_workbook_conflicts
  for each row execute function public.prevent_payroll_workbook_conflict_change_while_closed();

revoke all on function public.prevent_payroll_workbook_conflict_change_while_closed()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ReportingPeriod: cierre solo por operación preparada; reapertura conserva
-- actor, instante, motivo y los cierres históricos.

create or replace function public.guard_reporting_period_close_and_reopen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid;
  v_trusted_close boolean := false;
begin
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

  if new.status = 'CLOSED' and not v_trusted_close then
    raise exception 'Cerrar un período exige una operación de snapshot verificada.' using errcode = '42501';
  end if;

  if old.status = 'CLOSED' then
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

create trigger reporting_periods_guard_close_and_reopen
  before update on public.reporting_periods
  for each row execute function public.guard_reporting_period_close_and_reopen();

revoke all on function public.guard_reporting_period_close_and_reopen()
  from public, anon, authenticated, service_role;

drop policy if exists reporting_periods_update_admin on public.reporting_periods;
create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (coalesce(public.has_company_app_role(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    'ADMIN_RRHH'
  ), false))
  with check (
    coalesce(public.has_company_app_role(
      '0a4c0000-0000-0000-0000-000000000001'::uuid,
      'ADMIN_RRHH'
    ), false)
    and status <> 'CLOSED'
    and (
      status <> 'REOPENED'
      or (
        reopened_by = auth.uid()
        and reopened_at is not null
        and length(btrim(coalesce(reopen_reason, ''))) between 1 and 2000
      )
    )
  );

-- Un PREPARED mantiene inmutable su ruta durante la comprobación confiable.
-- abort_payroll_period_close la libera antes del cleanup compensatorio.
drop policy if exists payroll_workbooks_storage_delete_orphan_owner on storage.objects;
create policy payroll_workbooks_storage_delete_orphan_owner
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'payroll-workbooks'
    and owner_id = auth.uid()::text
    and public.has_company_app_role(split_part(name, '/', 1)::uuid, 'ADMIN_RRHH')
    and split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and not exists (
      select 1
      from public.payroll_workbook_versions v
      where v.storage_path = name
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
-- Commit confiable. Solo el capability server-only posee EXECUTE.

create or replace function public.commit_payroll_period_close(
  p_operation_id uuid,
  p_verified_content_sha256 text,
  p_verified_file_size integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operation private.payroll_period_close_operations%rowtype;
  v_period public.reporting_periods%rowtype;
  v_latest uuid;
  v_current_revision bigint;
  v_snapshot_id uuid := gen_random_uuid();
  v_version_number integer;
  v_now timestamptz := clock_timestamp();
  v_updated integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'La confirmación de bytes pertenece al servicio de cierre.' using errcode = '42501';
  end if;

  select * into v_operation
  from private.payroll_period_close_operations o
  where o.id = p_operation_id
  for update;
  if not found then
    raise exception 'La operación preparada no existe.' using errcode = '23503';
  end if;

  if v_operation.status = 'COMMITTED' then
    if exists (
      select 1
      from public.payroll_workbook_versions v
      join public.reporting_periods rp on rp.id = v.reporting_period_id
      where v.id = v_operation.snapshot_version_id
        and v.status = 'CLOSED_SNAPSHOT'
        and rp.status = 'CLOSED'
        and rp.closed_at = v.closed_snapshot_at
    ) then
      return v_operation.snapshot_version_id;
    end if;
    raise exception 'La operación confirmada perdió su evidencia inmutable.' using errcode = '55000';
  end if;

  if v_operation.status <> 'PREPARED'
     or v_operation.expires_at <= statement_timestamp()
     or v_operation.mfa_aal <> 'aal2' then
    raise exception 'La autorización preparada venció o fue cancelada.' using errcode = '42501';
  end if;

  if p_verified_content_sha256 is distinct from v_operation.content_sha256
     or p_verified_file_size is distinct from v_operation.file_size then
    raise exception 'Los bytes verificados no corresponden a la operación preparada.' using errcode = '22000';
  end if;

  if not exists (
    select 1
    from public.profiles p
    join public.company_memberships cm
      on cm.user_id = p.id
     and cm.company_id = v_operation.company_id
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
    where p.id = v_operation.actor_id
      and p.active
  ) then
    raise exception 'La autorización de RR. HH. ya no está vigente.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select r.revision into v_current_revision
  from private.payroll_source_revisions r
  where r.company_id = v_operation.company_id
  for update;
  if v_current_revision is distinct from v_operation.source_revision then
    raise exception 'Los datos de Workera cambiaron después de generar el snapshot.' using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payroll-workbook|' || v_operation.company_id::text || '|'
      || v_operation.reporting_period_id::text,
      0
    )
  );

  select * into v_period
  from public.reporting_periods rp
  where rp.id = v_operation.reporting_period_id
  for update;
  if not found or v_period.status is distinct from v_operation.expected_status then
    raise exception 'El período cambió de estado durante el cierre.' using errcode = '40001';
  end if;

  select v.id into v_latest
  from public.payroll_workbook_versions v
  where v.company_id = v_operation.company_id
    and v.reporting_period_id = v_operation.reporting_period_id
    and v.status = 'ACCEPTED'
  order by v.version_number desc
  limit 1;
  if v_latest is distinct from v_operation.base_version_id then
    raise exception 'La pre-nómina aceptada cambió durante el cierre.' using errcode = '40001';
  end if;

  if not exists (
    select 1
    from private.payroll_workbook_source_attestations a
    where a.workbook_version_id = v_latest
      and a.company_id = v_operation.company_id
      and a.source_revision = v_current_revision
  ) then
    raise exception 'La versión aceptada ya no corresponde a las fuentes vigentes.' using errcode = '40001';
  end if;

  if exists (
    select 1
    from public.payroll_workbook_conflicts c
    where c.company_id = v_operation.company_id
      and c.reporting_period_id = v_operation.reporting_period_id
      and c.resolved_at is null
  ) then
    raise exception 'Quedan conflictos Workera/RR. HH. sin resolver.' using errcode = '55000';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'payroll-workbooks'
      and o.name = v_operation.storage_path
      and o.owner_id = v_operation.actor_id::text
      and o.metadata ->> 'mimetype'
        = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      and case
        when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
        else -1
      end = v_operation.file_size
      and o.user_metadata ->> 'artifact_kind' = 'CLOSED_SNAPSHOT'
      and o.user_metadata ->> 'content_sha256' = p_verified_content_sha256
      and o.user_metadata ->> 'reporting_period_id' = v_operation.reporting_period_id::text
      and o.user_metadata ->> 'period_start' = v_period.period_start::text
      and o.user_metadata ->> 'period_end' = v_period.period_end::text
      and o.user_metadata ->> 'operation_id' = v_operation.id::text
      and o.user_metadata ->> 'base_version_id' = v_latest::text
      and o.user_metadata ->> 'source_revision' = v_current_revision::text
  ) then
    raise exception 'El snapshot privado no existe o sus metadatos no coinciden.' using errcode = '23503';
  end if;

  select coalesce(max(v.version_number), 0) + 1 into v_version_number
  from public.payroll_workbook_versions v
  where v.company_id = v_operation.company_id
    and v.reporting_period_id = v_operation.reporting_period_id;

  insert into public.payroll_workbook_versions (
    id,
    company_id,
    reporting_period_id,
    period_start,
    period_end,
    version_number,
    base_version_id,
    status,
    schema_version,
    content_sha256,
    file_size,
    storage_path,
    general_reason,
    uploaded_by,
    closed_snapshot_at,
    source_revision,
    close_operation_id
  ) values (
    v_snapshot_id,
    v_operation.company_id,
    v_operation.reporting_period_id,
    v_period.period_start,
    v_period.period_end,
    v_version_number,
    v_latest,
    'CLOSED_SNAPSHOT',
    'GESTORA_PRENOMINA_2026_V2',
    p_verified_content_sha256,
    p_verified_file_size,
    v_operation.storage_path,
    'Snapshot canónico del cierre final; base ACCEPTED exacta ' || v_latest::text,
    v_operation.actor_id,
    v_now,
    v_current_revision,
    v_operation.id
  );

  perform pg_catalog.set_config('gestora.payroll_close_operation', v_operation.id::text, true);
  update public.reporting_periods
  set status = 'CLOSED',
      closed_by = v_operation.actor_id,
      closed_at = v_now
  where id = v_operation.reporting_period_id
    and status = v_operation.expected_status;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'El período cambió de estado durante el cierre.' using errcode = '40001';
  end if;

  insert into public.audit_log (
    actor_id,
    action,
    entity_type,
    entity_id,
    occurred_at,
    metadata
  ) values (
    v_operation.actor_id,
    'reporting_period.closed_with_payroll_snapshot',
    'reporting_period',
    v_operation.reporting_period_id,
    v_now,
    pg_catalog.jsonb_build_object(
      'company_id', v_operation.company_id,
      'from_status', v_operation.expected_status,
      'to_status', 'CLOSED',
      'snapshot_version_id', v_snapshot_id,
      'accepted_base_version_id', v_latest,
      'accepted_base_sha256', (
        select v.content_sha256 from public.payroll_workbook_versions v where v.id = v_latest
      ),
      'snapshot_content_sha256', p_verified_content_sha256,
      'snapshot_file_size', p_verified_file_size,
      'snapshot_storage_path', v_operation.storage_path,
      'source_revision', v_current_revision,
      'artifact_semantics', 'CANONICAL_CLOSED_WITH_ACCEPTED_ADJUSTMENTS'
    )
  );

  update private.payroll_period_close_operations
  set status = 'COMMITTED',
      committed_at = v_now,
      snapshot_version_id = v_snapshot_id
  where id = v_operation.id
    and status = 'PREPARED';
  if not found then
    raise exception 'La reserva de cierre cambió durante el commit.' using errcode = '40001';
  end if;

  return v_snapshot_id;
end;
$$;

revoke all on function public.commit_payroll_period_close(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.commit_payroll_period_close(uuid, text, integer)
  to service_role;

comment on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, integer, text
) is
  'Reserva por 15 minutos un cierre ADMIN_RRHH+MFA contra estado, base aceptada y revisión de todas las fuentes del Excel.';

comment on function public.commit_payroll_period_close(uuid, text, integer) is
  'Solo el límite server-only que recalculó SHA-256 sobre los bytes de Storage puede insertar CLOSED_SNAPSHOT, cerrar y auditar atómicamente.';
