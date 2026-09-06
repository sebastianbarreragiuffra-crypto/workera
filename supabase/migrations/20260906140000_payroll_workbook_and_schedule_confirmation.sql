-- Auditoría final de Asistencia / pre-nómina.
--
-- 1) Un horario distinto del habitual solo se considera confirmado cuando
--    ADMIN_RRHH lo asigna explícitamente. La asignación conserva actor y fecha.
--    SUPER_ADMIN mantiene lectura técnica, pero deja de mutar este dominio.
-- 2) La aceptación de un Excel comprueba el objeto privado ya subido, limita
--    el lote y deriva en SQL las claves empresariales que luego se reaplican.

-- ---------------------------------------------------------------------------
-- Confirmación auditable de horarios

alter table public.schedule_assignments
  add column rrhh_confirmed_by uuid references public.profiles(id),
  add column rrhh_confirmed_at timestamptz,
  add column confirmation_reason text;

alter table public.schedule_assignments
  add constraint schedule_assignments_rrhh_confirmation_chk check (
    (
      rrhh_confirmed_by is null
      and rrhh_confirmed_at is null
      and confirmation_reason is null
    )
    or (
      rrhh_confirmed_by is not null
      and rrhh_confirmed_at is not null
      and confirmation_reason is not null
      and length(btrim(confirmation_reason)) between 1 and 500
    )
  );

comment on column public.schedule_assignments.rrhh_confirmed_by is
  'RR. HH. que confirmó que este es el horario efectivo del trabajador.';
comment on column public.schedule_assignments.rrhh_confirmed_at is
  'Fecha y hora de la confirmación explícita del horario por RR. HH.';
comment on column public.schedule_assignments.confirmation_reason is
  'Trazabilidad de la confirmación del horario efectivo; nunca se infiere por nombre.';

-- Las asignaciones históricas quedan deliberadamente sin confirmación. No se
-- inventa una aprobación retroactiva; RR. HH. debe reaplicar el horario si
-- necesita confirmar una excepción efectiva.
create or replace function public.apply_schedule_assignment(
  p_employee_id uuid,
  p_work_schedule_id uuid,
  p_effective_from date
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_current record;
  v_reason constant text := 'Horario efectivo confirmado por RR. HH. desde Configuración > Horarios.';
begin
  if v_actor is null or public.current_user_role() <> 'ADMIN_RRHH' then
    raise exception 'Solo RR. HH. puede confirmar o cambiar horarios.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  select id, work_schedule_id, effective_from, effective_to
    into v_current
  from public.schedule_assignments
  where employee_id = p_employee_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to >= p_effective_from)
  order by effective_from desc
  limit 1
  for update;

  -- Reaplicar el mismo horario funciona como confirmación explícita de una
  -- fila histórica que todavía no tenía actor/fecha.
  if found and v_current.work_schedule_id = p_work_schedule_id then
    update public.schedule_assignments
    set rrhh_confirmed_by = v_actor,
        rrhh_confirmed_at = clock_timestamp(),
        confirmation_reason = v_reason
    where id = v_current.id;
    return;
  end if;

  -- Si empieza ese mismo día, se corrige la fila sin crear un rango invertido.
  if found and v_current.effective_from = p_effective_from then
    update public.schedule_assignments
    set work_schedule_id = p_work_schedule_id,
        rrhh_confirmed_by = v_actor,
        rrhh_confirmed_at = clock_timestamp(),
        confirmation_reason = v_reason
    where id = v_current.id;
    return;
  end if;

  if found then
    update public.schedule_assignments
    set effective_to = p_effective_from - 1
    where id = v_current.id;
  end if;

  if exists (
    select 1
    from public.schedule_assignments
    where employee_id = p_employee_id
      and effective_from > p_effective_from
  ) then
    raise exception
      'Este trabajador ya tiene un horario programado a futuro. Elimínalo antes de reasignar desde %.',
      p_effective_from;
  end if;

  insert into public.schedule_assignments (
    employee_id,
    work_schedule_id,
    effective_from,
    rrhh_confirmed_by,
    rrhh_confirmed_at,
    confirmation_reason
  ) values (
    p_employee_id,
    p_work_schedule_id,
    p_effective_from,
    v_actor,
    clock_timestamp(),
    v_reason
  );
