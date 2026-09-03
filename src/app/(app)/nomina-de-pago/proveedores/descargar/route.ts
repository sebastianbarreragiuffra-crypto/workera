import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import { requireSingleOperationalCompany } from "../../../../../lib/tenant/resolve-active-company";

/**
 * Descarga del archivo maestro de proveedores ACTUALMENTE ACTIVO. Genera
 * una signed URL de corta duración en el momento (nunca una URL pública
 * permanente) y redirige -- el archivo nunca pasa por este servidor, solo
 * la referencia temporal a Storage.
 */
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile?.role || (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH")) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  const supabase = await createClient();
  const company = await requireSingleOperationalCompany(supabase);

  const { data: active, error: activeError } = await supabase
    .from("supplier_master_imports")
    .select("storage_path, original_filename")
    .eq("company_id", company.companyId)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (activeError) {
    return NextResponse.json({ error: "No pudimos leer el maestro de proveedores." }, { status: 500 });
  }
  if (!active?.storage_path) {
    return NextResponse.json({ error: "No hay un maestro de proveedores activo." }, { status: 404 });
  }

  const { data: signed, error: signError } = await supabase.storage.from("supplier-master-files").createSignedUrl(active.storage_path, 60, {
    download: active.original_filename,
  });
  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: "No pudimos generar el enlace de descarga." }, { status: 500 });
  }

  return NextResponse.redirect(signed.signedUrl);
}
