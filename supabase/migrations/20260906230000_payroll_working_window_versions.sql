-- Versiones de trabajo de pre-nomina para ventanas diaria, semanal y
-- quincenal. El ciclo mensual 16-15 conserva las tablas, aprobacion y cierre
-- oficiales existentes. Una version corta nunca crea ni cierra un
-- reporting_period y sus ajustes solo se reaplican al mismo tipo/rango.

create table public.payroll_working_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  window_type text not null check (window_type in ('DIARIO', 'SEMANAL', 'QUINCENAL')),
  period_start date not null,
  period_end date not null,
  version_number integer not null check (version_number > 0),
  base_version_id uuid references public.payroll_working_versions(id),
  schema_version text not null check (schema_version = 'GESTORA_PRENOMINA_2026_V2'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  file_size integer not null check (file_size between 1 and 15728640),
  storage_path text not null unique,
  source_revision bigint not null check (source_revision >= 0),
  general_reason text not null check (length(btrim(general_reason)) between 1 and 2000),
  accepted_by uuid not null references public.profiles(id),
  accepted_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, window_type, period_start, period_end, version_number),
  check (period_end >= period_start)
);

create index payroll_working_versions_scope_idx
  on public.payroll_working_versions(
    company_id, window_type, period_start, period_end, version_number desc
  );

create table public.payroll_working_changes (
  id uuid primary key default gen_random_uuid(),
  working_version_id uuid not null references public.payroll_working_versions(id),
  sheet_name text not null,
  cell_reference text not null,
  stable_key text,
  employee_id uuid references public.employees(id),
  work_date date,
  field_code text,
  change_kind text not null check (change_kind in ('VALUE', 'FORMULA', 'FORMAT')),
  previous_value jsonb,
  new_value jsonb,
  source_value_at_accept jsonb,
  consequence text not null check (
    consequence in ('AJUSTE_EMPRESARIAL', 'CONSERVAR_ARCHIVO_SIN_EJECUTAR')
  ),
  conflict_resolution text check (
    conflict_resolution in ('KEEP_RRHH', 'ACCEPT_WORKERA', 'THIRD_VALUE')
  ),
  conflict_reason text check (
    conflict_reason is null or length(btrim(conflict_reason)) between 1 and 500
  ),
  general_reason text not null check (length(btrim(general_reason)) between 1 and 2000),
  decided_by uuid not null references public.profiles(id),
  decided_at timestamptz not null default clock_timestamp(),
  unique (working_version_id, sheet_name, cell_reference, change_kind)
);

create index payroll_working_changes_stable_idx
  on public.payroll_working_changes(stable_key, decided_at desc)
  where consequence = 'AJUSTE_EMPRESARIAL';

