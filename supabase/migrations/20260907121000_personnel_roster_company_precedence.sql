-- Importación administrativa de personal: precedencia de fuentes y límite
-- tenant obligatorios en la última frontera de escritura.
--
-- La firma histórica no recibía company_id, confiaba en el alcance implícito
-- de RLS y forzaba active=true para cualquier update. Eso permitía que una
-- planilla Excel reactivara una baja proveniente de Workera y dejaba una vía
-- incompatible con el control multiempresa actual.

revoke all on function public.apply_personnel_roster_import(jsonb, jsonb, jsonb, uuid)
  from public, anon, authenticated, service_role;
drop function public.apply_personnel_roster_import(jsonb, jsonb, jsonb, uuid);

-- La identidad laboral es propia del tenant: una misma persona puede tener
-- contratos independientes en dos empresas. El índice global era deuda
-- explícita de la fundación multiempresa y hacía imposible ese caso legítimo.
drop index if exists public.employees_rut_key;
create unique index employees_company_id_rut_key
  on public.employees (company_id, rut)
  where rut is not null;

-- Las policies conservan la misma autoridad empresarial que validan los RPC.
-- Se conserva la lectura operacional
-- legacy para usuarios corporativos, pero la administración deja de heredar
-- privilegios desde profiles.role de otro tenant.
drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
  for select to authenticated
  using (
    exists (
      select 1 from public.companies c
      where c.id = public.employees.company_id
        and c.active and c.status = 'ACTIVE' and c.workspace_enabled
    ) and (
    (
      public.is_corporate_user()
      and public.is_active_company_member(company_id)
    )
    or public.has_company_app_role(company_id, 'ADMIN_RRHH')
    or public.has_company_app_role(company_id, 'SUPER_ADMIN'))
  );

drop policy if exists employees_write_admin on public.employees;
create policy employees_write_admin on public.employees
  for all to authenticated
  using (
    exists (select 1 from public.companies c where c.id=public.employees.company_id and c.active and c.status='ACTIVE' and c.workspace_enabled)
    and (public.has_company_app_role(company_id, 'ADMIN_RRHH') or public.has_company_app_role(company_id, 'SUPER_ADMIN'))
  )
  with check (
    exists (select 1 from public.companies c where c.id=public.employees.company_id and c.active and c.status='ACTIVE' and c.workspace_enabled)
    and (public.has_company_app_role(company_id, 'ADMIN_RRHH') or public.has_company_app_role(company_id, 'SUPER_ADMIN'))
  );

drop policy if exists employee_groups_select on public.employee_groups;
create policy employee_groups_select on public.employee_groups
  for select to authenticated
  using (
    (
      public.is_corporate_user()
      and public.is_active_company_member(company_id)
    )
    or public.has_company_app_role(company_id, 'ADMIN_RRHH')
    or public.has_company_app_role(company_id, 'SUPER_ADMIN')
  );

drop policy if exists employee_birthdays_select on public.employee_birthdays;
create policy employee_birthdays_select on public.employee_birthdays
  for select to authenticated
  using (
    (
      public.is_corporate_user()
      and public.employee_belongs_to_active_company(employee_id)
    )
    or exists (
      select 1
      from public.employees e
      where e.id = public.employee_birthdays.employee_id
        and (
          public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
          or public.has_company_app_role(e.company_id, 'SUPER_ADMIN')
        )
    )
  );

drop policy if exists employee_birthdays_write_admin on public.employee_birthdays;
create policy employee_birthdays_write_admin on public.employee_birthdays
  for all to authenticated
  using (
    exists (
      select 1
      from public.employees e
      where e.id = public.employee_birthdays.employee_id
        and (
          public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
          or public.has_company_app_role(e.company_id, 'SUPER_ADMIN')
        )
    )
  )
  with check (
    exists (
      select 1
      from public.employees e
      where e.id = public.employee_birthdays.employee_id
        and (
          public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
          or public.has_company_app_role(e.company_id, 'SUPER_ADMIN')
        )
    )
  );

