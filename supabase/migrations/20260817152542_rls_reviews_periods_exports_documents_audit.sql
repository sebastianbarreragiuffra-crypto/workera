-- Fase 3 — 22: RLS de revisión diaria/semanal, período de reporte, exports,
-- documentos (con vista de metadata sin storage_path) y auditoría inmutable

alter table public.weekly_review_snapshots alter column generated_by set default auth.uid();
alter table public.period_snapshots alter column generated_by set default auth.uid();
alter table public.excel_exports alter column generated_by set default auth.uid();
alter table public.supporting_documents alter column uploaded_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- daily_reviews: lectura amplia; UPDATE (transición de estado) dentro del
-- contexto operacional del supervisor a cargo del trabajador, o ADMIN_RRHH
-- sin restricción. Sin INSERT/DELETE para `authenticated`: las filas de
-- DailyReview las crea el proceso de importación (fase futura, service_role).
alter table public.daily_reviews enable row level security;

create policy daily_reviews_select on public.daily_reviews
  for select to authenticated using (public.is_corporate_user());

create policy daily_reviews_update on public.daily_reviews
  for update to authenticated
  using (public.can_manage_employee(employee_id))
  with check (public.can_manage_employee(employee_id));

-- ---------------------------------------------------------------------------
-- weekly_reviews: check semanal, alcance de toda la compañía (Fase 2A — no
-- está asociado a un trabajador ni grupo específico). Lectura amplia.
-- Cualquier corporativo puede avanzar el estado MIENTRAS no sea hacia/desde
-- CLOSED o REOPENED (sección 17: "supervisor puede revisar información...
-- no permitir que reabra unilateralmente un período cerrado"). Cerrar o
-- reabrir es exclusivo de ADMIN_RRHH, y al hacerlo debe quedar como actor
-- (closed_by/reopened_by = auth.uid(), nunca un valor de cliente arbitrario).
alter table public.weekly_reviews enable row level security;

create policy weekly_reviews_select on public.weekly_reviews
  for select to authenticated using (public.is_corporate_user());

create policy weekly_reviews_update on public.weekly_reviews
  for update to authenticated
  using (
    public.is_admin_rrhh()
    or (public.is_corporate_user() and status not in ('CLOSED', 'REOPENED'))
  )
  with check (
    (
      public.is_admin_rrhh()
      and (status <> 'CLOSED' or closed_by = auth.uid())
      and (status <> 'REOPENED' or reopened_by = auth.uid())
    )
    or (
      public.is_corporate_user()
      and not public.is_admin_rrhh()
      and status not in ('CLOSED', 'REOPENED')
    )
  );

-- ---------------------------------------------------------------------------
-- weekly_review_snapshots: lectura amplia; INSERT solo ADMIN_RRHH (crear un
-- snapshot es parte del flujo de cierre, sección 27/29 del encargo).
alter table public.weekly_review_snapshots enable row level security;

create policy weekly_review_snapshots_select on public.weekly_review_snapshots
  for select to authenticated using (public.is_corporate_user());

create policy weekly_review_snapshots_insert_admin on public.weekly_review_snapshots
  for insert to authenticated
  with check (public.is_admin_rrhh() and generated_by = auth.uid());

-- ---------------------------------------------------------------------------
-- reporting_periods: lectura amplia. OPEN/REOPEN/CLOSE es EXCLUSIVAMENTE
-- ADMIN_RRHH (sección 18 del encargo, regla obligatoria, sin excepción) —
-- ninguna otra policy otorga INSERT/UPDATE aquí.
alter table public.reporting_periods enable row level security;

create policy reporting_periods_select on public.reporting_periods
  for select to authenticated using (public.is_corporate_user());

create policy reporting_periods_insert_admin on public.reporting_periods
  for insert to authenticated
  with check (public.is_admin_rrhh());

create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (
    public.is_admin_rrhh()
    and (status <> 'CLOSED' or closed_by = auth.uid())
    and (status <> 'REOPENED' or reopened_by = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- period_snapshots: mismo criterio que weekly_review_snapshots.
alter table public.period_snapshots enable row level security;

create policy period_snapshots_select on public.period_snapshots
  for select to authenticated using (public.is_corporate_user());

create policy period_snapshots_insert_admin on public.period_snapshots
  for insert to authenticated
  with check (public.is_admin_rrhh() and generated_by = auth.uid());

-- ---------------------------------------------------------------------------
-- excel_exports: restringido enteramente a ADMIN_RRHH (sección 19 del
-- encargo — generar/consultar/descargar exports es atribución de RRHH; no
-- está en la lista de permisos de ningún supervisor).
alter table public.excel_exports enable row level security;

create policy excel_exports_admin_only on public.excel_exports
  for all to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh() and generated_by = auth.uid());

-- ---------------------------------------------------------------------------
-- supporting_documents (tabla base): acceso completo (incluido storage_path)
-- restringido a ADMIN_RRHH — es el único camino para llegar al "puntero" del
-- archivo privado (sección 12/13: "solo ADMIN_RRHH puede visualizar el
-- contenido de documentos sensibles"). INSERT (subir metadata) permitido a
-- cualquier corporativo dentro de su contexto operacional, con uploaded_by
-- forzado. UPDATE (solo is_current, trigger de Fase 2B) exclusivo de
-- ADMIN_RRHH — desactivar/dar de baja un documento es una decisión
-- administrativa (sección 15).
alter table public.supporting_documents enable row level security;

create policy supporting_documents_select_admin on public.supporting_documents
  for select to authenticated using (public.is_admin_rrhh());

create policy supporting_documents_insert on public.supporting_documents
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.can_manage_employee(employee_id)
  );

create policy supporting_documents_update_admin on public.supporting_documents
  for update to authenticated
  using (public.is_admin_rrhh())
  with check (public.is_admin_rrhh());

-- Vista de METADATA sin storage_path — el mecanismo real que separa "ver que
-- existe un documento adjuntado" de "poder acceder a su contenido" (sección
-- 12/13). Postgres RLS filtra FILAS, no columnas; para ocultar una columna
-- específica a los mismos usuarios que sí pueden ver otras columnas de la
-- misma fila (supervisor ve metadata, no storage_path) se requiere una vista
-- separada. security_invoker = false (explícito, valor por defecto):
-- necesario para que la vista pueda leer supporting_documents pese a que la
-- policy de la tabla base restringe SELECT a ADMIN_RRHH — la vista corre con
-- los privilegios de su dueño (postgres, sin RLS aplicable), y es el propio
-- WHERE de la vista (usando auth.uid()/can_manage_employee, que sí reflejan
-- a quién está conectado realmente) el que decide qué filas devolver. Esto
-- NO es un bypass de seguridad: es el único mecanismo de Postgres para lograr
-- ocultamiento a nivel de columna combinado con filtrado a nivel de fila.
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
  public.is_admin_rrhh()
  or uploaded_by = auth.uid()
  or public.can_manage_employee(employee_id);

comment on view public.supporting_documents_metadata is
  'Metadata de documentos SIN storage_path. Vía de lectura para supervisores '
  '(no tienen SELECT sobre la tabla base). ADMIN_RRHH sigue viendo el '
  'contenido/puntero real (storage_path) únicamente a través de la tabla base.';

grant select on public.supporting_documents_metadata to authenticated;
revoke all on public.supporting_documents_metadata from anon, public;

-- ---------------------------------------------------------------------------
-- audit_log: transversal, crítico. Lectura restringida a ADMIN_RRHH (sección
-- 36 — se opta por el criterio más conservador: "supervisor puede tener
-- acceso limitado si es necesario" se deja fuera de alcance de Fase 3,
-- documentado como simplificación explícita, no un descuido). INSERT
-- permitido a cualquier corporativo pero exclusivamente atribuyéndose a sí
-- mismo (actor_id = auth.uid()) — nunca se puede insertar un evento fingiendo
-- otro actor. SIN policy de UPDATE ni DELETE para `authenticated`: además de
-- la ausencia de policy (deny-by-default), se agrega el trigger de
-- inmutabilidad ya usado en el resto del esquema para que ni siquiera
-- `service_role` lo edite por accidente vía un bug de aplicación.
alter table public.audit_log enable row level security;

create policy audit_log_select_admin on public.audit_log
  for select to authenticated using (public.is_admin_rrhh());

create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (actor_id = auth.uid());

create trigger audit_log_immutable
  before update on public.audit_log
  for each row
  execute function public.enforce_immutable_columns();
