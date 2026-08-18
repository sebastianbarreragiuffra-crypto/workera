-- Fase 5D — 2/2: SUPER_ADMIN — helpers semánticos, RLS actualizada en todas
-- las tablas afectadas, protección del último SUPER_ADMIN.
--
-- Principio de seguridad no negociable (encargo Fase 5D, PASO 4): SUPER_ADMIN
-- es control total SOBRE LA APLICACIÓN, no permiso para destruir
-- trazabilidad. Esta migración NO agrega ningún privilegio de escritura
-- sobre:
--   - attendance_records (hecho crudo de Workera — cero policies de
--     escritura para `authenticated`, sin excepción, ya desde Fase 3).
--   - audit_log (solo INSERT propio ya existente; el trigger
--     enforce_immutable_columns() ya bloquea UPDATE, y nunca hubo GRANT de
--     DELETE — ninguno de los dos se toca aquí).
-- Las correcciones de marcaciones siguen pasando exclusivamente por
-- attendance_corrections (original/corrección/motivo/actor/timestamp ya
-- preservados desde Gate D).

-- =============================================================================
-- 1. HELPERS SEMÁNTICOS
-- =============================================================================
-- is_super_admin(): chequeo de identidad exacta (¿es SUPER_ADMIN?).
-- is_admin_rrhh(): sin cambios, sigue siendo chequeo de identidad exacta
--   (¿es ADMIN_RRHH?) — nunca debe devolver true para un SUPER_ADMIN, sería
--   engañoso (un SUPER_ADMIN no es RRHH).
-- is_privileged_admin(): el "gate" administrativo real — true para
--   SUPER_ADMIN O ADMIN_RRHH. Reemplaza is_admin_rrhh() en toda policy que
--   representa "acceso administrativo amplio", para no duplicar la lógica
--   `is_super_admin() or is_admin_rrhh()` en cada policy individualmente.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_role() = 'SUPER_ADMIN';
$$;

comment on function public.is_super_admin() is
  'true si el usuario actual tiene exactamente el rol SUPER_ADMIN. Chequeo '
  'de identidad — no usar como gate administrativo genérico, para eso está '
  'is_privileged_admin().';

create or replace function public.is_privileged_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_super_admin() or public.is_admin_rrhh();
$$;

comment on function public.is_privileged_admin() is
  'Gate administrativo real: true para SUPER_ADMIN o ADMIN_RRHH. Reemplaza '
  'is_admin_rrhh() en toda policy RLS que antes representaba "acceso '
  'administrativo amplio" (Fase 5D) — SUPER_ADMIN hereda todo lo que ya '
  'tenía ADMIN_RRHH en esas tablas, sin duplicar la condición OR en cada '
  'policy. NUNCA se usa para las tablas que deben permanecer fuera del '
  'alcance de cualquier rol de aplicación (attendance_records crudo, '
  'audit_log UPDATE/DELETE).';

grant execute on function public.is_super_admin(), public.is_privileged_admin() to authenticated;
revoke all on function public.is_super_admin(), public.is_privileged_admin() from anon, public;

-- can_manage_employee(): se redefine para componer sobre is_privileged_admin()
-- en vez de is_admin_rrhh() directamente — mismo comportamiento para
-- ADMIN_RRHH (sigue teniendo autorización universal), y ahora también para
-- SUPER_ADMIN, sin repetir la condición OR.
create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_privileged_admin()
    or exists (
      select 1
      from public.employees e
      join public.employee_groups eg on eg.id = e.employee_group_id
      where e.id = p_employee_id
        and (
          (eg.code = 'PRODUCTION' and public.is_supervisor_production())
          or (eg.code = 'INSTALLATION' and public.is_supervisor_installation())
        )
    );
$$;

comment on function public.can_manage_employee(uuid) is
  'true si el usuario actual puede escribir (decisiones/correcciones/novedades) '
  'sobre este trabajador: SUPER_ADMIN o ADMIN_RRHH siempre (vía '
  'is_privileged_admin()), o el supervisor cuyo grupo coincide con el '
  'employee_group ACTUAL del trabajador. Actualizado en Fase 5D — mismo '
  'comportamiento previo para ADMIN_RRHH, ahora también compone SUPER_ADMIN.';

