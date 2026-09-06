-- Auditoría final de Asistencia: aislamiento tenant y temporalidad de horarios.
--
-- Antes de esta migración, work_schedules/work_schedule_rules eran catálogos
-- globales. Además, upsert_work_schedule reemplazaba las reglas del mismo id:
-- al recalcular una fecha histórica, una asignación ya confirmada podía recibir
-- retroactivamente la definición nueva. Desde aquí:
--
-- 1. cada definición y regla pertenece explícitamente a una empresa;
-- 2. schedule_assignments conserva la empresa derivada del trabajador;
-- 3. una definición que alguna vez fue asignada es inmutable;
-- 4. editar una definición usada crea una versión nueva, sin reasignar personas
--    en silencio. RR. HH. debe aplicar la versión desde una fecha explícita.

-- ---------------------------------------------------------------------------
-- Raíz tenant y metadatos de versionado

alter table public.work_schedules
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001',
  add column supersedes_schedule_id uuid,
  add column definition_version integer not null default 1,
  add column created_by uuid references public.profiles(id),
  add column retired_at timestamptz,
  add column retired_by uuid references public.profiles(id);

update public.work_schedules
set company_id = '0a4c0000-0000-0000-0000-000000000001'
where company_id is null;

-- Las filas inactivas preexistentes no tenían fecha de retiro. Se conserva la
-- verdad conocida (inactiva) sin inventar un actor histórico.
update public.work_schedules
set retired_at = coalesce(retired_at, created_at)
where not active and retired_at is null;

alter table public.work_schedules
  alter column company_id set not null,
  add constraint work_schedules_company_id_id_key unique (company_id, id),
  add constraint work_schedules_definition_version_chk check (definition_version >= 1),
  add constraint work_schedules_retirement_chk check (
    (active and retired_at is null and retired_by is null)
    or (not active and retired_at is not null)
  ),
  add constraint work_schedules_company_supersedes_fkey
    foreign key (company_id, supersedes_schedule_id)
    references public.work_schedules(company_id, id);

create index work_schedules_company_active_idx
  on public.work_schedules(company_id, active, name);

alter table public.work_schedule_rules
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';

update public.work_schedule_rules r
set company_id = s.company_id
from public.work_schedules s
where s.id = r.work_schedule_id;

alter table public.work_schedule_rules
  alter column company_id set not null,
  drop constraint work_schedule_rules_work_schedule_id_fkey,
  add constraint work_schedule_rules_company_schedule_fkey
    foreign key (company_id, work_schedule_id)
    references public.work_schedules(company_id, id) on delete cascade;

create index work_schedule_rules_company_schedule_idx
  on public.work_schedule_rules(company_id, work_schedule_id);

alter table public.schedule_assignments
  add column company_id uuid references public.companies(id)
    default '0a4c0000-0000-0000-0000-000000000001';

update public.schedule_assignments a
set company_id = e.company_id
from public.employees e
where e.id = a.employee_id;

-- Si la base ya contenía asignaciones de más de una empresa contra el antiguo
-- catálogo global, no se puede simplemente agregar la FK compuesta: eso
-- rompería la migración o mantendría una referencia cruzada. Se clona una vez
-- la definición completa por empresa y se repuntan solo esas asignaciones. El
-- id viejo y sus reglas quedan intactos para ARCOTEX y para toda historia que
-- ya los usaba dentro de su tenant.
create temporary table schedule_tenant_clone_map as
select
  x.company_id,
  x.old_schedule_id,
  gen_random_uuid() as new_schedule_id
from (
  select distinct a.company_id, a.work_schedule_id as old_schedule_id
  from public.schedule_assignments a
  join public.work_schedules s on s.id = a.work_schedule_id
  where a.company_id <> s.company_id
) x;

insert into public.work_schedules (
  id, company_id, name, active, created_at, definition_version, retired_at
)
select
  m.new_schedule_id,
  m.company_id,
  s.name,
  s.active,
  s.created_at,
  s.definition_version,
  s.retired_at
from schedule_tenant_clone_map m
join public.work_schedules s on s.id = m.old_schedule_id;

