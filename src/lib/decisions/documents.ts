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
  relation: SupportingDocumentRelation;
}

export interface UploadSupportingDocumentResult {
  documentId: string;
  storagePath: string;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-120);
}

export async function uploadSupportingDocument(
  supabase: SupabaseClient<Database>,
  input: UploadSupportingDocumentInput
): Promise<UploadSupportingDocumentResult> {
  const storagePath = `${input.employeeId}/${crypto.randomUUID()}-${sanitizeFilename(input.originalFilename)}`;

  const { error: uploadError } = await supabase.storage
    .from("supporting-documents")
    .upload(storagePath, input.fileBytes, { contentType: input.mimeType, upsert: false });
  if (uploadError) {
    throw new Error(`uploadSupportingDocument: fallo subiendo archivo a Storage: ${uploadError.message}`);
  }

  const relationColumns =
    input.relation.kind === "ABSENCE"
      ? { absence_record_id: input.relation.absenceRecordId }
      : input.relation.kind === "LATE_ARRIVAL_DECISION"
        ? { late_arrival_decision_id: input.relation.lateArrivalDecisionId }
        : { early_departure_record_id: input.relation.earlyDepartureRecordId };

  const { data, error } = await supabase
    .from("supporting_documents")
    .insert({
      employee_id: input.employeeId,
      document_type: input.documentType,
      storage_path: storagePath,
      mime_type: input.mimeType,
      original_filename: input.originalFilename,
      ...relationColumns,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`uploadSupportingDocument: fallo insertando metadata: ${error?.message ?? "sin fila devuelta"}`);
  }

  return { documentId: data.id, storagePath };
}