create function public.apply_personnel_roster_import(
  p_company_id uuid,
  p_confirmed_ruts jsonb,
  p_insert_rows jsonb,
  p_update_rows jsonb,
  p_deactivate_ids jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_row jsonb;
  v_value jsonb;
  v_position integer;
  v_id uuid;
  v_new_id uuid;
  v_group_id uuid;
  v_hire_date date;
  v_employee public.employees%rowtype;
  v_affected integer;
  v_prior_active boolean;
  v_prior_source text;
  v_prior_rut text;
  v_prior_updated_at timestamptz;
  v_target_active boolean;
  v_target_already_applied boolean;
  v_inserted_count integer := 0;
  v_updated_count integer := 0;
  v_reactivated_count integer := 0;
  v_deactivated_count integer := 0;
  v_seen_employee_ids uuid[] := array[]::uuid[];
  v_seen_ruts text[] := array[]::text[];
  v_confirmed_ruts text[] := array[]::text[];
  v_deactivate_employee_ids uuid[] := array[]::uuid[];
  v_prior_birth_month smallint;
  v_prior_birth_day smallint;
  v_existing_birth_month smallint;
  v_existing_birth_day smallint;
begin
  if p_company_id is null then
    raise exception 'La empresa es obligatoria para importar el roster de personal.'
      using errcode = '22023';
  end if;

  if v_actor_id is null or p_actor_id is null or p_actor_id is distinct from v_actor_id then
    raise exception 'El actor del importador no coincide con la sesión autenticada.'
      using errcode = '42501';
  end if;

  if not (
    coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false)
    or coalesce(public.has_company_app_role(p_company_id, 'SUPER_ADMIN'), false)
  ) then
    raise exception 'No tienes autorización para importar personal en esta empresa.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.companies c
    where c.id = p_company_id
      and c.active
      and c.status = 'ACTIVE'
      and c.workspace_enabled
  ) then
    raise exception 'La empresa no tiene un workspace habilitado.' using errcode = '42501';
  end if;

  if p_confirmed_ruts is null
     or pg_catalog.jsonb_typeof(p_confirmed_ruts) <> 'array'
     or pg_catalog.jsonb_array_length(p_confirmed_ruts) = 0
     or p_insert_rows is null
     or pg_catalog.jsonb_typeof(p_insert_rows) <> 'array'
     or p_update_rows is null
     or pg_catalog.jsonb_typeof(p_update_rows) <> 'array'
     or p_deactivate_ids is null
     or pg_catalog.jsonb_typeof(p_deactivate_ids) <> 'array' then
    raise exception 'El roster confirmado y los bloques de cambios deben ser arreglos JSON no vacíos.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(p_confirmed_ruts) > 5000
     or pg_catalog.jsonb_array_length(p_insert_rows) > 5000
     or pg_catalog.jsonb_array_length(p_update_rows) > 5000
     or pg_catalog.jsonb_array_length(p_deactivate_ids) > 5000 then
    raise exception 'El roster supera el máximo de 5000 filas por bloque.'
      using errcode = '54000';
  end if;

  for v_value in select value from pg_catalog.jsonb_array_elements(p_confirmed_ruts)
  loop
    if pg_catalog.jsonb_typeof(v_value) <> 'string'
       or trim(both '"' from v_value::text) !~ '^[0-9]{7,8}-[0-9K]$' then
      raise exception 'El roster confirmado contiene un RUT inválido.' using errcode = '22023';
    end if;
    v_prior_rut := trim(both '"' from v_value::text);
    if v_prior_rut = any(v_confirmed_ruts) then
      raise exception 'El roster confirmado repite un RUT.' using errcode = '22023';
    end if;
    v_confirmed_ruts := pg_catalog.array_append(v_confirmed_ruts, v_prior_rut);
  end loop;

  -- Valida primero la forma completa. Ninguna clave adicional puede colarse
  -- como una mutación no contemplada (en particular company_id/active/source).
  v_position := 0;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_insert_rows)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or not (v_row ?& array[
         'rut', 'first_name', 'last_name', 'display_name',
         'employee_group_id', 'hire_date'
       ])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_row) as supplied(key)
         where supplied.key not in (
           'rut', 'first_name', 'last_name', 'display_name',
           'employee_group_id', 'hire_date', 'birth_month', 'birth_day'
         )
       )
       or pg_catalog.jsonb_typeof(v_row -> 'rut') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'first_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'last_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'display_name') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'employee_group_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'hire_date') <> 'string'
       or coalesce(v_row ->> 'rut', '') !~ '^[0-9]{7,8}-[0-9K]$'
       or pg_catalog.btrim(coalesce(v_row ->> 'first_name', '')) = ''
       or pg_catalog.btrim(coalesce(v_row ->> 'last_name', '')) = ''
       or pg_catalog.btrim(coalesce(v_row ->> 'display_name', '')) = ''
       or v_row ->> 'first_name' <> pg_catalog.btrim(v_row ->> 'first_name')
       or v_row ->> 'last_name' <> pg_catalog.btrim(v_row ->> 'last_name')
       or v_row ->> 'display_name' <> pg_catalog.btrim(v_row ->> 'display_name')
       or (
         coalesce(v_row ->> 'employee_group_id', '') <> ''
         and coalesce(v_row ->> 'employee_group_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       or (
         coalesce(v_row ->> 'hire_date', '') <> ''
         and coalesce(v_row ->> 'hire_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       )
       or (v_row ? 'birth_month') <> (v_row ? 'birth_day') then
      raise exception 'Alta de personal inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    if v_row ? 'birth_month' then
      if pg_catalog.jsonb_typeof(v_row -> 'birth_month') <> 'string'
         or pg_catalog.jsonb_typeof(v_row -> 'birth_day') <> 'string'
         or coalesce(v_row ->> 'birth_month', '') !~ '^([1-9]|1[0-2])$'
         or coalesce(v_row ->> 'birth_day', '') !~ '^([1-9]|[12][0-9]|3[01])$' then
        raise exception 'Cumpleaños inválido en alta de posición %.', v_position
          using errcode = '22023';
      end if;
    end if;

    if (v_row ->> 'rut') = any(v_seen_ruts) then
      raise exception 'El bloque de altas repite un RUT.' using errcode = '22023';
    end if;
    v_seen_ruts := pg_catalog.array_append(v_seen_ruts, v_row ->> 'rut');
  end loop;

  v_position := 0;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_update_rows)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or not (v_row ?& array[
         'id', 'employee_group_id', 'hire_date',
         'prior_rut', 'prior_source', 'prior_active', 'prior_updated_at'
       ])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_row) as supplied(key)
         where supplied.key not in (
           'id', 'employee_group_id', 'hire_date',
           'first_name', 'last_name', 'display_name',
           'birth_month', 'birth_day', 'prior_birth_month', 'prior_birth_day', 'reactivate',
           'prior_rut', 'prior_source', 'prior_active', 'prior_updated_at'
         )
       )
       or pg_catalog.jsonb_typeof(v_row -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'employee_group_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'hire_date') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_rut') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_source') <> 'string'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_active') <> 'boolean'
       or pg_catalog.jsonb_typeof(v_row -> 'prior_updated_at') <> 'string'
       or coalesce(v_row ->> 'id', '')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_row ->> 'prior_rut', '') !~ '^[0-9]{7,8}-[0-9K]$'
       or coalesce(v_row ->> 'prior_source', '') not in ('workera', 'excel_roster', 'local_provisional')
       or pg_catalog.btrim(coalesce(v_row ->> 'prior_updated_at', '')) = ''
       or v_row ->> 'prior_updated_at' <> pg_catalog.btrim(v_row ->> 'prior_updated_at')
       or not pg_catalog.pg_input_is_valid(
         v_row ->> 'prior_updated_at',
         'timestamp with time zone'
       )
       or (
         coalesce(v_row ->> 'employee_group_id', '') <> ''
         and coalesce(v_row ->> 'employee_group_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       or (
         coalesce(v_row ->> 'hire_date', '') <> ''
         and coalesce(v_row ->> 'hire_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       )
       or (v_row ? 'first_name') <> (v_row ? 'last_name')
       or (v_row ? 'first_name') <> (v_row ? 'display_name')
       or (v_row ? 'birth_month') <> (v_row ? 'birth_day')
       or (v_row ? 'prior_birth_month') <> (v_row ? 'prior_birth_day')
       or (v_row ? 'birth_month') <> (v_row ? 'prior_birth_month') then
      raise exception 'Actualización de personal inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    if v_row ? 'first_name' then
      if pg_catalog.jsonb_typeof(v_row -> 'first_name') <> 'string'
         or pg_catalog.jsonb_typeof(v_row -> 'last_name') <> 'string'
         or pg_catalog.jsonb_typeof(v_row -> 'display_name') <> 'string'
         or pg_catalog.btrim(coalesce(v_row ->> 'first_name', '')) = ''
         or pg_catalog.btrim(coalesce(v_row ->> 'last_name', '')) = ''
         or pg_catalog.btrim(coalesce(v_row ->> 'display_name', '')) = ''
         or v_row ->> 'first_name' <> pg_catalog.btrim(v_row ->> 'first_name')
         or v_row ->> 'last_name' <> pg_catalog.btrim(v_row ->> 'last_name')
         or v_row ->> 'display_name' <> pg_catalog.btrim(v_row ->> 'display_name') then
        raise exception 'Identidad Excel inválida en actualización de posición %.', v_position
          using errcode = '22023';
      end if;
    end if;

    if v_row ? 'birth_month' then
      if pg_catalog.jsonb_typeof(v_row -> 'birth_month') <> 'string'
         or pg_catalog.jsonb_typeof(v_row -> 'birth_day') <> 'string'
         or coalesce(v_row ->> 'birth_month', '') !~ '^([1-9]|1[0-2])$'
         or coalesce(v_row ->> 'birth_day', '') !~ '^([1-9]|[12][0-9]|3[01])$'
         or pg_catalog.jsonb_typeof(v_row -> 'prior_birth_month') <> 'string'
         or pg_catalog.jsonb_typeof(v_row -> 'prior_birth_day') <> 'string'
         or not (
           (coalesce(v_row ->> 'prior_birth_month', '') = '' and coalesce(v_row ->> 'prior_birth_day', '') = '')
           or (
             coalesce(v_row ->> 'prior_birth_month', '') ~ '^([1-9]|1[0-2])$'
             and coalesce(v_row ->> 'prior_birth_day', '') ~ '^([1-9]|[12][0-9]|3[01])$'
           )
         ) then
        raise exception 'Cumpleaños inválido en actualización de posición %.', v_position
          using errcode = '22023';
      end if;
    end if;

    if v_row ? 'reactivate' then
      if pg_catalog.jsonb_typeof(v_row -> 'reactivate') <> 'string'
         or v_row ->> 'reactivate' <> 'true'
         or (v_row ->> 'prior_active')::boolean is distinct from false then
        raise exception 'La reactivación debe ser la marca explícita string true.'
          using errcode = '22023';
      end if;
    end if;

    v_id := (v_row ->> 'id')::uuid;
    if v_id = any(v_seen_employee_ids) then
      raise exception 'El plan de personal repite un employee id.' using errcode = '22023';
    end if;
    v_seen_employee_ids := pg_catalog.array_append(v_seen_employee_ids, v_id);
    if (v_row ->> 'prior_rut') = any(v_seen_ruts) then
      raise exception 'El plan repite un RUT confirmado.' using errcode = '22023';
    end if;
    v_seen_ruts := pg_catalog.array_append(v_seen_ruts, v_row ->> 'prior_rut');
  end loop;

  v_position := 0;
  for v_value in select value from pg_catalog.jsonb_array_elements(p_deactivate_ids)
  loop
    v_position := v_position + 1;
    if pg_catalog.jsonb_typeof(v_value) <> 'object'
       or not (v_value ?& array['id', 'prior_rut', 'prior_source', 'prior_active', 'prior_updated_at'])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_value) as supplied(key)
         where supplied.key not in ('id', 'prior_rut', 'prior_source', 'prior_active', 'prior_updated_at')
       )
       or pg_catalog.jsonb_typeof(v_value -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_value -> 'prior_rut') <> 'string'
       or pg_catalog.jsonb_typeof(v_value -> 'prior_source') <> 'string'
       or pg_catalog.jsonb_typeof(v_value -> 'prior_active') <> 'boolean'
       or pg_catalog.jsonb_typeof(v_value -> 'prior_updated_at') <> 'string'
       or coalesce(v_value ->> 'id', '')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Precondición de desactivación inválida en posición %.', v_position
        using errcode = '22023';
    end if;

    if coalesce(v_value ->> 'prior_rut', '') !~ '^[0-9]{7,8}-[0-9K]$'
       or v_value ->> 'prior_source' <> 'excel_roster'
       or (v_value ->> 'prior_active')::boolean is distinct from true
       or pg_catalog.btrim(coalesce(v_value ->> 'prior_updated_at', '')) = ''
       or v_value ->> 'prior_updated_at' <> pg_catalog.btrim(v_value ->> 'prior_updated_at')
       or not pg_catalog.pg_input_is_valid(
         v_value ->> 'prior_updated_at',
         'timestamp with time zone'
       ) then
      raise exception 'La desactivación no representa una fila Excel activa.'
        using errcode = '22023';
    end if;

    v_id := (v_value ->> 'id')::uuid;
    if v_id = any(v_seen_employee_ids) then
      raise exception 'El plan repite o contradice un employee id.' using errcode = '22023';
    end if;
    v_seen_employee_ids := pg_catalog.array_append(v_seen_employee_ids, v_id);
    v_deactivate_employee_ids := pg_catalog.array_append(v_deactivate_employee_ids, v_id);
  end loop;

  if pg_catalog.cardinality(v_seen_ruts) <> pg_catalog.cardinality(v_confirmed_ruts)
     or exists (
       select 1 from pg_catalog.unnest(v_confirmed_ruts) confirmed(rut)
       where not (confirmed.rut = any(v_seen_ruts))
     ) then
    raise exception 'El plan no representa exactamente el roster confirmado.' using errcode = '22023';
  end if;

  -- Conserva el orden global de locks de las fuentes de prenómina y agrega
  -- el fence específico solicitado para cualquier mutación del roster.
  perform pg_advisory_xact_lock(hashtextextended('payroll-source-mutation-v1', 0));
  perform pg_advisory_xact_lock(hashtextextended('employee_roster:' || p_company_id::text, 0));

  -- La membresía puede revocarse mientras la transacción espera el lock.
  if auth.uid() is distinct from v_actor_id
     or p_actor_id is distinct from auth.uid()
     or not (
       coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false)
       or coalesce(public.has_company_app_role(p_company_id, 'SUPER_ADMIN'), false)
     ) then
    raise exception 'La autorización para importar personal ya no está vigente.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.companies c
    where c.id = p_company_id
      and c.active
      and c.status = 'ACTIVE'
      and c.workspace_enabled
  ) then
    raise exception 'El workspace de la empresa ya no está habilitado.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.employees e
    where e.company_id = p_company_id
      and e.source = 'excel_roster'
      and e.active
      and (e.rut is null or not (e.rut = any(v_confirmed_ruts)))
      and not (e.id = any(v_deactivate_employee_ids))
  ) or exists (
    select 1 from pg_catalog.unnest(v_deactivate_employee_ids) planned(id)
    left join public.employees e
      on e.company_id = p_company_id and e.id = planned.id
    where e.id is null
       or e.source <> 'excel_roster'
       or not e.active
       or e.rut = any(v_confirmed_ruts)
  ) then
    raise exception 'El padrón cambió; vuelve a revisar el archivo completo.' using errcode = '40001';
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_insert_rows)
  loop
    v_group_id := nullif(v_row ->> 'employee_group_id', '')::uuid;
    v_hire_date := nullif(v_row ->> 'hire_date', '')::date;
    v_target_already_applied := false;

    if v_group_id is not null and not exists (
      select 1
      from public.employee_groups eg
      where eg.company_id = p_company_id
        and eg.id = v_group_id
    ) then
      raise exception 'El grupo de una alta no pertenece a la empresa.'
        using errcode = '22023';
    end if;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.rut = v_row ->> 'rut'
    for update;

    if found then
      -- Un retry posterior a un timeout puede repetir exactamente la misma
      -- alta. Sólo ese resultado equivalente es no-op; cualquier identidad o
      -- estado distinto obliga a recalcular el roster.
      if v_employee.external_workera_id is distinct from 'EXCEL-' || (v_row ->> 'rut')
         or v_employee.first_name is distinct from v_row ->> 'first_name'
         or v_employee.last_name is distinct from v_row ->> 'last_name'
         or v_employee.display_name is distinct from v_row ->> 'display_name'
         or v_employee.employee_group_id is distinct from v_group_id
         or v_employee.hire_date is distinct from v_hire_date
         or v_employee.source is distinct from 'excel_roster'
         or v_employee.active is distinct from true
         or (
           (v_row ? 'birth_month')
           and not exists (
             select 1
             from public.employee_birthdays eb
             where eb.employee_id = v_employee.id
               and eb.birth_month = (v_row ->> 'birth_month')::smallint
               and eb.birth_day = (v_row ->> 'birth_day')::smallint
           )
         ) then
        raise exception 'El alta de personal quedó obsoleta; vuelve a revisar el archivo.'
          using errcode = '40001';
      end if;
      v_new_id := v_employee.id;
      v_target_already_applied := true;
    else
      insert into public.employees (
        company_id,
        external_workera_id,
        rut,
        first_name,
        last_name,
        display_name,
        employee_group_id,
        hire_date,
        source,
        active
      ) values (
        p_company_id,
        'EXCEL-' || (v_row ->> 'rut'),
        v_row ->> 'rut',
        v_row ->> 'first_name',
        v_row ->> 'last_name',
        v_row ->> 'display_name',
        v_group_id,
        v_hire_date,
        'excel_roster',
        true
      )
      returning id into v_new_id;
      v_inserted_count := v_inserted_count + 1;
    end if;

    if (v_row ? 'birth_month') and not v_target_already_applied then
      insert into public.employee_birthdays (
        employee_id, birth_month, birth_day, created_by
      ) values (
        v_new_id,
        (v_row ->> 'birth_month')::smallint,
        (v_row ->> 'birth_day')::smallint,
        v_actor_id
      )
      on conflict (employee_id) do update
        set birth_month = excluded.birth_month,
            birth_day = excluded.birth_day;
    end if;
  end loop;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_update_rows)
  loop
    v_id := (v_row ->> 'id')::uuid;
    v_group_id := nullif(v_row ->> 'employee_group_id', '')::uuid;
    v_hire_date := nullif(v_row ->> 'hire_date', '')::date;
    v_prior_rut := v_row ->> 'prior_rut';
    v_prior_source := v_row ->> 'prior_source';
    v_prior_active := (v_row ->> 'prior_active')::boolean;
    v_prior_updated_at := (v_row ->> 'prior_updated_at')::timestamptz;
    v_target_active := case
      when (v_row ->> 'reactivate') = 'true' then true
      else v_prior_active
    end;
    v_prior_birth_month := nullif(v_row ->> 'prior_birth_month', '')::smallint;
    v_prior_birth_day := nullif(v_row ->> 'prior_birth_day', '')::smallint;
    v_existing_birth_month := null;
    v_existing_birth_day := null;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.id = v_id
    for update;

    if not found then
      raise exception 'El plan de actualización quedó obsoleto; vuelve a revisar el archivo.'
        using errcode = '40001';
    end if;

    if v_row ? 'birth_month' then
      select eb.birth_month, eb.birth_day
        into v_existing_birth_month, v_existing_birth_day
      from public.employee_birthdays eb
      where eb.employee_id = v_id
      for update;
    end if;

    if v_group_id is not null and not exists (
      select 1
      from public.employee_groups eg
      where eg.company_id = p_company_id
        and eg.id = v_group_id
    ) then
      raise exception 'El grupo de una actualización no pertenece a la empresa.'
        using errcode = '22023';
    end if;

    -- La precedencia de fuente es una regla de autorización, incluso cuando
    -- el payload coincide por casualidad con el estado actual. Un comando que
    -- Excel no tiene autoridad para emitir nunca se acepta como supuesto retry.
    if (v_row ? 'first_name') and v_employee.source <> 'excel_roster' then
      raise exception 'Excel no puede reemplazar una identidad de mayor autoridad.'
        using errcode = '42501';
    end if;

    if (v_row ? 'reactivate') and v_employee.source <> 'excel_roster' then
      raise exception 'Excel no puede reactivar una baja de mayor autoridad.'
        using errcode = '42501';
    end if;

    v_target_already_applied :=
      v_employee.rut is not distinct from v_prior_rut
      and v_employee.source is not distinct from v_prior_source
      and v_employee.employee_group_id is not distinct from v_group_id
      and v_employee.hire_date is not distinct from v_hire_date
      and v_employee.active is not distinct from v_target_active
      and (
        not (v_row ? 'first_name')
        or (
          v_employee.first_name is not distinct from v_row ->> 'first_name'
          and v_employee.last_name is not distinct from v_row ->> 'last_name'
          and v_employee.display_name is not distinct from v_row ->> 'display_name'
        )
      )
      and (
        not (v_row ? 'birth_month')
        or (v_existing_birth_month is not distinct from (v_row ->> 'birth_month')::smallint
            and v_existing_birth_day is not distinct from (v_row ->> 'birth_day')::smallint)
      );

    if not v_target_already_applied then
      if v_employee.rut is distinct from v_prior_rut
         or v_employee.source is distinct from v_prior_source
         or v_employee.active is distinct from v_prior_active
         or v_employee.updated_at is distinct from v_prior_updated_at
         or ((v_row ? 'birth_month') and (
           v_existing_birth_month is distinct from v_prior_birth_month
           or v_existing_birth_day is distinct from v_prior_birth_day
         )) then
        raise exception 'El plan de actualización quedó obsoleto; vuelve a revisar el archivo.'
          using errcode = '40001';
      end if;

      update public.employees e
      set first_name = case
            when v_employee.source = 'excel_roster' and (v_row ? 'first_name')
              then v_row ->> 'first_name'
            else e.first_name
          end,
          last_name = case
            when v_employee.source = 'excel_roster' and (v_row ? 'last_name')
              then v_row ->> 'last_name'
            else e.last_name
          end,
          display_name = case
            when v_employee.source = 'excel_roster' and (v_row ? 'display_name')
              then v_row ->> 'display_name'
            else e.display_name
          end,
          employee_group_id = v_group_id,
          hire_date = v_hire_date,
          active = v_target_active
      where e.company_id = p_company_id
        and e.id = v_id
        and e.rut = v_prior_rut
        and e.source = v_prior_source
        and e.active = v_prior_active
        and e.updated_at = v_prior_updated_at;

      get diagnostics v_affected = row_count;
      if v_affected <> 1 then
        raise exception 'El plan de actualización cambió durante la aplicación.'
          using errcode = '40001';
      end if;

      if (v_row ->> 'reactivate') = 'true' then
        v_reactivated_count := v_reactivated_count + 1;
      else
        v_updated_count := v_updated_count + 1;
      end if;
    end if;

    if (v_row ? 'birth_month') and not v_target_already_applied then
      insert into public.employee_birthdays (
        employee_id, birth_month, birth_day, created_by
      ) values (
        v_id,
        (v_row ->> 'birth_month')::smallint,
        (v_row ->> 'birth_day')::smallint,
        v_actor_id
      )
      on conflict (employee_id) do update
        set birth_month = excluded.birth_month,
            birth_day = excluded.birth_day;
    end if;
  end loop;

  for v_value in select value from pg_catalog.jsonb_array_elements(p_deactivate_ids)
  loop
    v_id := (v_value ->> 'id')::uuid;
    v_prior_rut := v_value ->> 'prior_rut';
    v_prior_source := v_value ->> 'prior_source';
    v_prior_active := (v_value ->> 'prior_active')::boolean;
    v_prior_updated_at := (v_value ->> 'prior_updated_at')::timestamptz;

    select e.*
      into v_employee
    from public.employees e
    where e.company_id = p_company_id
      and e.id = v_id
    for update;

    if not found then
      raise exception 'El plan de desactivación quedó obsoleto; vuelve a revisar el archivo.'
        using errcode = '40001';
    end if;

    if v_employee.rut is not distinct from v_prior_rut
       and v_employee.source is not distinct from v_prior_source
       and v_employee.active is false then
      continue;
    end if;

    if v_employee.rut is distinct from v_prior_rut
       or v_employee.source is distinct from v_prior_source
       or v_employee.active is distinct from v_prior_active
       or v_employee.updated_at is distinct from v_prior_updated_at then
      raise exception 'El plan de desactivación quedó obsoleto; vuelve a revisar el archivo.'
        using errcode = '40001';
    end if;

    if v_employee.source <> 'excel_roster' then
      raise exception 'Excel sólo puede desactivar filas creadas por excel_roster.'
        using errcode = '42501';
    end if;

    update public.employees e
    set active = false
    where e.company_id = p_company_id
      and e.id = v_id
      and e.rut = v_prior_rut
      and e.source = v_prior_source
      and e.active = v_prior_active
      and e.updated_at = v_prior_updated_at;

    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'La desactivación dejó de pertenecer al tenant durante la aplicación.'
        using errcode = '40001';
    end if;
    v_deactivated_count := v_deactivated_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'inserted_count', v_inserted_count,
    'updated_count', v_updated_count,
    'reactivated_count', v_reactivated_count,
    'deactivated_count', v_deactivated_count
  );
end;
$$;

comment on function public.apply_personnel_roster_import(uuid, jsonb, jsonb, jsonb, jsonb, uuid) is
  'Aplica atómicamente un roster Excel dentro de una empresa explícita. '
  'SECURITY DEFINER; exige rol ADMIN_RRHH/SUPER_ADMIN del tenant y valida '
  'precondiciones bajo lock. Excel sólo reactiva filas source=excel_roster '
  'mediante reactivate="true"; jamás reactiva ni desactiva Workera/provisionales.';

revoke all on function public.apply_personnel_roster_import(uuid, jsonb, jsonb, jsonb, jsonb, uuid)
  from public, anon, service_role;
grant execute on function public.apply_personnel_roster_import(uuid, jsonb, jsonb, jsonb, jsonb, uuid)
  to authenticated;

-- Las mutaciones de padrón de usuarios autenticados pasan exclusivamente por
-- los RPC atómicos; service_role conserva la integración Workera histórica.
revoke insert, update, delete on public.employees from authenticated;