insert into public.work_schedule_rules (
  company_id, work_schedule_id, day_of_week, scheduled_start, scheduled_end, created_at
)
select
  m.company_id,
  m.new_schedule_id,
  r.day_of_week,
  r.scheduled_start,
  r.scheduled_end,
  r.created_at
from schedule_tenant_clone_map m
join public.work_schedule_rules r on r.work_schedule_id = m.old_schedule_id;

update public.schedule_assignments a
set work_schedule_id = m.new_schedule_id
from schedule_tenant_clone_map m
where a.company_id = m.company_id
  and a.work_schedule_id = m.old_schedule_id;

drop table schedule_tenant_clone_map;

alter table public.schedule_assignments
  alter column company_id set not null,
  drop constraint schedule_assignments_work_schedule_id_fkey,
  add constraint schedule_assignments_company_schedule_fkey
    foreign key (company_id, work_schedule_id)
    references public.work_schedules(company_id, id);

create index schedule_assignments_company_employee_date_idx
  on public.schedule_assignments(company_id, employee_id, effective_from, effective_to);

comment on column public.work_schedules.company_id is
  'Empresa dueña de la definición. Una jornada nunca es un catálogo global.';
comment on column public.work_schedules.supersedes_schedule_id is
  'Versión anterior inmutable de esta definición, siempre dentro de la misma empresa.';
comment on column public.work_schedules.definition_version is
  'Versión monotónica de la definición; una edición de un horario usado crea otro id.';
comment on column public.work_schedule_rules.company_id is
  'Empresa derivada de work_schedules y protegida por FK compuesta.';
comment on column public.schedule_assignments.company_id is
  'Empresa derivada del trabajador y obligada a coincidir con la definición asignada.';

-- ---------------------------------------------------------------------------
-- Derivación server-side y protección contra cambios retrospectivos

create or replace function public.stamp_work_schedule_rule_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select s.company_id into v_company_id
  from public.work_schedules s
  where s.id = new.work_schedule_id;

  if v_company_id is null then
    raise exception 'La definición de horario indicada no existe.' using errcode = '23503';
  end if;

  new.company_id := v_company_id;
  return new;
end;
$$;

revoke all on function public.stamp_work_schedule_rule_company() from public, anon, authenticated;

create trigger work_schedule_rules_10_stamp_company
  before insert or update on public.work_schedule_rules
  for each row execute function public.stamp_work_schedule_rule_company();

create or replace function public.stamp_schedule_assignment_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_company_id uuid;
  v_schedule_company_id uuid;
  v_schedule_active boolean;
begin
  select e.company_id into v_employee_company_id
  from public.employees e
  where e.id = new.employee_id;

  select s.company_id, s.active
    into v_schedule_company_id, v_schedule_active
  from public.work_schedules s
  where s.id = new.work_schedule_id;

  if v_employee_company_id is null or v_schedule_company_id is null then
    raise exception 'El trabajador o el horario indicado no existe.' using errcode = '23503';
  end if;
  if v_employee_company_id <> v_schedule_company_id then
    raise exception 'El horario y el trabajador pertenecen a empresas diferentes.' using errcode = '23514';
  end if;
  if not v_schedule_active then
    if tg_op = 'INSERT' then
      raise exception 'No se puede crear una asignación con una versión de horario retirada.' using errcode = '23514';
    end if;
    if new.work_schedule_id is distinct from old.work_schedule_id then
      raise exception 'No se puede crear una asignación con una versión de horario retirada.' using errcode = '23514';
    end if;
  end if;

  new.company_id := v_employee_company_id;
  return new;
end;
$$;

revoke all on function public.stamp_schedule_assignment_company() from public, anon, authenticated;

create trigger schedule_assignments_10_stamp_company
  before insert or update on public.schedule_assignments
  for each row execute function public.stamp_schedule_assignment_company();

create or replace function public.protect_assigned_schedule_definition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_schedule_id uuid;
  v_new_schedule_id uuid;