end;
$$;

comment on function public.apply_schedule_assignment(uuid, uuid, date) is
  'Asigna y confirma un horario de forma atómica. Solo ADMIN_RRHH con MFA; '
  'cada confirmación conserva actor, fecha y motivo.';

-- La UI repite este control, pero la autorización real vive también en RLS.
drop policy if exists work_schedules_write_admin on public.work_schedules;
create policy work_schedules_write_admin on public.work_schedules
  for all to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

drop policy if exists work_schedule_rules_write_admin on public.work_schedule_rules;
create policy work_schedule_rules_write_admin on public.work_schedule_rules
  for all to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

drop policy if exists schedule_assignments_write_admin on public.schedule_assignments;
create policy schedule_assignments_write_admin on public.schedule_assignments
  for all to authenticated
  using (
    public.is_admin_rrhh()
    and public.employee_belongs_to_active_company(employee_id)
  )
  with check (
    public.is_admin_rrhh()
    and public.employee_belongs_to_active_company(employee_id)
    and (rrhh_confirmed_by is null or rrhh_confirmed_by = auth.uid())
  );

drop policy if exists employee_time_control_policies_write_admin on public.employee_time_control_policies;
create policy employee_time_control_policies_write_admin on public.employee_time_control_policies
  for all to authenticated
  using (
    public.is_admin_rrhh()
    and public.employee_belongs_to_active_company(employee_id)
  )
  with check (
    public.is_admin_rrhh()
    and public.employee_belongs_to_active_company(employee_id)
  );