-- =============================================================================
-- 2. CATÁLOGOS Y TABLAS DE POLÍTICA (Fase 3, 20260817152249)
-- =============================================================================
drop policy work_schedules_write_admin on public.work_schedules;
create policy work_schedules_write_admin on public.work_schedules
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy work_schedule_rules_write_admin on public.work_schedule_rules;
create policy work_schedule_rules_write_admin on public.work_schedule_rules
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy overtime_policies_write_admin on public.overtime_policies;
create policy overtime_policies_write_admin on public.overtime_policies
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy late_arrival_policies_write_admin on public.late_arrival_policies;
create policy late_arrival_policies_write_admin on public.late_arrival_policies
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy bonus_policies_write_admin on public.bonus_policies;
create policy bonus_policies_write_admin on public.bonus_policies
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

-- =============================================================================
-- 3. EMPLOYEES Y ORGANIZACIÓN (Fase 3, 20260817152327)
-- =============================================================================
drop policy employees_write_admin on public.employees;
create policy employees_write_admin on public.employees
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy employee_group_assignments_write_admin on public.employee_group_assignments;
create policy employee_group_assignments_write_admin on public.employee_group_assignments
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy schedule_assignments_write_admin on public.schedule_assignments;
create policy schedule_assignments_write_admin on public.schedule_assignments
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

drop policy supervisor_assignments_write_admin on public.supervisor_assignments;
create policy supervisor_assignments_write_admin on public.supervisor_assignments
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

-- =============================================================================
-- 4. ASISTENCIA — attendance_records permanece SIN NINGUNA policy de
--    escritura (no se toca). attendance_corrections/attendance_status_records/
--    sync_runs sí actualizan su gate administrativo (Fase 3, 20260817152357).
-- =============================================================================
drop policy attendance_corrections_update_admin on public.attendance_corrections;
create policy attendance_corrections_update_admin on public.attendance_corrections
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

drop policy attendance_status_records_insert on public.attendance_status_records;
create policy attendance_status_records_insert on public.attendance_status_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_privileged_admin()
    end
  );

drop policy attendance_status_records_update_admin on public.attendance_status_records;
create policy attendance_status_records_update_admin on public.attendance_status_records
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

drop policy sync_runs_select_admin on public.sync_runs;
create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated using (public.is_privileged_admin());

-- =============================================================================
-- 5. HORAS EXTRA Y ATRASOS (Fase 3, 20260817152434)
-- =============================================================================
-- overtime_records/late_arrival_records siguen sin ninguna policy de
-- escritura (candidato calculado por el sistema — no se toca).
drop policy overtime_decisions_update_admin on public.overtime_decisions;
create policy overtime_decisions_update_admin on public.overtime_decisions
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

drop policy late_arrival_decisions_update_admin on public.late_arrival_decisions;
create policy late_arrival_decisions_update_admin on public.late_arrival_decisions
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

-- =============================================================================
-- 6. AUSENCIAS Y BONO (Fase 3, 20260817152510)
-- =============================================================================
drop policy absence_records_insert on public.absence_records;
create policy absence_records_insert on public.absence_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid() and public.can_manage_employee(employee_id)
      else
        public.is_privileged_admin()
    end
  );

drop policy absence_records_update_admin on public.absence_records;
create policy absence_records_update_admin on public.absence_records
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

drop policy absence_decisions_update_admin on public.absence_decisions;
create policy absence_decisions_update_admin on public.absence_decisions
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

-- employee_daily_bonuses: SIGUE sin ninguna policy de INSERT/UPDATE/DELETE
-- para `authenticated` (ni siquiera SUPER_ADMIN) — la creación de bonos es
-- exclusiva del trigger interno SECURITY DEFINER (Gate D), nunca de un
-- cliente. Solo el SELECT amplía su gate.
drop policy employee_daily_bonuses_select_admin on public.employee_daily_bonuses;
create policy employee_daily_bonuses_select_admin on public.employee_daily_bonuses
  for select to authenticated using (public.is_privileged_admin());

