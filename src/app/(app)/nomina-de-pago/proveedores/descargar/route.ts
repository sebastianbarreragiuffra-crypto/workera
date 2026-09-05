import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import {
  authorizeWorkforceDataAccess,
  workforceDataAccessFailureResponse,
} from "../../../../../lib/decisions/workforce-data-access";
import { privateAttachmentHeaders } from "../../../../../lib/shared/private-download";

/**
 * Descarga del archivo maestro de proveedores ACTUALMENTE ACTIVO. PostgreSQL
 * deriva ARCOTEX y revalida membresia, rol, MFA, cuota y fila ACTIVE. El
 * handler sirve los bytes como attachment; nunca expone una signed URL.
 */
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile?.role || (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH")) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  const supabase = await createClient();
  const access = await authorizeWorkforceDataAccess(supabase, {
    scope: "supplier_master.download",
  });
  if (access.status !== "ALLOWED") {
    return workforceDataAccessFailureResponse(access, {
      deniedStatus: 404,
      deniedMessage: "No hay un maestro de proveedores activo.",
    })!;
  }
  const { data: file, error } = await supabase.storage
    .from("supplier-master-files")
    .download(access.storagePath!);
  if (error || !file) {
    return workforceDataAccessFailureResponse({ status: "UNAVAILABLE" })!;
  }

  return new Response(file, {
    status: 200,
    headers: privateAttachmentHeaders(access.originalFilename!, file.size, {
      limit: access.requestLimit,
      remaining: access.remaining,
    }),
  });
}
