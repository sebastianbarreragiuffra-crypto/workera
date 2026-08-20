-- =============================================================================
-- Roster de empleados -- bootstrap administrativo (Excel) + reconciliación
-- operacional (Workera GET /employee), misma identidad canónica.
-- =============================================================================
--
-- Hallazgo real (auditoría previa): `public.employees` tenía 0 filas -- la
-- única vía de creación conectada era el sync de asistencia de Workera
-- (nunca ejecutado localmente), y solo bootstrapea a quien efectivamente
-- marca tarjeta. `bootstrapEmployeesFromRoster()` (roster COMPLETO vía
-- GET /employee) ya existía pero nunca estaba conectado a nada ejecutable.
-- No existe ningún importador de Excel de personal.
--
-- Esta migración NO crea un modelo de empleado paralelo -- reutiliza
-- `public.employees` tal cual, con dos columnas mínimas y justificadas:
--
--   `source`: distingue el origen de CADA fila (bootstrap administrativo por
--   Excel vs. roster operacional real de Workera) -- necesario para la
--   precedencia de fuentes (Workera es la fuente de mayor confianza para
--   identidad; Excel nunca debe sobrescribir un `external_workera_id` real
--   ni desactivar a un empleado que Workera sí confirma) y para saber qué
--   filas son candidatas a "promoción" cuando la misma persona aparece
--   después en el roster real de Workera (ver
--   `employee-roster-reconciliation.ts`).
--
--   `hire_date`: la planilla de personal trae "FECHA DE INGRESO" y no existe
--   ningún campo compatible hoy -- extensión mínima justificada por el
--   encargo (sección 9), no un modelo nuevo.
--
-- `employees.rut` YA EXISTÍA (con CHECK de formato chileno y UNIQUE parcial
-- -- ver migración de organización base) pero nunca se poblaba (decisión de
-- minimización de datos documentada en `employees-view.ts`, Fase 6A/Pre-8).
-- Esta migración no la cambia -- el encargo actual pide explícitamente usar
-- RUT como identidad de alta confianza para el bootstrap administrativo, así
-- que ahora SÍ se puebla para empleados de origen Excel. Esto es una
-- reversión deliberada y acotada de aquella decisión, solo para esta vía --
-- Workera (`GET /employee`) sigue sin exponer RUT a la capa de aplicación
-- (ver comentario en `employee-roster-reconciliation.ts` sobre el límite de
-- reconciliación real que esto impone).

alter table public.employees
  add column source text not null default 'workera' check (source in ('workera', 'excel_roster')),
  add column hire_date date;

comment on column public.employees.source is
  'Origen de la fila -- "excel_roster" (bootstrap administrativo, planilla de '
  'personal) o "workera" (roster real confirmado vía GET /employee, o creado '
  'por el sync de asistencia). Nunca cambia una vez que una fila pasa a '
  '"workera" (promoción, ver employee-roster-reconciliation.ts) -- Workera es '
  'siempre la fuente de mayor confianza para identidad.';

comment on column public.employees.hire_date is
  'Fecha de ingreso -- proviene de la planilla de personal ("FECHA DE '
  'INGRESO"). Extensión mínima justificada (sección 9 del encargo de roster '
  'bootstrap); no existe otra fuente hoy.';

create index employees_source_idx on public.employees (source);

-- -----------------------------------------------------------------------------
-- Aplicación atómica del roster confirmado (mismo criterio que
-- `apply_supplier_master_import`/`approve_medical_license`: un evento de
-- negocio discreto -- "confirmar este roster" -- debe ser todo-o-nada, no una
-- secuencia de escrituras separadas desde la app). La clasificación
-- NEW/UPDATED/REACTIVATED/SE_DESACTIVARAN ya viene resuelta desde TypeScript
-- (`personnel-roster-import.ts`) -- esta función solo ejecuta los INSERT/
-- UPDATE ya decididos, incluyendo la precedencia de fuentes: para un
-- empleado `source='workera'` ya existente, la app NUNCA envía
-- first_name/last_name/display_name en `p_update_rows` (identidad de mayor
-- confianza, Excel no la sobrescribe) -- solo grupo/fecha de ingreso, que
-- Workera no provee. SECURITY INVOKER (default): RLS de `employees`
-- (`is_privileged_admin()`) y `employee_birthdays` se sigue aplicando con el
-- rol real de quien llama.
create or replace function public.apply_personnel_roster_import(
  p_insert_rows jsonb,
  p_update_rows jsonb,
  p_deactivate_ids jsonb,
  p_actor_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  r jsonb;
  v_new_id uuid;
begin
  for r in select * from jsonb_array_elements(p_insert_rows)
  loop
    insert into public.employees (
      external_workera_id, rut, first_name, last_name, display_name,
      employee_group_id, hire_date, source, active
    ) values (
      'EXCEL-' || (r->>'rut'),
      r->>'rut',
      r->>'first_name',
      r->>'last_name',
      r->>'display_name',
      nullif(r->>'employee_group_id', '')::uuid,
      nullif(r->>'hire_date', '')::date,
      'excel_roster',
      true
    )
    returning id into v_new_id;

    if (r->>'birth_month') is not null and (r->>'birth_day') is not null then
      insert into public.employee_birthdays (employee_id, birth_month, birth_day, created_by)
      values (v_new_id, (r->>'birth_month')::smallint, (r->>'birth_day')::smallint, p_actor_id)
      on conflict (employee_id) do update set birth_month = excluded.birth_month, birth_day = excluded.birth_day;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(p_update_rows)
  loop
    update public.employees set
      first_name = case when r ? 'first_name' then r->>'first_name' else first_name end,
      last_name = case when r ? 'last_name' then r->>'last_name' else last_name end,
      display_name = case when r ? 'display_name' then r->>'display_name' else display_name end,
      employee_group_id = nullif(r->>'employee_group_id', '')::uuid,
      hire_date = nullif(r->>'hire_date', '')::date,
      active = true
    where id = (r->>'id')::uuid;

    if (r->>'birth_month') is not null and (r->>'birth_day') is not null then
      insert into public.employee_birthdays (employee_id, birth_month, birth_day, created_by)
      values ((r->>'id')::uuid, (r->>'birth_month')::smallint, (r->>'birth_day')::smallint, p_actor_id)
      on conflict (employee_id) do update set birth_month = excluded.birth_month, birth_day = excluded.birth_day;
    end if;
  end loop;

  -- Nunca desactiva un empleado `source='workera'` -- Excel es solo el bootstrap
  -- administrativo, nunca tiene autoridad para desactivar a alguien que Workera confirma.
  update public.employees
    set active = false
    where id in (select elem::uuid from jsonb_array_elements_text(p_deactivate_ids) as elem)
      and source = 'excel_roster';
end;
$$;

grant execute on function public.apply_personnel_roster_import(jsonb, jsonb, jsonb, uuid) to authenticated;
