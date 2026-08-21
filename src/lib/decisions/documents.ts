import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Subida de comprobantes/licencias (Fase 8, PASO 6/Documentos). Sube al
 * bucket privado `supporting-documents` (creado en esta fase, ver
 * `supabase/migrations/20260821100000_phase8_documents_storage_bucket.sql`)
 * y luego inserta la fila de metadata en `public.supporting_documents`
 * (esquema de Fase 7, sin cambios). Nunca genera una URL pública ni marca
 * el bucket como público -- si la subida a Storage falla, no se inserta
 * metadata; si la subida a Storage funciona pero el insert de metadata
 * falla (ej. RLS/constraint), el archivo queda huérfano en Storage pero
 * nunca se referencia desde ninguna tabla -- aceptable para esta fase,
 * documentado como limitación conocida en docs/UI_PHASE8.md (no hay
 * garbage-collection de objetos huérfanos todavía).
 */

export type SupportingDocumentType = "MEDICAL_CERTIFICATE" | "TRANSPORT_PROOF" | "IDENTIFICATION" | "OTHER";

export type SupportingDocumentRelation =
  | { kind: "ABSENCE"; absenceRecordId: string }
  | { kind: "LATE_ARRIVAL_DECISION"; lateArrivalDecisionId: string }
  | { kind: "EARLY_DEPARTURE"; earlyDepartureRecordId: string };

export interface UploadSupportingDocumentInput {
  employeeId: string;
  documentType: SupportingDocumentType;
  originalFilename: string;
  mimeType: string;
  fileBytes: Uint8Array;
  /** Ausente = documento general del trabajador, sin atarlo a un caso puntual (esquema lo permite, ver migración 20260817144623). */
  relation?: SupportingDocumentRelation;
}

export interface UploadSupportingDocumentResult {
  documentId: string;
  storagePath: string;
}

/**
 * Fotos de licencia/comprobantes tomadas con celular pesan más que una
 * planilla -- 10MB en vez de los 5MB de los importadores Excel (auditoría de
 * Vercel readiness: este límite antes no existía en absoluto, único upload
 * de la app sin tope).
 */
export const MAX_SUPPORTING_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-120);
}

export async function uploadSupportingDocument(
  supabase: SupabaseClient<Database>,
  input: UploadSupportingDocumentInput
): Promise<UploadSupportingDocumentResult> {
  if (input.fileBytes.byteLength > MAX_SUPPORTING_DOCUMENT_SIZE_BYTES) {
    throw new Error(`El archivo supera el tamaño máximo permitido (${MAX_SUPPORTING_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB).`);
  }

  const storagePath = `${input.employeeId}/${crypto.randomUUID()}-${sanitizeFilename(input.originalFilename)}`;

  const { error: uploadError } = await supabase.storage
    .from("supporting-documents")
    .upload(storagePath, input.fileBytes, { contentType: input.mimeType, upsert: false });
  if (uploadError) {
    throw new Error(`uploadSupportingDocument: fallo subiendo archivo a Storage: ${uploadError.message}`);
  }

  const relationColumns = !input.relation
    ? {}
    : input.relation.kind === "ABSENCE"
      ? { absence_record_id: input.relation.absenceRecordId }
      : input.relation.kind === "LATE_ARRIVAL_DECISION"
        ? { late_arrival_decision_id: input.relation.lateArrivalDecisionId }
        : { early_departure_record_id: input.relation.earlyDepartureRecordId };

  // id generado en el cliente e insertado explícitamente -- NUNCA
  // `.select().single()` después del insert: la policy de SELECT de esta
  // tabla es exclusiva de `is_privileged_admin()` (ver migración
  // 20260817152542), y Postgres exige que una fila devuelta por
  // `INSERT ... RETURNING` pase esa misma policy de SELECT o la sentencia
  // completa falla con "new row violates row-level security policy" aunque
  // el WITH CHECK del INSERT sí se cumplió -- un supervisor SIEMPRE
  // recibiría ese error al subir un documento si se pidiera RETURNING.
  const documentId = crypto.randomUUID();
  const { error } = await supabase.from("supporting_documents").insert({
    id: documentId,
    employee_id: input.employeeId,
    document_type: input.documentType,
    storage_path: storagePath,
    mime_type: input.mimeType,
    original_filename: input.originalFilename,
    ...relationColumns,
  });
  if (error) {
    throw new Error(`uploadSupportingDocument: fallo insertando metadata: ${error.message}`);
  }

  return { documentId, storagePath };
}

const SIGNED_URL_TTL_SECONDS = 60;

/**
 * URL firmada de corta duración para ver/descargar un documento -- nunca una
 * URL pública permanente (PASO 20/Fase 8C sección L). `storage.objects` solo
 * permite SELECT a `is_privileged_admin()` (ver migración
 * 20260821100000_phase8_documents_storage_bucket.sql), así que esto falla
 * con el cliente de sesión normal para cualquier otro rol -- RLS sigue
 * siendo la autoridad real, no un chequeo de conveniencia en la UI.
 */
export async function getSignedDocumentUrl(supabase: SupabaseClient<Database>, documentId: string): Promise<string> {
  const { data: doc, error: docError } = await supabase.from("supporting_documents").select("storage_path").eq("id", documentId).single();
  if (docError || !doc) {
    throw new Error(`getSignedDocumentUrl: documento no encontrado o sin acceso (${documentId}).`);
  }

  const { data, error } = await supabase.storage.from("supporting-documents").createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`getSignedDocumentUrl: fallo generando URL firmada: ${error?.message ?? "sin datos"}`);
  }
  return data.signedUrl;
}
