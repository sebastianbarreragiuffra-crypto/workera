import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import { isPrivilegedAdmin } from "../../../../../lib/supabase/authorize";
import {
  authorizeSupportingDocumentDownload,
  privateSupportingDocumentHeaders,
  supportingDocumentDownloadFailureResponse,
} from "../../../../../lib/decisions/document-download";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Descarga privada de un documento laboral. PostgreSQL vuelve a autorizar
 * rol, MFA, empresa y recurso; también consume el límite y audita. El handler
 * obtiene los bytes con el JWT de sesión y los sirve como attachment: nunca
 * expone al navegador una signed URL reutilizable ni renderiza el archivo.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const profile = await getCurrentProfile();
  if (!isPrivilegedAdmin(profile?.role)) {
    return supportingDocumentDownloadFailureResponse({ status: "DENIED" })!;
  }

  const { documentId } = await params;
  if (!UUID.test(documentId)) {
    return supportingDocumentDownloadFailureResponse({ status: "DENIED" })!;
  }
  const supabase = await createClient();
  const access = await authorizeSupportingDocumentDownload(supabase, documentId);
  if (access.status !== "ALLOWED") {
    return supportingDocumentDownloadFailureResponse(access)!;
  }

  const { data: file, error } = await supabase.storage
    .from("supporting-documents")
    .download(access.storagePath);
  if (error || !file) {
    return supportingDocumentDownloadFailureResponse({ status: "UNAVAILABLE" })!;
  }

  return new Response(file, {
    status: 200,
    headers: privateSupportingDocumentHeaders(access.originalFilename, file.size),
  });
}