begin
  if tg_table_name = 'work_schedule_rules' then
    if tg_op <> 'INSERT' then
      v_old_schedule_id := old.work_schedule_id;
    end if;
    if tg_op <> 'DELETE' then
      v_new_schedule_id := new.work_schedule_id;
    end if;

    if exists (
      select 1 from public.schedule_assignments a
      where a.work_schedule_id in (v_old_schedule_id, v_new_schedule_id)
    ) then
      raise exception
        'Las reglas de un horario asignado son inmutables; crea una versión nueva.'
        using errcode = '55000';
    end if;

    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if exists (
    select 1 from public.schedule_assignments a
    where a.work_schedule_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception
        'Una definición de horario con historial no se puede borrar.'
        using errcode = '55000';
    end if;

    if new.id is distinct from old.id
       or new.company_id is distinct from old.company_id
       or new.name is distinct from old.name
       or new.supersedes_schedule_id is distinct from old.supersedes_schedule_id
       or new.definition_version is distinct from old.definition_version
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception
        'Una definición de horario con historial es inmutable; crea una versión nueva.'
        using errcode = '55000';
    end if;

    if new.active is not distinct from old.active then
      if new.retired_at is distinct from old.retired_at
         or new.retired_by is distinct from old.retired_by then
        raise exception
          'La auditoría de retiro de una definición usada es inmutable.'
          using errcode = '55000';
      end if;
    elsif old.active and not new.active then
      new.retired_at := coalesce(new.retired_at, clock_timestamp());
      new.retired_by := coalesce(new.retired_by, auth.uid());
    else
      raise exception
        'Una versión de horario retirada y con historial no se puede reactivar.'
        using errcode = '55000';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_assigned_schedule_definition() from public, anon, authenticated;

create trigger work_schedules_20_protect_assigned
  before update or delete on public.work_schedules
  for each row execute function public.protect_assigned_schedule_definition();

create trigger work_schedule_rules_20_protect_assigned
  before insert or update or delete on public.work_schedule_rules
  for each row execute function public.protect_assigned_schedule_definition();

-- ---------------------------------------------------------------------------
-- RLS tenant-aware. SUPER_ADMIN conserva lectura técnica solo si es miembro
-- activo; la autoridad empresarial de escritura sigue siendo ADMIN_RRHH.

drop policy if exists work_schedules_select on public.work_schedules;
create policy work_schedules_select on public.work_schedules
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.read')
  );

drop policy if exists work_schedules_write_admin on public.work_schedules;

drop policy if exists work_schedule_rules_select on public.work_schedule_rules;
create policy work_schedule_rules_select on public.work_schedule_rules
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.read')
  );

drop policy if exists work_schedule_rules_write_admin on public.work_schedule_rules;

drop policy if exists schedule_assignments_select on public.schedule_assignments;
create policy schedule_assignments_select on public.schedule_assignments
  for select to authenticated using (
    public.has_company_permission(company_id, 'attendance.read')
    and public.employee_belongs_to_active_company(employee_id)
  );

drop policy if exists schedule_assignments_write_admin on public.schedule_assignments;

-- Ni siquiera ADMIN_RRHH puede mutar directamente definiciones, reglas o
-- asignaciones y saltarse MFA, actor, validación o versionado. Las únicas
-- escrituras de sesión pasan por los RPC SECURITY DEFINER auditados más abajo.
-- Las migraciones escriben como owner; authenticated y service_role deben
-- pasar por los RPC que conservan tenant, MFA, versión y cierre.
revoke insert, update, delete on public.work_schedules from authenticated, service_role;
revoke insert, update, delete on public.work_schedule_rules from authenticated, service_role;
revoke insert, update, delete on public.schedule_assignments from authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Definición versionada. El company_id es explícito: nunca se deduce de una
-- membresía arbitraria cuando un usuario pertenece a más de una empresa.

drop function public.upsert_work_schedule(uuid, text, jsonb);

