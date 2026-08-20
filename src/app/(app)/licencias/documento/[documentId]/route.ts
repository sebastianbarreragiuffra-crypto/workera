import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import { getSignedDocumentUrl } from "../../../../../lib/decisions/documents";

/**
 * Ver el documento de una licencia médica -- genera una signed URL de corta
 * duración y redirige (nunca una URL pública permanente). Reutiliza
 * `getSignedDocumentUrl` sin cambios: la privacidad del documento sigue
 * siendo exactamente la que ya existía (RLS de `supporting_documents`/
 * `storage.objects`, exclusiva de `is_privileged_admin()`) -- este endpoint
 * no le da acceso a nadie que no lo tuviera ya.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  const { documentId } = await params;
  const supabase = await createClient();

  try {
    const signedUrl = await getSignedDocumentUrl(supabase, documentId);
    return NextResponse.redirect(signedUrl);
  } catch {
    return NextResponse.json({ error: "No pudimos generar el enlace del documento." }, { status: 404 });
  }
}
