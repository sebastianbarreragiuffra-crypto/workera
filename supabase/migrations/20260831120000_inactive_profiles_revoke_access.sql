-- Revocación inmediata de autorización para perfiles desactivados.
--
-- Supabase Auth puede conservar una sesión/JWT válido después de que RRHH
-- marque profiles.active = false. Por eso `active` debe evaluarse en la
-- frontera de autorización de la base de datos y no solamente en el layout.
-- Todas las policies basadas en current_user_role()/is_* heredan este cierre.

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and active;
$$;

comment on function public.current_user_role() is
  'Rol del usuario autenticado solo cuando su profile está activo. Un JWT '
  'aún válido no conserva autorización después de profiles.active=false.';

-- Este permiso es deliberadamente independiente del rol, por lo que también
-- debe incorporar `active` de forma explícita; no hereda current_user_role().
create or replace function public.is_medical_license_approver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select medical_license_approver
    from public.profiles
    where id = auth.uid()
      and active
  ), false);
$$;

comment on function public.is_medical_license_approver() is
  'true solo para la cuenta aprobadora de licencias mientras su profile '
  'permanece activo; una sesión previa no permite eludir la desactivación.';

-- CREATE OR REPLACE conserva privilegios existentes, pero se reafirman para
-- que la frontera sea explícita y auditable en esta migración de seguridad.
revoke all on function public.current_user_role() from anon, public;
grant execute on function public.current_user_role() to authenticated;

revoke all on function public.is_medical_license_approver() from anon, public;
grant execute on function public.is_medical_license_approver() to authenticated;

-- Excepción histórica 1: audit_log permitía INSERT solo por coincidencia de
-- actor_id, sin consultar ningún helper de rol. Se conserva la atribución al
-- actor real y se añade el gate corporativo activo.
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (
    public.is_corporate_user()
    and actor_id = auth.uid()
  );

-- Excepción histórica 2: esta vista security-definer permite a quien subió
-- un documento ver su metadata mediante `uploaded_by = auth.uid()`. Esa rama
-- directa también debe quedar detrás del gate activo; profiles_select propio
-- se mantiene deliberadamente como la única autolectura para inactivos.
create or replace view public.supporting_documents_metadata
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
  public.is_corporate_user()
  and (
    public.is_privileged_admin()
    or uploaded_by = auth.uid()
    or public.can_manage_employee(employee_id)
  );

comment on view public.supporting_documents_metadata is
  'Metadata de documentos sin storage_path. Solo profiles activos pueden '
  'leerla; dentro de ese gate conserva el alcance por privilegio, autor o '
  'empleado gestionable.';

grant select on public.supporting_documents_metadata to authenticated;
revoke all on public.supporting_documents_metadata from anon, public;
