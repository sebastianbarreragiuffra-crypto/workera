-- =============================================================================
-- Fase 8 -- bucket privado de Supabase Storage para supporting_documents.
-- =============================================================================
--
-- Fase 7 dejó `supporting_documents.storage_path` como texto libre y
-- documentó explícitamente que el bucket real no estaba implementado
-- todavía ("Storage real no implementado en esta fase", migración
-- 20260817144623). Esta migración SOLO agrega la infraestructura de
-- almacenamiento que faltaba -- no toca el esquema de `supporting_documents`
-- ni ninguna regla de negocio de Fase 7.
--
-- Política de acceso: exactamente el mismo criterio que ya rige la fila de
-- metadata en `public.supporting_documents` (Fase 7), para que Storage y
-- metadata nunca diverjan en quién puede hacer qué:
--   - INSERT: el mismo supervisor/admin que puede gestionar al empleado
--     (`public.can_manage_employee`, ya usado en el resto del esquema).
--   - SELECT/download: solo `public.is_privileged_admin()` (SUPER_ADMIN /
--     ADMIN_RRHH) -- igual que la policy `supporting_documents_select_admin`
--     ya existente; un supervisor puede ADJUNTAR pero no listar/descargar
--     documentos ya subidos, ni los propios ni los de otros.
--   - UPDATE/DELETE: nadie vía policy (los documentos son inmutables una vez
--     subidos, igual que la fila de metadata -- corrección real).
--
-- Convención de ruta: `{employee_id}/{uuid}-{nombre_original_saneado}` -- el
-- primer segmento de la ruta es el `employee_id`, así la policy puede
-- evaluar `can_manage_employee` sin necesitar una tabla puente.

insert into storage.buckets (id, name, public)
values ('supporting-documents', 'supporting-documents', false)
on conflict (id) do nothing;

create policy "supporting_documents_storage_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'supporting-documents'
    and public.can_manage_employee(((storage.foldername(name))[1])::uuid)
  );

create policy "supporting_documents_storage_select_admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'supporting-documents'
    and public.is_privileged_admin()
  );
