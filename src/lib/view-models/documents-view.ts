import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { areasVisibleToRole, assertAreaAccessAllowed, type AreaCode, type CallerRole } from "../access/scope";

/**
 * Centro de documentos (Fase 8C, sección L). Lee `supporting_documents_metadata`
 * (Fase 7/8 -- vista sin `storage_path`, ver migración
 * 20260817152542) para que un supervisor pueda ver QUÉ existe sin necesitar
 * acceso a `storage.objects`. El contenido/descarga real sigue siendo
 * exclusivo de SUPER_ADMIN/ADMIN_RRHH vía `getSignedDocumentUrl` (RLS lo
 * exige, no solo esta pantalla).
 */

export interface DocumentCenterEntry {
  id: string;
  employeeId: string;
  employeeDisplayName: string;
  areaCode: AreaCode | null;
  documentType: string;
  originalFilename: string;
  uploadedAt: string;
  canView: boolean;
}

export interface DocumentCenterFilter {
  areaCode?: AreaCode;
  employeeId?: string;
}

export async function getDocumentCenter(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  filter: DocumentCenterFilter
): Promise<DocumentCenterEntry[]> {
  const allowedAreas = areasVisibleToRole(callerRole);
  if (filter.areaCode) assertAreaAccessAllowed(callerRole, filter.areaCode);
  const canView = callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH";

  let query = supabase
    .from("supporting_documents_metadata")
    .select("id, employee_id, document_type, original_filename, uploaded_at")
    .order("uploaded_at", { ascending: false });
  if (filter.employeeId) query = query.eq("employee_id", filter.employeeId);

  const { data: rawDocs, error } = await query;
  if (error) throw new Error(`getDocumentCenter: fallo leyendo supporting_documents_metadata: ${error.message}`);

  // La vista expone todas las columnas como nullable a nivel de tipos
  // (PostgREST no hereda NOT NULL de la tabla base a través de una vista),
  // pero la tabla base las garantiza NOT NULL -- filtrar por id descarta
  // cualquier fila degenerada sin reinterpretar el contrato real.
  const docs = (rawDocs ?? []).filter((d): d is typeof d & { id: string; employee_id: string; document_type: string; original_filename: string; uploaded_at: string } => d.id !== null);

  const employeeIds = [...new Set(docs.map((d) => d.employee_id))];
  if (employeeIds.length === 0) return [];

  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("id, display_name, employee_groups(code)")
    .in("id", employeeIds);
  if (employeesError) throw new Error(`getDocumentCenter: fallo leyendo employees: ${employeesError.message}`);

  const employeeById = new Map(
    (employees ?? []).map((e) => {
      const groupRelation = e.employee_groups as { code: string } | { code: string }[] | null;
      const areaCode = (Array.isArray(groupRelation) ? groupRelation[0]?.code : groupRelation?.code) as AreaCode | undefined;
      return [e.id, { displayName: e.display_name, areaCode: areaCode ?? null }];
    })
  );

  return docs
    .map((doc) => {
      const employee = employeeById.get(doc.employee_id);
      return {
        id: doc.id,
        employeeId: doc.employee_id,
        employeeDisplayName: employee?.displayName ?? "—",
        areaCode: employee?.areaCode ?? null,
        documentType: doc.document_type,
        originalFilename: doc.original_filename,
        uploadedAt: doc.uploaded_at,
        canView,
      };
    })
    .filter((entry) => {
      if (filter.areaCode) return entry.areaCode === filter.areaCode;
      if (allowedAreas.length === 3) return true;
      return entry.areaCode !== null && allowedAreas.includes(entry.areaCode);
    });
}