create function public.upsert_work_schedule(
  p_company_id uuid,
  p_schedule_id uuid,
  p_name text,
  p_rules jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_schedule_id uuid;
  v_existing record;
  r jsonb;
begin
  if v_actor is null
     or p_company_id is null
     or not public.has_company_app_role(p_company_id, 'ADMIN_RRHH') then
    raise exception 'Solo RR. HH. de la empresa puede crear o versionar horarios.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    raise exception 'El nombre del horario debe tener entre 1 y 200 caracteres.' using errcode = '22023';
  end if;
  if p_rules is null
     or jsonb_typeof(p_rules) <> 'array'
     or jsonb_array_length(p_rules) > 7 then
    raise exception 'Las reglas del horario deben ser un arreglo de hasta siete días.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rules) x
    where jsonb_typeof(x) <> 'object'
       or coalesce(x ->> 'day_of_week', '') !~ '^[0-6]$'
       or ((nullif(x ->> 'scheduled_start', '') is null)
           <> (nullif(x ->> 'scheduled_end', '') is null))
       or (
         nullif(x ->> 'scheduled_start', '') is not null
         and (
           x ->> 'scheduled_start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
           or x ->> 'scheduled_end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
         )
       )
  ) or (
    select count(*) <> count(distinct x ->> 'day_of_week')
    from jsonb_array_elements(p_rules) x
  ) then
    raise exception 'Cada día debe ser único y contener un tramo horario válido o quedar libre.' using errcode = '22023';
  end if;

  if p_schedule_id is null then
    insert into public.work_schedules (company_id, name, created_by)
    values (p_company_id, btrim(p_name), v_actor)
    returning id into v_schedule_id;
  else
    select s.id, s.company_id, s.active, s.definition_version
      into v_existing
    from public.work_schedules s
    where s.id = p_schedule_id
      and s.company_id = p_company_id
    for update;

    if not found then
      raise exception 'El horario indicado no existe en esta empresa.' using errcode = '23503';
    end if;
    if not v_existing.active then
      raise exception 'La versión indicada ya fue retirada.' using errcode = '55000';
    end if;

    if exists (
      select 1 from public.schedule_assignments a
      where a.company_id = p_company_id
        and a.work_schedule_id = p_schedule_id
    ) then
      -- Nunca se cambian las reglas detrás de una asignación confirmada. La
      -- versión nueva queda sin asignar hasta que RR. HH. elija fecha/personas.
      update public.work_schedules
      set active = false,
          retired_at = clock_timestamp(),
          retired_by = v_actor
      where id = p_schedule_id;

      insert into public.work_schedules (
        company_id, name, supersedes_schedule_id, definition_version, created_by
      ) values (
        p_company_id, btrim(p_name), p_schedule_id,
        v_existing.definition_version + 1, v_actor
      ) returning id into v_schedule_id;
    else
      -- Sin asignaciones no existe historia que preservar: se puede corregir
      -- la definición todavía no usada sin generar ruido de versiones.
      update public.work_schedules
      set name = btrim(p_name)
      where id = p_schedule_id
      returning id into v_schedule_id;

      delete from public.work_schedule_rules
      where company_id = p_company_id and work_schedule_id = v_schedule_id;
    end if;
  end if;

  for r in select value from jsonb_array_elements(p_rules)
  loop
    insert into public.work_schedule_rules (
      company_id, work_schedule_id, day_of_week, scheduled_start, scheduled_end
    ) values (
      p_company_id,
      v_schedule_id,
      (r->>'day_of_week')::smallint,
      nullif(r->>'scheduled_start', '')::time,
      nullif(r->>'scheduled_end', '')::time
    );
  end loop;

  return v_schedule_id;
end;
$$;

comment on function public.upsert_work_schedule(uuid, uuid, text, jsonb) is
  'Crea una definición tenant-aware. Si el horario ya fue asignado, preserva '
  'la versión anterior y devuelve un id nuevo que RR. HH. debe asignar desde '
  'una fecha explícita; nunca cambia horarios históricos en silencio.';

-- Compatibilidad del cliente laboral legacy: la firma histórica queda atada
-- explícitamente al UUID sentinel de ARCOTEX. No vuelve a inferir una empresa
-- desde una membresía arbitraria ni habilita catálogos globales.
create function public.upsert_work_schedule(
  p_schedule_id uuid,
  p_name text,
  p_rules jsonb
)
returns uuid
language sql
set search_path = ''
as $$
  select public.upsert_work_schedule(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    p_schedule_id,
    p_name,
    p_rules
  );