revoke all on function public.apply_schedule_assignment(uuid, uuid, date) from public, anon;
grant execute on function public.apply_schedule_assignment(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Persistencia segura de ajustes del Excel

alter table public.payroll_workbook_changes
  add column source_value_at_accept jsonb;

comment on column public.payroll_workbook_changes.source_value_at_accept is
  'Valor automático confiable contra el cual RR. HH. decidió el ajuste; permite detectar conflictos al regenerar.';

-- UNIQUE con NULL no evitaba dos conflictos abiertos para la misma clave.
drop index if exists public.payroll_workbook_conflicts_open_idx;
create unique index payroll_workbook_conflicts_open_idx
  on public.payroll_workbook_conflicts(company_id, reporting_period_id, stable_key)
  where resolved_at is null;

create or replace function public.register_accepted_payroll_workbook(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_base_version_id uuid,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text,
  p_general_reason text,
  p_changes jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_period uuid;
  v_latest uuid;
  v_id uuid := gen_random_uuid();
  v_number integer;
  v_change jsonb;
  v_column text;
  v_expected_field text;
  v_stable_key text;
  v_employee_id uuid;
  v_work_date date;
  v_scale numeric;
  v_pair_field text;
begin
  if v_actor is null
     or p_company_id is null
     or not coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'Solo RR. HH. puede confirmar una pre-nómina.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_period_start is null
     or p_period_end is null
     or p_period_end <> (date_trunc('month', p_period_end)::date + 14)
     or p_period_start <> ((date_trunc('month', p_period_end)::date - 1) - interval '15 days')::date then
    raise exception 'El período debe corresponder al corte 16-15.' using errcode = '22023';
  end if;
  if p_content_sha256 is null
     or p_content_sha256 !~ '^[a-f0-9]{64}$'
     or p_file_size is null
     or p_file_size not between 1 and 15728640
     or length(btrim(coalesce(p_general_reason, ''))) not between 1 and 2000 then
    raise exception 'Metadatos de archivo inválidos.' using errcode = '22023';
  end if;
  if p_storage_path is null or p_storage_path !~ (
    '^' || p_company_id::text || '/'
    || p_period_start::text || '_' || p_period_end::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]xlsx$'
  ) then
    raise exception 'La ruta privada del archivo no corresponde a empresa y período.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'payroll-workbooks'
      and o.name = p_storage_path
      and o.owner_id = v_actor::text
      and o.metadata ->> 'mimetype' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      and case
        when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
        else -1
      end = p_file_size
  ) then
    raise exception 'El Excel privado no existe, no pertenece al actor o no coincide con sus metadatos.' using errcode = '23503';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'La lista de cambios debe ser un arreglo JSON.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 500 then
    raise exception 'Una versión admite como máximo 500 cambios revisables.' using errcode = '54000';
  end if;
  if pg_column_size(p_changes) > 2097152 then
    raise exception 'La evidencia de cambios excede el máximo permitido.' using errcode = '54000';
  end if;

  -- El cliente puede describir diferencias, pero no decide qué se ejecuta.
  -- Solo seis columnas de RESUMEN_NOMINA se convierten en ajuste empresarial.
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
       or coalesce(v_change ->> 'consequence', '') not in ('AJUSTE_EMPRESARIAL', 'CONSERVAR_ARCHIVO_SIN_EJECUTAR') then
      raise exception 'La evidencia contiene un cambio inválido.' using errcode = '22023';
    end if;

    if v_change ->> 'consequence' = 'AJUSTE_EMPRESARIAL' then
      if (v_change ? 'conflictResolution') or (v_change ? 'conflictReason') then
        if coalesce(v_change ->> 'conflictResolution', '') not in ('KEEP_RRHH','ACCEPT_WORKERA','THIRD_VALUE')
           or jsonb_typeof(v_change -> 'conflictReason') <> 'string'
           or length(btrim(v_change ->> 'conflictReason')) not between 1 and 500 then
          raise exception 'La resolución del conflicto exige opción y motivo válidos.' using errcode = '22023';
        end if;
      end if;
      if v_change ->> 'kind' <> 'VALUE' then
        raise exception 'Solo cambios de valor reconocidos pueden ejecutarse.' using errcode = '22023';
      end if;
      v_stable_key := v_change ->> 'stableKey';

      if v_change ->> 'sheet' = 'RESUMEN_NOMINA' then
        if v_change ->> 'cell' !~ '^(R|S|U|V|X|Y)([6-9]|[1-9][0-9]+)$' then
          raise exception 'Solo R/S/U/V/X/Y pueden ejecutarse en el resumen.' using errcode = '22023';
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
          raise exception 'La clave estable del ajuste no corresponde al campo permitido.' using errcode = '22023';
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
             or ((v_change ->> 'sourceValueAtComparison')::numeric * v_scale + (v_change ->> 'next')::numeric) < 0 then
            raise exception 'Los ajustes deben ser enteros, acotados, no negativos al conciliar y conservar su origen.' using errcode = '22023';
          end if;
          if (v_change ->> 'next')::numeric <> 0 and not exists (
            select 1
            from jsonb_array_elements(p_changes) pair
            where pair ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
              and pair ->> 'stableKey' = v_employee_id::text || '|' || v_pair_field
              and jsonb_typeof(pair -> 'next') = 'string'
              and length(btrim(pair ->> 'next')) between 1 and 500
          ) then
            raise exception 'Todo ajuste distinto de cero exige su motivo específico emparejado.' using errcode = '22023';
          end if;
        elsif jsonb_typeof(v_change -> 'next') not in ('string', 'null')
              or (jsonb_typeof(v_change -> 'next') = 'string' and length(v_change ->> 'next') > 500) then
          raise exception 'El motivo específico del ajuste no es válido.' using errcode = '22023';
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
          raise exception 'El cambio diario no contiene trabajador, fecha o código oficial válido.' using errcode = '22023';
        end if;
        v_employee_id := split_part(v_stable_key, '|', 1)::uuid;
        v_work_date := split_part(v_stable_key, '|', 2)::date;
        v_expected_field := 'Código asistencia';
        if v_work_date not between p_period_start and p_period_end then
          raise exception 'La fecha diaria queda fuera del período 16-15.' using errcode = '22023';
        end if;
      else
        raise exception 'La hoja no contiene campos empresariales ejecutables.' using errcode = '22023';
      end if;

      if not exists (
        select 1 from public.employees e
        where e.id = v_employee_id
          and e.company_id = p_company_id
      ) then
        raise exception 'El ajuste no corresponde a un trabajador de la empresa.' using errcode = '23503';
      end if;
    end if;
  end loop;

  -- reporting_periods sigue siendo parte del dominio laboral ARCOTEX legacy y
  -- no declara company_id; la versión sí congela explícitamente la empresa.
  select id into v_period
  from public.reporting_periods
  where period_start = p_period_start
    and period_end = p_period_end;
  if v_period is null then
    raise exception 'El período no existe para esta empresa.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('payroll-workbook|' || p_company_id::text || '|' || v_period::text, 0)
  );
  select id into v_latest
  from public.payroll_workbook_versions
  where company_id = p_company_id
    and reporting_period_id = v_period
    and status = 'ACCEPTED'
  order by version_number desc
  limit 1;
  if v_latest is distinct from p_expected_base_version_id then
    raise exception 'La pre-nómina cambió mientras la revisabas. Vuelve a comparar.' using errcode = '40001';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_number
  from public.payroll_workbook_versions
  where company_id = p_company_id
    and reporting_period_id = v_period;

  insert into public.payroll_workbook_versions (
    id, company_id, reporting_period_id, period_start, period_end,
    version_number, base_version_id, status, schema_version, content_sha256,
    file_size, storage_path, general_reason, uploaded_by, accepted_by, accepted_at
  ) values (
    v_id, p_company_id, v_period, p_period_start, p_period_end,
    v_number, v_latest, 'ACCEPTED', 'GESTORA_PRENOMINA_2026_V2', p_content_sha256,
    p_file_size, p_storage_path, btrim(p_general_reason), v_actor, v_actor, clock_timestamp()
  );

  insert into public.payroll_workbook_changes (
    workbook_version_id,
    sheet_name,
    cell_reference,
    stable_key,
    employee_id,
    work_date,
    field_code,
    change_kind,
    previous_value,
    new_value,
    source_value_at_accept,
    consequence,
    reason,
    decided_by
  )
  select
    v_id,
    x ->> 'sheet',
    x ->> 'cell',
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
      then x ->> 'stableKey'
      else null
    end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
      then split_part(x ->> 'stableKey', '|', 1)::uuid
      else null
    end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
           and x ->> 'sheet' = 'MATRIZ_DIARIA_SABANA'
      then split_part(x ->> 'stableKey', '|', 2)::date
      else null
    end,
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL' then
      case when x ->> 'sheet' = 'MATRIZ_DIARIA_SABANA' then 'ATTENDANCE_STATUS_CODE'
      else case regexp_replace(x ->> 'cell', '[0-9]+$', '')
          when 'R' then 'HH50_ADJUSTMENT_MINUTES'
          when 'S' then 'HH50_ADJUSTMENT_REASON'
          when 'U' then 'HH100_ADJUSTMENT_MINUTES'
          when 'V' then 'HH100_ADJUSTMENT_REASON'
          when 'X' then 'BONUS_ADJUSTMENT_CLP'
          when 'Y' then 'BONUS_ADJUSTMENT_REASON'
        end
      end
    else null end,
    x ->> 'kind',
    x -> 'previous',
    x -> 'next',
    case when x ->> 'consequence' = 'AJUSTE_EMPRESARIAL'
      then x -> 'sourceValueAtComparison'
      else null
    end,
    x ->> 'consequence',
    btrim(p_general_reason),
    v_actor
  from jsonb_array_elements(p_changes) x;

  -- La elección explícita se conserva aunque el valor no cambie (KEEP_RRHH).
  -- `previous/new/source` usan la unidad estable del campo: ajuste para los
  -- agregados y código para la matriz; la versión anterior mantiene además la
  -- decisión original completa.
  insert into public.payroll_workbook_conflicts (
    company_id,
    reporting_period_id,
    stable_key,
    workera_value,
    rrhh_value,
    resolved_value,
    resolution,
    resolved_by,
    resolved_at,
    reason
  )
  select
    p_company_id,
    v_period,
    x ->> 'stableKey',
    x -> 'sourceValueAtComparison',
    x -> 'previous',
    x -> 'next',
    (x ->> 'conflictResolution'),
    v_actor,
    clock_timestamp(),
    btrim(x ->> 'conflictReason')
  from jsonb_array_elements(p_changes) x
  where x ? 'conflictResolution';

  return v_id;
end;
$$;

revoke all on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb
) from public, anon;
grant execute on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb
) to authenticated;

comment on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb
) is
  'Acepta hasta 500 diferencias de un XLSX privado ya subido. Ejecuta la '
  'allowlist R/S/U/V/X/Y y códigos diarios oficiales, deriva trabajador/fecha/campo en SQL y conserva el valor '
  'automático usado al decidir para detectar conflictos posteriores.';