-- =============================================================================
-- 7. REVISIÓN, PERÍODOS, EXPORTS, DOCUMENTOS, AUDITORÍA (Fase 3, 20260817152542)
-- =============================================================================
drop policy weekly_reviews_update on public.weekly_reviews;
create policy weekly_reviews_update on public.weekly_reviews
  for update to authenticated
  using (
    public.is_privileged_admin()
    or (public.is_corporate_user() and status not in ('CLOSED', 'REOPENED'))
  )
  with check (
    (
      public.is_privileged_admin()
      and (status <> 'CLOSED' or closed_by = auth.uid())
      and (status <> 'REOPENED' or reopened_by = auth.uid())
    )
    or (
      public.is_corporate_user()
      and not public.is_privileged_admin()
      and status not in ('CLOSED', 'REOPENED')
    )
  );

drop policy weekly_review_snapshots_insert_admin on public.weekly_review_snapshots;
create policy weekly_review_snapshots_insert_admin on public.weekly_review_snapshots
  for insert to authenticated
  with check (public.is_privileged_admin() and generated_by = auth.uid());

drop policy reporting_periods_insert_admin on public.reporting_periods;
create policy reporting_periods_insert_admin on public.reporting_periods
  for insert to authenticated
  with check (public.is_privileged_admin());

drop policy reporting_periods_update_admin on public.reporting_periods;
create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (public.is_privileged_admin())
  with check (
    public.is_privileged_admin()
    and (status <> 'CLOSED' or closed_by = auth.uid())
    and (status <> 'REOPENED' or reopened_by = auth.uid())
  );

drop policy period_snapshots_insert_admin on public.period_snapshots;
create policy period_snapshots_insert_admin on public.period_snapshots
  for insert to authenticated
  with check (public.is_privileged_admin() and generated_by = auth.uid());

drop policy excel_exports_admin_only on public.excel_exports;
create policy excel_exports_admin_only on public.excel_exports
  for all to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin() and generated_by = auth.uid());

drop policy supporting_documents_select_admin on public.supporting_documents;
create policy supporting_documents_select_admin on public.supporting_documents
  for select to authenticated using (public.is_privileged_admin());

drop policy supporting_documents_update_admin on public.supporting_documents;
create policy supporting_documents_update_admin on public.supporting_documents
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

-- Vista de metadata (security_invoker = false, mismo mecanismo de Fase 3):
-- se recrea con el mismo WHERE, sustituyendo is_admin_rrhh() por
-- is_privileged_admin().
drop view public.supporting_documents_metadata;
create view public.supporting_documents_metadata
with (security_invoker = false)
as
select
  id,
  employee_id,
  absence_record_id,
  late_arrival_decision_id,
  attendance_status_record_id,
  document_type,
  original_filename,
  mime_type,
  uploaded_by,
  uploaded_at,
  created_at
from public.supporting_documents
where
  public.is_privileged_admin()
  or uploaded_by = auth.uid()
  or public.can_manage_employee(employee_id);

comment on view public.supporting_documents_metadata is
  'Metadata de documentos SIN storage_path. Vía de lectura para supervisores '
  '(no tienen SELECT sobre la tabla base). SUPER_ADMIN/ADMIN_RRHH siguen '
  'viendo el contenido/puntero real (storage_path) únicamente a través de la '
  'tabla base (Fase 5D: is_privileged_admin() reemplaza is_admin_rrhh()).';

grant select on public.supporting_documents_metadata to authenticated;
revoke all on public.supporting_documents_metadata from anon, public;

-- audit_log: SOLO el SELECT amplía su gate. INSERT (propio, actor_id =
-- auth.uid()) no cambia. NO se agrega ningún UPDATE/DELETE — el trigger
-- enforce_immutable_columns() ya bloquea UPDATE (creado en Fase 3) y nunca
-- hubo GRANT de DELETE (grants_lockdown, Fase 3) — ninguno de los dos se
-- toca aquí, ni siquiera para SUPER_ADMIN (PASO 4/14 del encargo).
drop policy audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin on public.audit_log
  for select to authenticated using (public.is_privileged_admin());

-- =============================================================================
-- 8. profiles — gestión de usuarios (Fase 3, 20260817152004)
-- =============================================================================
-- select: cualquiera ve su propio perfil; SUPER_ADMIN/ADMIN_RRHH ven todos
-- (gestión de cuentas) — sin cambio de alcance salvo el nuevo rol.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_privileged_admin());