$$;

comment on function public.upsert_work_schedule(uuid, text, jsonb) is
  'Wrapper compatible del workspace laboral ARCOTEX. La firma tenant-aware '
  'uuid,uuid,text,jsonb es obligatoria para cualquier otra empresa.';

-- Frontera común para configuraciones con vigencia. El mismo advisory que
-- aceptación/aprobación/cierre elimina la carrera validar-OPEN -> cerrar ->
-- escribir. Un rango abierto se representa con p_effective_to NULL.
create or replace function private.assert_arcotex_payroll_range_mutable(
  p_company_id uuid,
  p_effective_from date,
  p_effective_to date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from) then
    raise exception 'El rango de vigencia no es válido.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if p_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
     and exists (
       select 1
       from public.reporting_periods rp
       where rp.status = 'CLOSED'
         and pg_catalog.daterange(rp.period_start, rp.period_end, '[]')
           && pg_catalog.daterange(p_effective_from, p_effective_to, '[]')
     ) then
    raise exception 'Reabre el período antes de cambiar una vigencia que lo afecta.'
      using errcode = '55000';
  end if;
end;
$$;

revoke all on function private.assert_arcotex_payroll_range_mutable(uuid, date, date)
  from public, anon, authenticated, service_role;

-- Asignación explícita: valida empresa y solo admite una definición activa.
create or replace function public.apply_schedule_assignment(
  p_employee_id uuid,
  p_work_schedule_id uuid,
  p_effective_from date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_current record;
  v_employee_company_id uuid;
  v_schedule_company_id uuid;
  v_schedule_active boolean;
  v_had_current boolean := false;
  v_reason constant text := 'Horario efectivo confirmado por RR. HH. desde Configuración > Horarios.';
begin
  if v_actor is null then
    raise exception 'Solo RR. HH. puede confirmar o cambiar horarios.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if p_effective_from is null then
    raise exception 'La fecha de vigencia es obligatoria.' using errcode = '22023';
  end if;

  select e.company_id into v_employee_company_id
  from public.employees e
  where e.id = p_employee_id;

  select s.company_id, s.active
    into v_schedule_company_id, v_schedule_active
  from public.work_schedules s
  where s.id = p_work_schedule_id;

  if v_employee_company_id is null or v_schedule_company_id is null then
    raise exception 'El trabajador o el horario indicado no existe.' using errcode = '23503';
  end if;
  if v_employee_company_id <> v_schedule_company_id
     or not public.has_company_app_role(v_employee_company_id, 'ADMIN_RRHH') then
    raise exception 'El horario no pertenece a la empresa del trabajador.' using errcode = '42501';
  end if;
  if not v_schedule_active then
    raise exception 'Asigna la versión activa del horario, no una versión retirada.' using errcode = '55000';
  end if;

  -- Orden común de concurrencia: global de pre-nómina antes de cualquier
  -- bloqueo de fila de la asignación.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select id, work_schedule_id, effective_from, effective_to, rrhh_confirmed_at
    into v_current
  from public.schedule_assignments
  where employee_id = p_employee_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to >= p_effective_from)
  order by effective_from desc
  limit 1
  for update;
  v_had_current := found;

  if v_had_current and v_current.work_schedule_id = p_work_schedule_id then
    -- Una confirmación existente es inmutable/idempotente: nunca se reemplaza
    -- su actor o fecha al reaplicar el formulario.
    if v_current.rrhh_confirmed_at is not null then
      return;
    end if;

    perform private.assert_arcotex_payroll_range_mutable(
      v_employee_company_id,
      p_effective_from,
      v_current.effective_to
    );

    if v_current.effective_from = p_effective_from then
      update public.schedule_assignments
      set rrhh_confirmed_by = v_actor,
          rrhh_confirmed_at = clock_timestamp(),
          confirmation_reason = v_reason
      where id = v_current.id;
      return;
    end if;

    -- Confirmar desde una fecha intermedia no puede aprobar retroactivamente
    -- toda la fila. Se conserva el tramo anterior sin confirmación y se abre
    -- otro, con la misma definición, exactamente desde p_effective_from.
    update public.schedule_assignments
    set effective_to = p_effective_from - 1
    where id = v_current.id;

    insert into public.schedule_assignments (
      company_id, employee_id, work_schedule_id, effective_from, effective_to,
      rrhh_confirmed_by, rrhh_confirmed_at, confirmation_reason
    ) values (
      v_employee_company_id, p_employee_id, p_work_schedule_id,
      p_effective_from, v_current.effective_to,
      v_actor, clock_timestamp(), v_reason
    );
    return;
  end if;

  perform private.assert_arcotex_payroll_range_mutable(
    v_employee_company_id,
    p_effective_from,
    case when v_had_current then v_current.effective_to else null end
  );

  if v_had_current and v_current.effective_from = p_effective_from then
    update public.schedule_assignments
    set work_schedule_id = p_work_schedule_id,
        rrhh_confirmed_by = v_actor,
        rrhh_confirmed_at = clock_timestamp(),
        confirmation_reason = v_reason
    where id = v_current.id;
    return;
  end if;

  if v_had_current then
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
    company_id,
    employee_id,
    work_schedule_id,
    effective_from,
    effective_to,
    rrhh_confirmed_by,
    rrhh_confirmed_at,
    confirmation_reason
  ) values (
    v_employee_company_id,
    p_employee_id,
    p_work_schedule_id,
    p_effective_from,
    case when v_had_current then v_current.effective_to else null end,
    v_actor,
    clock_timestamp(),
    v_reason
  );