create table private.payroll_working_acceptance_receipts (
  idempotency_key text primary key check (idempotency_key ~ '^[a-f0-9]{64}$'),
  actor_id uuid not null references public.profiles(id),
  company_id uuid not null references public.companies(id),
  window_type text not null check (window_type in ('DIARIO', 'SEMANAL', 'QUINCENAL')),
  period_start date not null,
  period_end date not null,
  expected_base_version_id uuid references public.payroll_working_versions(id),
  source_revision bigint not null check (source_revision >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  file_size integer not null check (file_size between 1 and 15728640),
  version_id uuid not null references public.payroll_working_versions(id),
  committed_storage_path text not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.payroll_working_versions enable row level security;
alter table public.payroll_working_changes enable row level security;
alter table private.payroll_working_acceptance_receipts enable row level security;

create policy payroll_working_versions_read on public.payroll_working_versions
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and (
      public.has_company_app_role(company_id, 'ADMIN_RRHH')
      or public.has_company_app_role(company_id, 'SUPER_ADMIN')
    )
  );

create policy payroll_working_changes_read on public.payroll_working_changes
  for select to authenticated
  using (exists (
    select 1
    from public.payroll_working_versions v
    where v.id = working_version_id
      and public.is_active_company_member(v.company_id)
      and (
        public.has_company_app_role(v.company_id, 'ADMIN_RRHH')
        or public.has_company_app_role(v.company_id, 'SUPER_ADMIN')
      )
  ));

revoke all on public.payroll_working_versions, public.payroll_working_changes
  from public, anon, authenticated;
grant select on public.payroll_working_versions, public.payroll_working_changes
  to authenticated;
revoke all on private.payroll_working_acceptance_receipts
  from public, anon, authenticated, service_role;

-- La evidencia aceptada solo se inserta por el RPC SECURITY DEFINER y nunca
-- puede reescribirse o borrarse, ni siquiera usando service_role.
revoke insert, update, delete, truncate
  on public.payroll_working_versions, public.payroll_working_changes
  from authenticated, service_role;

create or replace function private.guard_payroll_working_evidence_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'La evidencia de una version de trabajo es inmutable.'
    using errcode = '42501';
end;
$$;

revoke all on function private.guard_payroll_working_evidence_immutable()
  from public, anon, authenticated, service_role;

create trigger payroll_working_versions_immutable
  before update or delete on public.payroll_working_versions
  for each row execute function private.guard_payroll_working_evidence_immutable();

create trigger payroll_working_changes_immutable
  before update or delete on public.payroll_working_changes
  for each row execute function private.guard_payroll_working_evidence_immutable();

-- La base de una version siempre pertenece al mismo tenant, tipo y rango.
create or replace function private.assert_payroll_working_base_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.base_version_id is not null and not exists (
    select 1
    from public.payroll_working_versions base
    where base.id = new.base_version_id
      and base.company_id = new.company_id
      and base.window_type = new.window_type
      and base.period_start = new.period_start
      and base.period_end = new.period_end
  ) then
    raise exception 'La version base no corresponde a empresa, tipo y rango.'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function private.assert_payroll_working_base_scope()
  from public, anon, authenticated, service_role;

create trigger payroll_working_versions_base_scope
  before insert on public.payroll_working_versions
  for each row execute function private.assert_payroll_working_base_scope();

create or replace function public.register_accepted_working_workbook(
  p_actor_id uuid,
  p_company_id uuid,
  p_window_type text,
  p_period_start date,
  p_period_end date,
  p_expected_base_version_id uuid,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text,
  p_general_reason text,
  p_changes jsonb,
  p_expected_source_revision bigint,
  p_verified_content_sha256 text,
  p_verified_file_size integer,
  p_idempotency_key text,
  p_storage_object_id uuid,
  p_storage_object_version text,
  p_storage_object_updated_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_receipt private.payroll_working_acceptance_receipts%rowtype;
  v_latest uuid;
  v_version_id uuid := gen_random_uuid();
  v_version_number integer;
  v_current_revision bigint;
  v_change jsonb;
  v_stable_key text;
  v_employee_id uuid;
  v_work_date date;
  v_column text;
  v_expected_field text;
  v_pair_field text;
  v_scale numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'La aceptacion de una version de trabajo pertenece al servicio.'
      using errcode = '42501';
  end if;
  if p_window_type not in ('DIARIO', 'SEMANAL', 'QUINCENAL')
     or p_period_start is null
     or p_period_end is null
     or (case p_window_type
       when 'DIARIO' then p_period_end <> p_period_start
       when 'SEMANAL' then p_period_end <> p_period_start + 6
         or extract(isodow from p_period_start) <> 1
       when 'QUINCENAL' then not (
         (extract(day from p_period_start) = 1
           and p_period_end = p_period_start + 14)
         or
         (extract(day from p_period_start) = 16
           and p_period_end = (
             date_trunc('month', p_period_start) + interval '1 month - 1 day'
           )::date)
       )
       else true
     end) then
    raise exception 'La ventana diaria, semanal o quincenal no es valida.'
      using errcode = '22023';
  end if;
  if p_actor_id is null or not exists (
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
    where p.id = p_actor_id and p.active
  ) then
    raise exception 'La autoridad de RR. HH. ya no esta vigente.'
      using errcode = '42501';
  end if;
  if p_content_sha256 is null
     or p_content_sha256 !~ '^[a-f0-9]{64}$'
     or p_verified_content_sha256 is distinct from p_content_sha256
     or p_file_size is null
     or p_file_size not between 1 and 15728640
     or p_verified_file_size is distinct from p_file_size
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[a-f0-9]{64}$'
     or length(btrim(coalesce(p_general_reason, ''))) not between 1 and 2000 then
    raise exception 'La evidencia verificada del XLSX no es valida.'
      using errcode = '22023';
  end if;
  if p_storage_path is null or p_storage_path !~ (
    '^' || p_company_id::text || '/'
    || p_period_start::text || '_' || p_period_end::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]xlsx$'
  ) then
    raise exception 'La ruta privada no corresponde a empresa y rango.'
      using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) > 500
     or pg_column_size(p_changes) > 2097152 then
    raise exception 'La evidencia de cambios no es valida.' using errcode = '22023';
  end if;

  -- Defensa en profundidad: la base de datos vuelve a comprobar la allowlist
  -- empresarial que la ruta ya valido contra el libro regenerado.
  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change) <> 'object'
       or not (v_change ? 'sheet')
       or not (v_change ? 'cell')
       or not (v_change ? 'kind')
       or not (v_change ? 'consequence')
       or not (v_change ? 'previous')
       or not (v_change ? 'next')
       or coalesce(length(v_change ->> 'sheet'), 0) not between 1 and 128
       or coalesce(length(v_change ->> 'cell'), 0) not between 1 and 32
       or coalesce(v_change ->> 'kind', '') not in ('VALUE', 'FORMULA', 'FORMAT')
       or coalesce(v_change ->> 'consequence', '') not in (
         'AJUSTE_EMPRESARIAL', 'CONSERVAR_ARCHIVO_SIN_EJECUTAR'
       ) then
      raise exception 'La evidencia contiene un cambio invalido.' using errcode = '22023';
    end if;
    if v_change ->> 'consequence' <> 'AJUSTE_EMPRESARIAL' then
      continue;
    end if;
    if v_change ->> 'kind' <> 'VALUE' then
      raise exception 'Solo cambios de valor reconocidos pueden ejecutarse.' using errcode = '22023';
    end if;
    if (v_change ? 'conflictResolution') or (v_change ? 'conflictReason') then
      if coalesce(v_change ->> 'conflictResolution', '') not in (
           'KEEP_RRHH', 'ACCEPT_WORKERA', 'THIRD_VALUE'
         )
         or jsonb_typeof(v_change -> 'conflictReason') <> 'string'
         or length(btrim(v_change ->> 'conflictReason')) not between 1 and 500 then
        raise exception 'La resolucion del conflicto no es valida.' using errcode = '22023';
      end if;
    end if;

    v_stable_key := v_change ->> 'stableKey';
    if v_change ->> 'sheet' = 'RESUMEN_NOMINA' then
      if v_change ->> 'cell' !~ '^(R|S|U|V|X|Y)([6-9]|[1-9][0-9]+)$' then
        raise exception 'El resumen contiene un ajuste no permitido.' using errcode = '22023';
      end if;
      v_column := regexp_replace(v_change ->> 'cell', '[0-9]+$', '');
      v_expected_field := case v_column
        when 'R' then 'Ajuste HH50 (minutos)'
        when 'S' then 'Motivo ajuste HH50'
        when 'U' then 'Ajuste HH100 (minutos)'
        when 'V' then 'Motivo ajuste HH100'
        when 'X' then 'Ajuste bono (CLP)'
        when 'Y' then 'Motivo ajuste bono'
      end;
      if v_stable_key is null
         or length(v_stable_key) > 256
         or split_part(v_stable_key, '|', 1) !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
         or v_stable_key <> split_part(v_stable_key, '|', 1) || '|' || v_expected_field then
        raise exception 'La clave estable no corresponde al ajuste.' using errcode = '22023';
      end if;
      v_employee_id := split_part(v_stable_key, '|', 1)::uuid;
      v_work_date := null;
      if v_column in ('R', 'U', 'X') then
        v_scale := case when v_column in ('R', 'U') then 1440 else 1 end;
        v_pair_field := case v_column
          when 'R' then 'Motivo ajuste HH50'
          when 'U' then 'Motivo ajuste HH100'
          when 'X' then 'Motivo ajuste bono'
        end;
        if jsonb_typeof(v_change -> 'next') <> 'number'
           or mod((v_change ->> 'next')::numeric, 1) <> 0
           or abs((v_change ->> 'next')::numeric) > 10000000
           or not (v_change ? 'sourceValueAtComparison')
           or jsonb_typeof(v_change -> 'sourceValueAtComparison') <> 'number'
           or abs((v_change ->> 'sourceValueAtComparison')::numeric) > 10000000
           or ((v_change ->> 'sourceValueAtComparison')::numeric * v_scale
             + (v_change ->> 'next')::numeric) < 0 then
          raise exception 'El ajuste numerico no es valido.' using errcode = '22023';
        end if;
        if (v_change ->> 'next')::numeric <> 0 and not exists (
          select 1 from jsonb_array_elements(p_changes) pair
          where pair ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
            and pair ->> 'stableKey' = v_employee_id::text || '|' || v_pair_field
            and jsonb_typeof(pair -> 'next') = 'string'
            and length(btrim(pair ->> 'next')) between 1 and 500
        ) then
          raise exception 'Todo ajuste exige su motivo especifico.' using errcode = '22023';
        end if;
      elsif jsonb_typeof(v_change -> 'next') not in ('string', 'null')
            or (jsonb_typeof(v_change -> 'next') = 'string'
              and length(v_change ->> 'next') > 500) then
        raise exception 'El motivo especifico no es valido.' using errcode = '22023';
      end if;
    elsif v_change ->> 'sheet' = 'MATRIZ_DIARIA_SABANA' then
      if v_change ->> 'cell' !~ '^([F-Z]|A[A-J])([6-9]|[1-9][0-9]+)$'
         or v_stable_key is null
         or length(v_stable_key) > 256
         or split_part(v_stable_key, '|', 1) !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
         or split_part(v_stable_key, '|', 2) !~ '^\d{4}-\d{2}-\d{2}$'
         or split_part(v_stable_key, '|', 3) <> 'Código asistencia'
         or split_part(v_stable_key, '|', 4) <> ''
         or jsonb_typeof(v_change -> 'next') <> 'string'
         or v_change ->> 'next' not in ('P','F','F-P','F-J','P-L','P-M','V','L','L-M','?')
         or not (v_change ? 'sourceValueAtComparison')
         or jsonb_typeof(v_change -> 'sourceValueAtComparison') not in ('string', 'null') then
        raise exception 'El cambio diario no es valido.' using errcode = '22023';
      end if;
      v_employee_id := split_part(v_stable_key, '|', 1)::uuid;
      v_work_date := split_part(v_stable_key, '|', 2)::date;
      v_expected_field := 'Código asistencia';
      if v_work_date not between p_period_start and p_period_end then
        raise exception 'La fecha diaria queda fuera del rango.' using errcode = '22023';
      end if;
    else
      raise exception 'La hoja no contiene campos empresariales ejecutables.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.employees e
      where e.id = v_employee_id and e.company_id = p_company_id
    ) then
      raise exception 'El ajuste no corresponde a la empresa.' using errcode = '23503';
    end if;
  end loop;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform 1
  from storage.objects o
  where o.bucket_id = 'payroll-workbooks'
    and o.name = p_storage_path
    and o.id = p_storage_object_id
    and o.version is not distinct from p_storage_object_version
    and o.updated_at = p_storage_object_updated_at;
  if not found then
    raise exception 'El objeto XLSX cambio despues de verificar sus bytes.' using errcode = '55000';
  end if;

  select revision into v_current_revision
  from private.payroll_source_revisions
  where company_id = p_company_id
  for update;
  if v_current_revision is distinct from p_expected_source_revision then
    raise exception 'Los datos de Workera cambiaron durante la aceptacion.' using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payroll-working|' || p_company_id::text || '|' || p_window_type || '|'
      || p_period_start::text || '|' || p_period_end::text,
    0
  ));

  select * into v_receipt
  from private.payroll_working_acceptance_receipts
  where idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_receipt.actor_id is distinct from p_actor_id
       or v_receipt.company_id is distinct from p_company_id
       or v_receipt.window_type is distinct from p_window_type
       or v_receipt.period_start is distinct from p_period_start
       or v_receipt.period_end is distinct from p_period_end
       or v_receipt.expected_base_version_id is distinct from p_expected_base_version_id
       or v_receipt.source_revision is distinct from p_expected_source_revision
       or v_receipt.content_sha256 is distinct from p_content_sha256
       or v_receipt.file_size is distinct from p_file_size
       or not exists (
         select 1 from public.payroll_working_versions v
         where v.id = v_receipt.version_id
           and v.storage_path = v_receipt.committed_storage_path
       ) then
      raise exception 'El recibo idempotente no coincide con su evidencia.' using errcode = '55000';
    end if;
    return v_receipt.version_id;
  end if;

  select id into v_latest
  from public.payroll_working_versions
  where company_id = p_company_id
    and window_type = p_window_type
    and period_start = p_period_start
    and period_end = p_period_end
  order by version_number desc
  limit 1;
  if v_latest is distinct from p_expected_base_version_id then
    raise exception 'Existe una version de trabajo mas reciente.' using errcode = '40001';
  end if;
  select coalesce(max(version_number), 0) + 1 into v_version_number
  from public.payroll_working_versions
  where company_id = p_company_id
    and window_type = p_window_type
    and period_start = p_period_start
    and period_end = p_period_end;

  insert into public.payroll_working_versions (
    id, company_id, window_type, period_start, period_end, version_number,
    base_version_id, schema_version, content_sha256, file_size, storage_path,
    source_revision, general_reason, accepted_by
  ) values (
    v_version_id, p_company_id, p_window_type, p_period_start, p_period_end,
    v_version_number, v_latest, 'GESTORA_PRENOMINA_2026_V2', p_content_sha256,
    p_file_size, p_storage_path, v_current_revision,
    btrim(p_general_reason), p_actor_id
  );

  insert into public.payroll_working_changes (
    working_version_id, sheet_name, cell_reference, stable_key, employee_id,
    work_date, field_code, change_kind, previous_value, new_value,
    source_value_at_accept, consequence, conflict_resolution,
    conflict_reason, general_reason, decided_by
  )
  select
    v_version_id, x ->> 'sheet', x ->> 'cell',
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL' then x ->> 'stableKey' end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
      then split_part(x ->> 'stableKey', '|', 1)::uuid end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
           and x ->> 'sheet' = 'MATRIZ_DIARIA_SABANA'
      then split_part(x ->> 'stableKey', '|', 2)::date end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL' then
      case when x ->> 'sheet' = 'MATRIZ_DIARIA_SABANA' then 'ATTENDANCE_STATUS_CODE'
      else case regexp_replace(x ->> 'cell', '[0-9]+$', '')
        when 'R' then 'HH50_ADJUSTMENT_MINUTES'
        when 'S' then 'HH50_ADJUSTMENT_REASON'
        when 'U' then 'HH100_ADJUSTMENT_MINUTES'
        when 'V' then 'HH100_ADJUSTMENT_REASON'
        when 'X' then 'BONUS_ADJUSTMENT_CLP'
        when 'Y' then 'BONUS_ADJUSTMENT_REASON'
      end end end,
    x ->> 'kind', x -> 'previous', x -> 'next',
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
      then x -> 'sourceValueAtComparison' end,
    x ->> 'consequence', x ->> 'conflictResolution',
    x ->> 'conflictReason', btrim(p_general_reason), p_actor_id
  from jsonb_array_elements(p_changes) x;

  insert into private.payroll_working_acceptance_receipts (
    idempotency_key, actor_id, company_id, window_type, period_start,
    period_end, expected_base_version_id, source_revision, content_sha256,
    file_size, version_id, committed_storage_path
  ) values (
    p_idempotency_key, p_actor_id, p_company_id, p_window_type,
    p_period_start, p_period_end, p_expected_base_version_id,
    p_expected_source_revision, p_content_sha256, p_file_size,
    v_version_id, p_storage_path
  );
  return v_version_id;