-- update: la única policy con lógica GENUINAMENTE distinta entre
-- SUPER_ADMIN y ADMIN_RRHH (PASO 6 del encargo — "ADMIN_RRHH NO puede
-- convertirse en SUPER_ADMIN, asignar SUPER_ADMIN, ni modificar la cuenta
-- SUPER_ADMIN"):
--   - SUPER_ADMIN: sin restricción (USING/CHECK true) — puede crear/cambiar
--     cualquier rol, incluido asignar/quitar SUPER_ADMIN, y
--     activar/desactivar cualquier cuenta.
--   - ADMIN_RRHH: puede targetear (USING) cualquier fila EXCEPTO una cuyo
--     rol ACTUAL ya sea SUPER_ADMIN (no puede ni empezar a tocar esa fila),
--     y el resultado (WITH CHECK) nunca puede quedar con role = SUPER_ADMIN
--     (no puede promover a nadie a SUPER_ADMIN). Esto bloquea
--     estructuralmente las 3 rutas de escalamiento del PASO 11: RRHH no
--     puede auto-promoverse, no puede promover a un tercero, y no puede
--     tocar la fila del SUPER_ADMIN existente para degradarlo/desactivarlo.
drop policy profiles_update_admin_only on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    public.is_super_admin()
    or (public.is_admin_rrhh() and role is distinct from 'SUPER_ADMIN'::public.app_role)
  )
  with check (
    public.is_super_admin()
    or (
      public.is_admin_rrhh()
      and role is distinct from 'SUPER_ADMIN'::public.app_role
    )
  );

comment on policy profiles_update on public.profiles is
  'SUPER_ADMIN: sin restricción. ADMIN_RRHH: puede administrar cualquier '
  'perfil EXCEPTO uno cuyo rol actual o nuevo sea SUPER_ADMIN — no puede '
  'tocar la cuenta SUPER_ADMIN existente ni promover a nadie a ese rol '
  '(Fase 5D, PASO 6/11 del encargo).';

-- =============================================================================
-- 9. PROTECCIÓN DEL ÚLTIMO SUPER_ADMIN (PASO 12 del encargo)
-- =============================================================================
-- No es expresable con RLS (la policy de arriba ya permite a un SUPER_ADMIN
-- degradarse/desactivarse a sí mismo o a otro SUPER_ADMIN — la invariante
-- real es "que quede al menos un SUPER_ADMIN activo DESPUÉS del cambio",
-- una condición sobre el estado agregado de la tabla, no sobre la fila
-- individual). Se implementa como trigger BEFORE UPDATE: si la fila que se
-- está modificando es HOY un SUPER_ADMIN activo, y el cambio la dejaría sin
-- serlo (cambia de rol, o se desactiva), y no queda NINGÚN OTRO SUPER_ADMIN
-- activo, se rechaza. DELETE no requiere protección equivalente: profiles
-- nunca tuvo policy de DELETE para `authenticated` (deny-by-default, Fase 3)
-- — nadie, ni siquiera SUPER_ADMIN, puede borrar una fila de profiles vía
-- la aplicación.
create or replace function public.prevent_last_super_admin_removal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_other_active_super_admins integer;
begin
  if old.role = 'SUPER_ADMIN'::public.app_role
     and old.active
     and (new.role is distinct from 'SUPER_ADMIN'::public.app_role or new.active = false)
  then
    select count(*) into v_other_active_super_admins
    from public.profiles
    where role = 'SUPER_ADMIN'::public.app_role
      and active
      and id <> old.id;

    if v_other_active_super_admins = 0 then
      raise exception
        'Cannot remove the last active SUPER_ADMIN: at least one active SUPER_ADMIN must remain.';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.prevent_last_super_admin_removal() is
  'Invariante: siempre debe existir al menos un SUPER_ADMIN activo. Bloquea '
  'degradar de rol o desactivar (active=false) al ÚLTIMO SUPER_ADMIN activo '
  '— tanto por auto-modificación como por acción de otro SUPER_ADMIN. No '
  'cubre DELETE porque profiles nunca tuvo policy de DELETE para '
  '`authenticated` (Fase 5D, PASO 12 del encargo).';

create trigger profiles_prevent_last_super_admin_removal
  before update on public.profiles
  for each row
  execute function public.prevent_last_super_admin_removal();