end;
$$;

comment on function public.apply_schedule_assignment(uuid, uuid, date) is
  'Asigna y confirma una versión activa de horario dentro de la misma empresa. '
  'Solo ADMIN_RRHH con MFA; conserva actor, fecha y motivo.';

-- La acción masiva se limita a la empresa dueña del horario. Ya no recorre
-- empleados de otras membresías activas del mismo usuario.
create or replace function public.assign_schedule_to_unassigned(
  p_work_schedule_id uuid,
  p_effective_from date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_company_id uuid;
  v_schedule_active boolean;
  v_count integer := 0;
  e record;
begin
  if v_actor is null then
    raise exception 'Solo RR. HH. puede asignar horarios.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if p_effective_from is null then
    raise exception 'La fecha de vigencia es obligatoria.' using errcode = '22023';
  end if;

  select s.company_id, s.active into v_company_id, v_schedule_active
  from public.work_schedules s
  where s.id = p_work_schedule_id;

  if v_company_id is null
     or not v_schedule_active
     or not public.has_company_app_role(v_company_id, 'ADMIN_RRHH') then
    raise exception 'El horario activo no pertenece a una empresa autorizada.' using errcode = '42501';
  end if;

  for e in
    select emp.id
    from public.employees emp
    where emp.company_id = v_company_id
      and emp.active
      and not exists (
        select 1 from public.schedule_assignments sa
        where sa.company_id = v_company_id
          and sa.employee_id = emp.id
          and sa.effective_from <= p_effective_from
          and (sa.effective_to is null or sa.effective_to >= p_effective_from)
      )
      and not exists (
        select 1 from public.employee_time_control_policies tcp
        where tcp.employee_id = emp.id
          and tcp.policy_code = 'EXEMPT_FROM_TIME_CONTROL'
          and tcp.effective_from <= p_effective_from
          and (tcp.effective_to is null or tcp.effective_to >= p_effective_from)
      )
  loop
    perform public.apply_schedule_assignment(e.id, p_work_schedule_id, p_effective_from);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.upsert_work_schedule(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.upsert_work_schedule(uuid, uuid, text, jsonb) to authenticated;

revoke all on function public.upsert_work_schedule(uuid, text, jsonb) from public, anon;
grant execute on function public.upsert_work_schedule(uuid, text, jsonb) to authenticated;

revoke all on function public.apply_schedule_assignment(uuid, uuid, date) from public, anon;
grant execute on function public.apply_schedule_assignment(uuid, uuid, date) to authenticated;

revoke all on function public.assign_schedule_to_unassigned(uuid, date) from public, anon;
grant execute on function public.assign_schedule_to_unassigned(uuid, date) to authenticated;
