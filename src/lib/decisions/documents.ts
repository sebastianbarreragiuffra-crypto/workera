import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Frontera del protocolo reserve -> upload -> commit para el bucket privado
 * `supporting-documents`. PostgreSQL autoriza la reserva, Storage acepta solo
 * esa ruta y el RPC final confirma metadata + auditoría. Ante un resultado
 * incierto se intenta borrar exclusivamente el objeto todavía huérfano.
 */

export type SupportingDocumentType = "MEDICAL_CERTIFICATE" | "TRANSPORT_PROOF" | "IDENTIFICATION" | "OTHER";

/** Espejo del CHECK de `supporting_documents.document_type`. */
export const SUPPORTING_DOCUMENT_TYPES: readonly SupportingDocumentType[] = [
  "MEDICAL_CERTIFICATE",
  "TRANSPORT_PROOF",
  "IDENTIFICATION",
  "OTHER",
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const SUPPORTED_DOCUMENT_FORMATS = [
  { mimeType: "application/pdf", extension: "pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mimeType: "image/jpeg", extension: "jpg", signature: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", extension: "png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
] as const;

export type SupportingDocumentMime = (typeof SUPPORTED_DOCUMENT_FORMATS)[number]["mimeType"];

export interface ValidatedSupportingDocument {
  mimeType: SupportingDocumentMime;
  extension: "pdf" | "jpg" | "png";
}

/** El MIME del navegador es una pista; la firma real es la autoridad. */
export function validateSupportingDocumentFile(
  fileBytes: Uint8Array,
  declaredMimeType: string,
): ValidatedSupportingDocument {
  if (fileBytes.byteLength < 1) throw new Error("El documento está vacío.");
  if (fileBytes.byteLength > MAX_SUPPORTING_DOCUMENT_SIZE_BYTES) {
    throw new Error(`El archivo supera el tamaño máximo permitido (${MAX_SUPPORTING_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB).`);
  }

  const format = SUPPORTED_DOCUMENT_FORMATS.find(({ signature }) =>
    signature.every((byte, index) => fileBytes[index] === byte),
  );
  if (!format) throw new Error("El documento debe ser un PDF, JPG o PNG válido.");
  if (declaredMimeType && declaredMimeType !== "application/octet-stream" && declaredMimeType !== format.mimeType) {
    throw new Error("El contenido del documento no coincide con su formato declarado.");
  }
  return { mimeType: format.mimeType, extension: format.extension };
}

interface StagedSupportingDocument {
  intentId: string;
  storagePath: string;
}

export async function stageSupportingDocument(
  supabase: SupabaseClient<Database>,
  input: Pick<UploadSupportingDocumentInput, "employeeId" | "mimeType" | "fileBytes">,
): Promise<StagedSupportingDocument> {
  const format = validateSupportingDocumentFile(input.fileBytes, input.mimeType);
  const { data: reservation, error: reservationError } = await supabase
    .rpc("reserve_supporting_document_upload", {
      p_employee_id: input.employeeId,
      p_mime_type: format.mimeType,
      p_extension: format.extension,
      p_file_size: input.fileBytes.byteLength,
    })
    .single();
  if (reservationError || !reservation) {
    throw new Error(`No se pudo reservar el documento: ${reservationError?.message ?? "sin respuesta"}`);
  }

  const { error: uploadError } = await supabase.storage
    .from("supporting-documents")
    .upload(reservation.storage_path, input.fileBytes, { contentType: format.mimeType, upsert: false });
  if (uploadError) {
    // La respuesta de Storage puede ser incierta (timeout después de aceptar
    // el objeto). La reserva aún está abierta, así que la policy permite una
    // eliminación compensatoria segura si el objeto alcanzó a persistirse.
    await discardStagedSupportingDocument(supabase, {
      intentId: reservation.intent_id,
      storagePath: reservation.storage_path,
    });
    throw new Error(`No se pudo subir el documento: ${uploadError.message}`);
  }
  return { intentId: reservation.intent_id, storagePath: reservation.storage_path };
}

export async function discardStagedSupportingDocument(
  supabase: SupabaseClient<Database>,
  staged: StagedSupportingDocument,
): Promise<void> {
  const { error } = await supabase.storage.from("supporting-documents").remove([staged.storagePath]);
  if (error) {
    // La ruta ya es opaca (solo UUID); nunca se registra filename ni contenido.
    console.error("[documentos] no se pudo compensar un objeto huérfano", staged.intentId, error.message);
  }
}

export async function uploadSupportingDocument(
  supabase: SupabaseClient<Database>,
  input: UploadSupportingDocumentInput
): Promise<UploadSupportingDocumentResult> {
  // `document_type` se valida antes de reservar/subir. El RPC repite el gate:
  // TypeScript nunca es la única autoridad.
  if (!SUPPORTING_DOCUMENT_TYPES.includes(input.documentType)) {
    throw new Error(`uploadSupportingDocument: tipo de documento no válido (${input.documentType}).`);
  }
  if (!UUID_PATTERN.test(input.employeeId)) {
    // Además de romper el INSERT, el id es el primer segmento de la ruta y la
    // policy de Storage lo castea a uuid: un valor no-UUID falla con un error
    // de casteo en vez de una negación limpia.
    throw new Error("uploadSupportingDocument: identificador de trabajador no válido.");
  }

  const relationArgs = !input.relation
    ? { p_absence_record_id: null, p_late_arrival_decision_id: null, p_early_departure_record_id: null }
    : input.relation.kind === "ABSENCE"
      ? { p_absence_record_id: input.relation.absenceRecordId, p_late_arrival_decision_id: null, p_early_departure_record_id: null }
      : input.relation.kind === "LATE_ARRIVAL_DECISION"
        ? { p_absence_record_id: null, p_late_arrival_decision_id: input.relation.lateArrivalDecisionId, p_early_departure_record_id: null }
        : { p_absence_record_id: null, p_late_arrival_decision_id: null, p_early_departure_record_id: input.relation.earlyDepartureRecordId };

  const staged = await stageSupportingDocument(supabase, input);
  try {
    const { data: documentId, error } = await supabase.rpc("register_supporting_document_upload", {
      p_intent_id: staged.intentId,
      p_document_type: input.documentType,
      p_original_filename: input.originalFilename.slice(-240),
      ...relationArgs,
    });
    if (error || !documentId) {
      throw new Error(`No se pudo registrar el documento: ${error?.message ?? "sin respuesta"}`);
    }
    return { documentId, storagePath: staged.storagePath };
  } catch (error) {
    await discardStagedSupportingDocument(supabase, staged);
    throw error;
  }
}
