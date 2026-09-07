-- Conciliación atómica del roster Workera.
--
-- La aplicación prepara un plan cerrado y esta función vuelve a validar su
-- forma y su precondición contra la base. Ninguna fila se busca únicamente
-- por código o UUID: company_id participa en cada lectura y escritura.
--
-- Orden de locks:
--   1. fence global de fuentes de prenómina ya usado por los triggers de
--      employees;
--   2. lock compartido de mutaciones de roster por empresa.
--
-- Cualquier otro escritor de roster (incluido el importador Excel) puede
-- compartir el segundo lock usando exactamente la misma clave.

create or replace function private.normalize_employee_roster_name(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select pg_catalog.upper(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        normalize(pg_catalog.btrim(p_value), NFD),
        '[̀-ͯ]',
        '',
        'g'
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

revoke all on function private.normalize_employee_roster_name(text)
  from public, anon, authenticated, service_role;

create or replace function public.apply_workera_roster_reconciliation(
  p_company_id uuid,
  p_status_updates jsonb,
  p_promotions jsonb,
  p_insert_rows jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_position integer;
  v_id uuid;
  v_prior_external_workera_id text;
  v_external_workera_id text;
  v_first_name text;
  v_last_name text;
  v_display_name text;
  v_prior_active boolean;
  v_prior_updated_at timestamptz;
  v_active boolean;
  v_employee public.employees%rowtype;
  v_affected integer;
  v_name_match_count integer;
  v_status_updated_count integer := 0;
  v_promoted_count integer := 0;
  v_inserted_count integer := 0;
  v_seen_ids uuid[] := array[]::uuid[];
  v_seen_claimed_codes text[] := array[]::text[];
  v_seen_prior_codes text[] := array[]::text[];
begin
  if p_company_id is null then
    raise exception 'La empresa es obligatoria para conciliar el roster Workera.'
      using errcode = '22023';
  end if;

  if not coalesce((
       select c.active and c.status = 'ACTIVE' and c.workspace_enabled
       from public.companies c
       where c.id = p_company_id
     ), false)
     or not (
       coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false)
       or coalesce(public.has_company_app_role(p_company_id, 'SUPER_ADMIN'), false)
     ) then
    raise exception 'No tienes autorización para conciliar el roster de esta empresa.'
      using errcode = '42501';
  end if;

  if p_status_updates is null
     or pg_catalog.jsonb_typeof(p_status_updates) <> 'array'
     or p_promotions is null
     or pg_catalog.jsonb_typeof(p_promotions) <> 'array'
     or p_insert_rows is null
     or pg_catalog.jsonb_typeof(p_insert_rows) <> 'array' then
    raise exception 'Los tres bloques del plan Workera deben ser arreglos JSON.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(p_status_updates)
       + pg_catalog.jsonb_array_length(p_promotions)
       + pg_catalog.jsonb_array_length(p_insert_rows) = 0 then
    raise exception 'El plan Workera no puede estar vacío.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(p_status_updates) > 5000
     or pg_catalog.jsonb_array_length(p_promotions) > 5000
     or pg_catalog.jsonb_array_length(p_insert_rows) > 5000 then
    raise exception 'El plan Workera supera el máximo de 5000 filas por bloque.'
      using errcode = '54000';
  end if;

  -- Valida el plan completo antes de adquirir locks o escribir. También
  -- rechaza IDs/códigos reclamados más de una vez: nunca depende del orden
  -- de un payload contradictorio.
  v_position := 0;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_status_updates)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or not (v_row ?& array[
         'id', 'external_workera_id', 'prior_active', 'prior_updated_at', 'active'
       ])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_row) as supplied(key)
         where supplied.key not in (
           'id', 'external_workera_id', 'prior_active', 'prior_updated_at', 'active'
         )
       )
       or pg_catalog.jsonb_typeof(v_row -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'external_workera_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_active') <> 'boolean'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_updated_at') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'active') <> 'boolean'
       or coalesce(v_row ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'external_workera_id', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'prior_updated_at', ''))) = 0
       or v_row ->> 'external_workera_id' <> pg_catalog.btrim(v_row ->> 'external_workera_id') then
      raise exception 'Actualización de estado inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    begin
      v_prior_updated_at := (v_row ->> 'prior_updated_at')::timestamptz;
    exception
      when data_exception then
        raise exception 'Timestamp previo inválido en actualización de estado, posición %.', v_position
          using errcode = '22023';
    end;

    v_id := (v_row ->> 'id')::uuid;
    v_external_workera_id := v_row ->> 'external_workera_id';
    if v_id = any(v_seen_ids)
       or v_external_workera_id = any(v_seen_claimed_codes) then
      raise exception 'El plan Workera repite una identidad o código de destino.'
        using errcode = '22023';
    end if;
    v_seen_ids := pg_catalog.array_append(v_seen_ids, v_id);
    v_seen_claimed_codes := pg_catalog.array_append(v_seen_claimed_codes, v_external_workera_id);
  end loop;

  v_position := 0;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_promotions)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or not (v_row ?& array[
         'id', 'prior_external_workera_id', 'external_workera_id',
         'prior_active', 'prior_updated_at', 'active'
       ])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_row) as supplied(key)
         where supplied.key not in (
           'id', 'prior_external_workera_id', 'external_workera_id',
           'prior_active', 'prior_updated_at', 'active'
         )
       )
       or pg_catalog.jsonb_typeof(v_row -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_external_workera_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'external_workera_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_active') <> 'boolean'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_updated_at') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'active') <> 'boolean'
       -- Una promoción por nombre es una vinculación de menor confianza:
       -- jamás puede usarse para desactivar una ficha administrativa.
       or (v_row ->> 'active') <> 'true'
       or coalesce(v_row ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'prior_external_workera_id', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'external_workera_id', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'prior_updated_at', ''))) = 0
       or v_row ->> 'prior_external_workera_id' <> pg_catalog.btrim(v_row ->> 'prior_external_workera_id')
       or v_row ->> 'external_workera_id' <> pg_catalog.btrim(v_row ->> 'external_workera_id')
       or v_row ->> 'prior_external_workera_id' = v_row ->> 'external_workera_id' then
      raise exception 'Promoción Workera inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    begin
      v_prior_updated_at := (v_row ->> 'prior_updated_at')::timestamptz;
    exception
      when data_exception then
        raise exception 'Timestamp previo inválido en promoción Workera, posición %.', v_position
          using errcode = '22023';
    end;

    v_id := (v_row ->> 'id')::uuid;
    v_prior_external_workera_id := v_row ->> 'prior_external_workera_id';
    v_external_workera_id := v_row ->> 'external_workera_id';
    if v_id = any(v_seen_ids)
       or v_external_workera_id = any(v_seen_claimed_codes)
       or v_prior_external_workera_id = any(v_seen_prior_codes)
       or v_external_workera_id = any(v_seen_prior_codes)
       or v_prior_external_workera_id = any(v_seen_claimed_codes) then
      raise exception 'El plan Workera contiene promociones superpuestas o contradictorias.'
        using errcode = '22023';
    end if;
    v_seen_ids := pg_catalog.array_append(v_seen_ids, v_id);
    v_seen_claimed_codes := pg_catalog.array_append(v_seen_claimed_codes, v_external_workera_id);
    v_seen_prior_codes := pg_catalog.array_append(v_seen_prior_codes, v_prior_external_workera_id);
  end loop;

  v_position := 0;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_insert_rows)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or not (v_row ?& array['external_workera_id', 'first_name', 'last_name', 'display_name', 'active'])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_row) as supplied(key)
         where supplied.key not in ('external_workera_id', 'first_name', 'last_name', 'display_name', 'active')
       )
       or pg_catalog.jsonb_typeof(v_row -> 'external_workera_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'first_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'last_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'display_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'active') <> 'boolean'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'external_workera_id', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'first_name', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'last_name', ''))) = 0
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_row ->> 'display_name', ''))) = 0
       or v_row ->> 'external_workera_id' <> pg_catalog.btrim(v_row ->> 'external_workera_id')
       or v_row ->> 'first_name' <> pg_catalog.btrim(v_row ->> 'first_name')
       or v_row ->> 'last_name' <> pg_catalog.btrim(v_row ->> 'last_name')
       or v_row ->> 'display_name' <> pg_catalog.btrim(v_row ->> 'display_name') then
      raise exception 'Alta Workera inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    v_external_workera_id := v_row ->> 'external_workera_id';
    if v_external_workera_id = any(v_seen_claimed_codes)
       or v_external_workera_id = any(v_seen_prior_codes) then
      raise exception 'El plan Workera repite o reutiliza un código de destino.'
        using errcode = '22023';
    end if;
    v_seen_claimed_codes := pg_catalog.array_append(v_seen_claimed_codes, v_external_workera_id);
  end loop;

  -- El fence global se toma primero porque todos los triggers de employees
  -- usan ese orden. El segundo lock es el contrato compartible por empresa.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee_roster:' || p_company_id::text, 0)
  );

  -- El rol empresarial pudo revocarse mientras esta transacción esperaba el lock.
  if not coalesce((
       select c.active and c.status = 'ACTIVE' and c.workspace_enabled
       from public.companies c
       where c.id = p_company_id
     ), false)
     or not (
       coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false)
       or coalesce(public.has_company_app_role(p_company_id, 'SUPER_ADMIN'), false)
     ) then
    raise exception 'No tienes autorización para conciliar el roster de esta empresa.'
      using errcode = '42501';
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_status_updates)
  loop
    v_id := (v_row ->> 'id')::uuid;
    v_external_workera_id := v_row ->> 'external_workera_id';
    v_prior_active := (v_row ->> 'prior_active')::boolean;
    v_prior_updated_at := (v_row ->> 'prior_updated_at')::timestamptz;
    v_active := (v_row ->> 'active')::boolean;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.id = v_id
    for update;

    if not found
       or v_employee.external_workera_id is distinct from v_external_workera_id
       or v_employee.source is distinct from 'workera' then
      raise exception 'El plan de estado Workera quedó obsoleto; vuelve a calcularlo.'
        using errcode = '40001';
    end if;

    -- El target ya aplicado es el único no-op permitido para un reintento
    -- equivalente. Si aún no está aplicado, la vigencia y revisión observadas
    -- al planear deben seguir siendo exactamente las mismas. La revisión evita
    -- que un ciclo ABA (false -> true -> false) parezca un estado intacto.
    if v_employee.active is not distinct from v_active then
      continue;
    end if;
    if v_employee.active is distinct from v_prior_active
       or v_employee.updated_at is distinct from v_prior_updated_at then
      raise exception 'La vigencia previa del plan Workera quedó obsoleta; vuelve a calcularlo.'
        using errcode = '40001';
    end if;

    update public.employees e
    set active = v_active
    where e.company_id = p_company_id
      and e.id = v_id
      and e.external_workera_id = v_external_workera_id
      and e.source = 'workera'
      and e.active is not distinct from v_prior_active
      and e.updated_at is not distinct from v_prior_updated_at;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'El plan de estado Workera cambió durante su aplicación.'
        using errcode = '40001';
    end if;
    v_status_updated_count := v_status_updated_count + 1;
  end loop;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_promotions)
  loop
    v_id := (v_row ->> 'id')::uuid;
    v_prior_external_workera_id := v_row ->> 'prior_external_workera_id';
    v_external_workera_id := v_row ->> 'external_workera_id';
    v_prior_active := (v_row ->> 'prior_active')::boolean;
    v_prior_updated_at := (v_row ->> 'prior_updated_at')::timestamptz;
    v_active := true;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.id = v_id
    for update;

    if not found then
      raise exception 'El plan de promoción Workera quedó obsoleto; vuelve a calcularlo.'
        using errcode = '40001';
    end if;

    -- Repetir el mismo plan después de un commit previo equivalente es un
    -- no-op. Cualquier divergencia posterior exige recalcular, no sobrescribir.
    if v_employee.source = 'workera'
       and v_employee.external_workera_id = v_external_workera_id then
      if v_employee.active is distinct from v_active then
        raise exception 'La promoción Workera ya existe con un estado diferente.'
          using errcode = '40001';
      end if;
      continue;
    end if;

    if v_employee.source not in ('excel_roster', 'local_provisional')
       or v_employee.external_workera_id is distinct from v_prior_external_workera_id
       or v_employee.active is distinct from v_prior_active
       or v_employee.updated_at is distinct from v_prior_updated_at then
      raise exception 'El plan de promoción Workera quedó obsoleto; vuelve a calcularlo.'
        using errcode = '40001';
    end if;

    -- La promoción fue planeada exclusivamente porque este nombre tenía una
    -- única ficha administrativa candidata. El lock compartido con Excel ya
    -- está tomado: vuelve a comprobar esa premisa para no vincular una persona
    -- al azar si apareció un homónimo después del snapshot de la aplicación.
    select pg_catalog.count(*)::integer
      into v_name_match_count
    from public.employees candidate
    where candidate.company_id = p_company_id
      and candidate.source in ('excel_roster', 'local_provisional')
      and pg_catalog.upper(
            pg_catalog.regexp_replace(
              pg_catalog.regexp_replace(
                normalize(pg_catalog.btrim(candidate.first_name || ' ' || candidate.last_name), NFD),
                '[̀-ͯ]', '', 'g'
              ),
              '[[:space:]]+', ' ', 'g'
            )
          ) = pg_catalog.upper(
            pg_catalog.regexp_replace(
              pg_catalog.regexp_replace(
                normalize(pg_catalog.btrim(v_employee.first_name || ' ' || v_employee.last_name), NFD),
                '[̀-ͯ]', '', 'g'
              ),
              '[[:space:]]+', ' ', 'g'
            )
          );
    if v_name_match_count <> 1 then
      raise exception 'La coincidencia por nombre de la promoción Workera dejó de ser única.'
        using errcode = '40001';
    end if;

    perform 1
    from public.employees e
    where e.company_id = p_company_id
      and e.external_workera_id = v_external_workera_id
      and e.id <> v_id
    for update;
    if found then
      raise exception 'El código Workera de una promoción ya pertenece a otra ficha.'
        using errcode = '40001';
    end if;

    update public.employees e
    set external_workera_id = v_external_workera_id,
        source = 'workera',
        active = v_active
    where e.company_id = p_company_id
      and e.id = v_id
      and e.external_workera_id = v_prior_external_workera_id
      and e.source in ('excel_roster', 'local_provisional')
      and e.active is not distinct from v_prior_active
      and e.updated_at is not distinct from v_prior_updated_at;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'El plan de promoción Workera cambió durante su aplicación.'
        using errcode = '40001';
    end if;
    v_promoted_count := v_promoted_count + 1;
    if v_prior_active is distinct from v_active then
      v_status_updated_count := v_status_updated_count + 1;
    end if;
  end loop;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_insert_rows)
  loop
    v_external_workera_id := v_row ->> 'external_workera_id';
    v_first_name := v_row ->> 'first_name';
    v_last_name := v_row ->> 'last_name';
    v_display_name := v_row ->> 'display_name';
    v_active := (v_row ->> 'active')::boolean;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.external_workera_id = v_external_workera_id
    for update;

    if found then
      if v_employee.source = 'workera'
         and v_employee.first_name = v_first_name
         and v_employee.last_name = v_last_name
         and v_employee.display_name = v_display_name
         and v_employee.active = v_active then
        continue;
      end if;
      raise exception 'El alta Workera entra en conflicto con una ficha existente.'
        using errcode = '40001';
    end if;

    insert into public.employees (
      company_id,
      external_workera_id,
      first_name,
      last_name,
      display_name,
      source,
      active
    ) values (
      p_company_id,
      v_external_workera_id,
      v_first_name,
      v_last_name,
      v_display_name,
      'workera',
      v_active
    );
    v_inserted_count := v_inserted_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'status_updated_count', v_status_updated_count,
    'promoted_count', v_promoted_count,
    'inserted_count', v_inserted_count
  );
end;
$$;

comment on function public.apply_workera_roster_reconciliation(uuid, jsonb, jsonb, jsonb) is
  'Aplica atómicamente un plan Workera tenant-scoped. Valida payload y estado previo, serializa por empresa y admite reintentos equivalentes sin duplicar ni sobrescribir divergencias.';

revoke all on function public.apply_workera_roster_reconciliation(uuid, jsonb, jsonb, jsonb)
  from public, anon;
grant execute on function public.apply_workera_roster_reconciliation(uuid, jsonb, jsonb, jsonb)
  to authenticated;
