import { NextResponse } from "next/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { buildAttendanceExportData, buildAttendanceExportWorkbook } from "../../../../lib/business-rules/attendance-export";
import { resolvePayrollPeriod } from "../../../../lib/business-rules/attendance-export-periods";
import { comparePayrollWorkbooks } from "../../../../lib/payroll/payroll-workbook-upload";
import { createClient } from "../../../../lib/supabase/server";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../../lib/tenant/legacy-workforce";
import { privateAttachmentHeaders } from "../../../../lib/shared/private-download";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
interface LooseQuery {
  select(columns: string): LooseQuery;
  eq(column: string, value: string): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  limit(count: number): LooseQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
}
type LooseClient = {
  from(name: string): LooseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: string | null; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  if (profile.role !== "ADMIN_RRHH") return NextResponse.json({ error: "Solo RR. HH. puede confirmar una subida." }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file"); const month = String(form.get("month") ?? ""); const confirm = form.get("confirm") === "true";
  const reason = String(form.get("reason") ?? "").trim(); const expectedBaseVersionId = String(form.get("baseVersionId") ?? "") || null;
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || file.type !== XLSX_MIME) return NextResponse.json({ error: "Selecciona un archivo .xlsx válido, sin macros." }, { status: 400 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "Mes de remuneración inválido." }, { status: 400 });
  if (confirm && !reason) return NextResponse.json({ error: "El motivo general es obligatorio." }, { status: 400 });

  const period = resolvePayrollPeriod(month); const supabase = await createClient();
  try {
    const current = buildAttendanceExportWorkbook(await buildAttendanceExportData(supabase, profile.role, period, ARCOTEX_WORKFORCE_COMPANY_ID));
    const bytes = new Uint8Array(await file.arrayBuffer()); const preview = comparePayrollWorkbooks(current, bytes);
    const loose = supabase as unknown as LooseClient;
    const latest = await loose.from("payroll_workbook_versions").select("id").eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID).eq("period_start", period.startDate).eq("period_end", period.endDate).eq("status", "ACCEPTED").order("version_number", { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw new Error(latest.error.message);
    const latestId = typeof latest.data?.id === "string" ? latest.data.id : null;
    if (!confirm) return NextResponse.json({ baseVersionId: latestId, hash: preview.sha256, changes: preview.changes.slice(0, 500), totalChanges: preview.changes.length });
    if (latestId !== expectedBaseVersionId) return NextResponse.json({ error: "Existe una versión más reciente. Vuelve a comparar antes de confirmar." }, { status: 409 });
    const storagePath = `${ARCOTEX_WORKFORCE_COMPANY_ID}/${period.startDate}_${period.endDate}/${crypto.randomUUID()}.xlsx`;
    const upload = await supabase.storage.from("payroll-workbooks").upload(storagePath, bytes, { contentType: XLSX_MIME, upsert: false });
    if (upload.error) throw new Error(upload.error.message);
    const result = await loose.rpc("register_accepted_payroll_workbook", {
      p_company_id: ARCOTEX_WORKFORCE_COMPANY_ID, p_period_start: period.startDate, p_period_end: period.endDate,
      p_expected_base_version_id: expectedBaseVersionId, p_content_sha256: preview.sha256, p_file_size: bytes.byteLength,
      p_storage_path: storagePath, p_general_reason: reason, p_changes: preview.changes,
    });
    if (result.error || !result.data) throw new Error(result.error?.message ?? "No se creó la versión.");
    return NextResponse.json({ versionId: result.data, hash: preview.sha256, totalChanges: preview.changes.length });
  } catch (error) {
    console.error("[payroll-workbook-upload] fallo controlado", error instanceof Error ? error.message : "error");
    return NextResponse.json({ error: "No pudimos validar o guardar el archivo. Revisa que corresponda a la empresa, período y versión descargada." }, { status: 400 });
  }
}

/** Descarga exacta de una versión aceptada; nunca se regenera ni sobrescribe. */
export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  if (profile.role !== "ADMIN_RRHH" && profile.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Sin permiso para descargar esta versión." }, { status: 403 });
  const versionId = new URL(request.url).searchParams.get("version");
  if (!versionId || !isUuid(versionId)) return NextResponse.json({ error: "Versión inválida." }, { status: 400 });
  const supabase = await createClient(); const loose = supabase as unknown as LooseClient;
  const row = await loose.from("payroll_workbook_versions").select("storage_path, file_size, period_start, period_end").eq("id", versionId).eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID).maybeSingle();
  if (row.error || !row.data || typeof row.data.storage_path !== "string") return NextResponse.json({ error: "Versión no disponible." }, { status: 404 });
  const downloaded = await supabase.storage.from("payroll-workbooks").download(row.data.storage_path);
  if (downloaded.error || !downloaded.data) return NextResponse.json({ error: "No pudimos descargar la versión." }, { status: 500 });
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  const filename = `pre-nomina-${String(row.data.period_start)}-al-${String(row.data.period_end)}-version.xlsx`;
  return new NextResponse(bytes, { headers: privateAttachmentHeaders(filename, bytes.byteLength) });
}
