import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { privateAttachmentHeaders } from "../shared/private-download";

export { attachmentContentDisposition } from "../shared/private-download";

export type SupportingDocumentDownloadDecision =
  | {
      status: "ALLOWED";
      storagePath: string;
      originalFilename: string;
      mimeType: string;
      remaining: number;
      requestLimit: number;
    }
  | { status: "RATE_LIMITED"; retryAfterSeconds: number; requestLimit: number }
  | { status: "DENIED" }
  | { status: "UNAVAILABLE" };

const DENIED_DATABASE_CODES = new Set(["22023", "42501", "P0002"]);

/**
 * Postgres es la segunda autoridad del Route Handler: resuelve el tenant desde
 * el documento, exige rol/MFA/membresia y consume una cuota compartida antes
 * de devolver la ruta privada. No genera ni expone signed URLs.
 */
export async function authorizeSupportingDocumentDownload(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<SupportingDocumentDownloadDecision> {
  const { data, error } = await supabase
    .rpc("authorize_supporting_document_download", { p_document_id: documentId })
    .maybeSingle();

  if (error) {
    if (DENIED_DATABASE_CODES.has(error.code ?? "")) return { status: "DENIED" };
    return { status: "UNAVAILABLE" };
  }
  if (!data) return { status: "UNAVAILABLE" };
  if (!data.allowed) {
    return {
      status: "RATE_LIMITED",
      retryAfterSeconds: Math.max(1, Math.min(86_400, data.retry_after_seconds)),
      requestLimit: data.request_limit,
    };
  }
  if (!data.storage_path || !data.original_filename || !data.mime_type) {
    return { status: "UNAVAILABLE" };
  }
  return {
    status: "ALLOWED",
    storagePath: data.storage_path,
    originalFilename: data.original_filename,
    mimeType: data.mime_type,
    remaining: Math.max(0, data.remaining),
    requestLimit: data.request_limit,
  };
}

const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export function supportingDocumentDownloadFailureResponse(
  decision: SupportingDocumentDownloadDecision,
): Response | null {
  if (decision.status === "ALLOWED") return null;
  if (decision.status === "RATE_LIMITED") {
    return new Response("Demasiadas descargas. Intenta nuevamente mas tarde.", {
      status: 429,
      headers: {
        ...PRIVATE_RESPONSE_HEADERS,
        "Retry-After": String(decision.retryAfterSeconds),
      },
    });
  }
  if (decision.status === "DENIED") {
    // 404 evita confirmar que existe un documento de otro tenant.
    return new Response("Documento no encontrado.", {
      status: 404,
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  }
  return new Response("No fue posible autorizar la descarga.", {
    status: 503,
    headers: PRIVATE_RESPONSE_HEADERS,
  });
}

export function privateSupportingDocumentHeaders(
  originalFilename: string,
  byteLength: number,
): Record<string, string> {
  // El archivo sigue siendo no confiable hasta integrar antimalware/CDR.
  return privateAttachmentHeaders(originalFilename, byteLength);
}