end;
$$;

revoke all on function public.register_accepted_working_workbook(
  uuid, uuid, text, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.register_accepted_working_workbook(
  uuid, uuid, text, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) to service_role;

comment on table public.payroll_working_versions is
  'Versiones inmutables de trabajo por empresa, frecuencia y rango. No representan ni cierran el ciclo mensual oficial.';
comment on function public.register_accepted_working_workbook(
  uuid, uuid, text, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) is
  'Commit service_role-only de una version diaria, semanal o quincenal con bytes atestados, revision de fuentes y allowlist empresarial.';

-- El guard de Storage debe considerar tambien las versiones de trabajo para
-- que sus bytes no puedan borrarse, sustituirse ni recrearse tras el commit.
do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'private.prevent_registered_workforce_object_mutation()'::regprocedure
  );
  v_old := '      exists (
        select 1
        from public.payroll_workbook_versions v
        where v.storage_path = v_old_name
      )
      or exists (';
  v_new := '      exists (
        select 1
        from public.payroll_workbook_versions v
        where v.storage_path = v_old_name
      )
      or exists (
        select 1
        from public.payroll_working_versions w
        where w.storage_path = v_old_name
      )
      or exists (';
  if position(v_old in v_definition) = 0 then
    raise exception 'No se encontro el guard Storage de evidencia registrada.' using errcode = '55000';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '        exists (
          select 1
          from public.payroll_workbook_versions v
          where v.storage_path = v_new_name
        )
        or exists (';
  v_new := '        exists (
          select 1
          from public.payroll_workbook_versions v
          where v.storage_path = v_new_name
        )
        or exists (
          select 1
          from public.payroll_working_versions w
          where w.storage_path = v_new_name
        )
        or exists (';
  if position(v_old in v_definition) = 0 then
    raise exception 'No se encontro el guard Storage de destino registrado.' using errcode = '55000';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$$;
