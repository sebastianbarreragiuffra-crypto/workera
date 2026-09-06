import { NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getCurrentProfile } from "../../../../lib/auth/session";
import {
  assertSecondFactorForPrivileged,
  MfaRequiredError,
} from "../../../../lib/auth/mfa-account";
import {
  buildAttendanceExportData,
  buildAttendanceExportWorkbook,
  payrollWorkbookConflicts,
  type PayrollWorkbookConflictPreview,
} from "../../../../lib/business-rules/attendance-export";
import {
  resolvePayrollPeriod,
  resolveWorkbookPeriodIdentity,
  workbookWindowType,
  type AttendanceExportPeriod,
} from "../../../../lib/business-rules/attendance-export-periods";
import {
  comparePayrollWorkbooks,
  applyPayrollWorkbookConflictResolutions,
  expandPayrollWorkbookBusinessChanges,
  parsePayrollWorkbook,
  PAYROLL_WORKBOOK_LIMITS,
  validatePayrollWorkbookBusinessChanges,
  type PayrollWorkbookChange,
  type PayrollWorkbookConflictResolution,
} from "../../../../lib/payroll/payroll-workbook-upload";
import { createClient } from "../../../../lib/supabase/server";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../../lib/tenant/legacy-workforce";
import { privateAttachmentHeaders } from "../../../../lib/shared/private-download";
import {
  authorizeWorkforceDataAccess,
  workforceDataAccessFailureResponse,
} from "../../../../lib/decisions/workforce-data-access";
import { loadAcceptedPayrollWorkbookAdjustments } from "../../../../lib/payroll/payroll-workbook-adjustments";
import {
  acceptTrustedPayrollWorkbook,
  removeUnregisteredPayrollWorkbook,
} from "../../../../lib/payroll-workbook/service";
import { resolvePayrollCompanyRole } from "../../../../lib/payroll/payroll-company-role";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_REVIEWABLE_CHANGES = 500;
const MAX_MULTIPART_OVERHEAD = 1_048_576;
const PREVIEW_MAX_AGE_MS = 15 * 60 * 1_000;
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
interface LooseListResponse {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
}
interface LooseQuery extends PromiseLike<LooseListResponse> {
  select(columns: string): LooseQuery;
  eq(column: string, value: string): LooseQuery;
  in(column: string, values: readonly string[]): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  limit(count: number): LooseQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
}
type LooseClient = {
  from(name: string): LooseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
};

export function payrollWorkbookPreviewToken(input: {
  baseVersionId: string | null;
  sourceRevision: number;
  uploadedSha256: string;
  changes: PayrollWorkbookChange[];
  conflicts?: PayrollWorkbookConflictPreview[];
}, signingSecret: string, actorId: string, issuedAt: number): string {
  return createHmac("sha256", signingSecret)
    .update(JSON.stringify({ ...input, actorId, issuedAt }))
    .digest("hex");
}

async function readPayrollSourceRevision(loose: LooseClient): Promise<number> {
  const result = await loose.rpc("get_payroll_source_revision", {
    p_company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
  });
  const revision = typeof result.data === "number" ? result.data : Number(result.data);
  if (result.error || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("No se pudo fijar la revisión de datos de pago.");
  }
  return revision;
}

function previewSigningSecret(): string {
  const secret = process.env.PAYROLL_WORKBOOK_PREVIEW_SECRET;
  if (!secret || secret.length < 32) throw new Error("PAYROLL_WORKBOOK_PREVIEW_SECRET no está configurado de forma segura.");
  return secret;
}

function equalToken(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export function resolveSubmittedWorkbookPeriod(input: {
  periodType: string;
  periodStart: string;
  periodEnd: string;
  legacyMonth?: string;
}): AttendanceExportPeriod {
  if (!input.periodType && /^\d{4}-(0[1-9]|1[0-2])$/.test(input.legacyMonth ?? "")) {
    return resolvePayrollPeriod(input.legacyMonth!);
  }
  if (!["DIARIO", "SEMANAL", "QUINCENAL", "PAGO"].includes(input.periodType)) {
    throw new Error("La frecuencia del archivo no es válida.");
  }
  return resolveWorkbookPeriodIdentity({
    periodType: input.periodType as "DIARIO" | "SEMANAL" | "QUINCENAL" | "PAGO",
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
}

/** Lee el stream con un límite antes de invocar formData(), incluso sin Content-Length. */
export async function requestWithLimitedBody(request: Request, maxBytes: number): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("PAYROLL_MULTIPART_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** Multipart inválido es una entrada de cliente, no una falla interna. */
export async function parsePayrollMultipart(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const supabase = await createClient();
  const payrollRole = await resolvePayrollCompanyRole(
    supabase as unknown as Parameters<typeof resolvePayrollCompanyRole>[0],
    ARCOTEX_WORKFORCE_COMPANY_ID,
    ["ADMIN_RRHH"],
  );
  if (payrollRole !== "ADMIN_RRHH") return NextResponse.json({ error: "Solo RR. HH. puede confirmar una subida." }, { status: 403 });
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > PAYROLL_WORKBOOK_LIMITS.maxBytes + 1_048_576) {
    return NextResponse.json({ error: "El archivo supera el máximo permitido." }, { status: 413 });
  }
  let boundedRequest: Request;
  try {
    boundedRequest = await requestWithLimitedBody(request, PAYROLL_WORKBOOK_LIMITS.maxBytes + MAX_MULTIPART_OVERHEAD);
  } catch {
    return NextResponse.json({ error: "El cuerpo de la subida supera el máximo permitido." }, { status: 413 });
  }
  const form = await parsePayrollMultipart(boundedRequest);
  if (!form) return NextResponse.json({ error: "El formulario de subida no es válido." }, { status: 400 });
  const file = form.get("file"); const legacyMonth = String(form.get("month") ?? ""); const confirm = form.get("confirm") === "true";
  let period: AttendanceExportPeriod;
  try {
    period = resolveSubmittedWorkbookPeriod({
      periodType: String(form.get("periodType") ?? ""),
      periodStart: String(form.get("periodStart") ?? ""),
      periodEnd: String(form.get("periodEnd") ?? ""),
      legacyMonth,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "El período no es válido." }, { status: 400 });
  }
  const windowType = workbookWindowType(period);
  const reason = String(form.get("reason") ?? "").trim(); const expectedBaseVersionId = String(form.get("baseVersionId") ?? "") || null;
  const expectedPreviewToken = String(form.get("previewToken") ?? "");
  const expectedUploadedHash = String(form.get("uploadedHash") ?? "");
  const previewIssuedAt = Number(form.get("previewIssuedAt") ?? "0");
  let conflictResolutions: PayrollWorkbookConflictResolution[] = [];
  try {
    const parsed = JSON.parse(String(form.get("conflictResolutions") ?? "[]")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("invalid");
    conflictResolutions = parsed as PayrollWorkbookConflictResolution[];
  } catch {
    return NextResponse.json({ error: "Las resoluciones de conflicto no son válidas." }, { status: 400 });
  }
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || file.type !== XLSX_MIME) return NextResponse.json({ error: "Selecciona un archivo .xlsx válido, sin macros." }, { status: 400 });
  if (file.size > PAYROLL_WORKBOOK_LIMITS.maxBytes) return NextResponse.json({ error: "El archivo supera 15 MB." }, { status: 413 });
  if (confirm && !reason) return NextResponse.json({ error: "El motivo general es obligatorio." }, { status: 400 });

  const access = await authorizeWorkforceDataAccess(supabase, {
    scope: "attendance.export",
    period,
  });
  if (access.status !== "ALLOWED") return workforceDataAccessFailureResponse(access)!;
  let uploadedStoragePath: string | null = null;
  let versionRegistered = false;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = parsePayrollWorkbook(bytes);
    const loose = supabase as unknown as LooseClient;
    const sourceRevisionBefore = await readPayrollSourceRevision(loose);
    const latestScope = loose
      .from(windowType === "MENSUAL" ? "payroll_workbook_versions" : "payroll_working_versions")
      .select("id")
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .eq("period_start", period.startDate)
      .eq("period_end", period.endDate);
    const latest = await (windowType === "MENSUAL"
      ? latestScope.eq("status", "ACCEPTED")
      : latestScope.eq("window_type", windowType))
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw new Error(latest.error.message);
    const latestId = typeof latest.data?.id === "string" ? latest.data.id : null;
    const expectedWorkbookBase = latestId ?? "ORIGEN_ACTUAL";
    if (uploaded.identity.baseVersion !== expectedWorkbookBase) {
      return NextResponse.json({ error: "La descarga base ya no es la vigente. Descarga nuevamente antes de comparar." }, { status: 409 });
    }
    const expectedPayrollMonth = period.type === "PAGO" ? period.endDate.slice(0, 7) : "";
    if (uploaded.identity.periodType !== period.type
        || uploaded.identity.payrollMonth !== expectedPayrollMonth
        || uploaded.identity.periodStart !== period.startDate
        || uploaded.identity.periodEnd !== period.endDate) {
      return NextResponse.json({ error: "El archivo no corresponde al período seleccionado." }, { status: 409 });
    }
    if ("companyId" in uploaded.identity && uploaded.identity.companyId !== ARCOTEX_WORKFORCE_COMPANY_ID) {
      return NextResponse.json({ error: "El archivo no corresponde a la empresa activa." }, { status: 409 });
    }
    const data = await buildAttendanceExportData(supabase, payrollRole, period, ARCOTEX_WORKFORCE_COMPANY_ID);
    data.workbookBaseVersionId = latestId;
    data.workbookAdjustments = await loadAcceptedPayrollWorkbookAdjustments(supabase, {
      companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
      windowType,
      periodStart: period.startDate,
      periodEnd: period.endDate,
    });
    const current = buildAttendanceExportWorkbook(data);
    const rawPreview = comparePayrollWorkbooks(current, bytes);
    const conflicts = payrollWorkbookConflicts(data);
    const rawChanges = expandPayrollWorkbookBusinessChanges(current, rawPreview.changes);
    const preview = {
      ...rawPreview,
      changes: confirm
        ? applyPayrollWorkbookConflictResolutions(current, rawChanges, conflicts, conflictResolutions)
        : rawChanges,
      conflicts,
    };
    const sourceRevision = await readPayrollSourceRevision(loose);
    if (sourceRevision !== sourceRevisionBefore) {
      return NextResponse.json({ error: "Los datos de Workera cambiaron durante la comparación. Vuelve a comparar." }, { status: 409 });
    }
    if (preview.changes.length > MAX_REVIEWABLE_CHANGES) {
      return NextResponse.json({ error: `El archivo contiene ${preview.changes.length} cambios; el máximo revisable por subida es ${MAX_REVIEWABLE_CHANGES}.` }, { status: 422 });
    }
    const businessIssues = validatePayrollWorkbookBusinessChanges(current, preview.changes);
    if (businessIssues.length > 0) {
      return NextResponse.json({ error: "Hay ajustes empresariales inválidos.", issues: businessIssues }, { status: 422 });
    }
    const issuedAt = confirm ? previewIssuedAt : Date.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Date.now() + 60_000 || Date.now() - issuedAt > PREVIEW_MAX_AGE_MS) {
      return NextResponse.json({ error: "La vista previa venció. Compara nuevamente antes de confirmar." }, { status: 409 });
    }
    const previewToken = payrollWorkbookPreviewToken({
      baseVersionId: latestId,
      sourceRevision,
      uploadedSha256: preview.sha256,
      changes: rawChanges,
      conflicts,
    }, previewSigningSecret(), profile.id, issuedAt);
    if (!confirm) return NextResponse.json({ baseVersionId: latestId, sourceRevision, hash: preview.sha256, previewToken, previewIssuedAt: issuedAt, changes: preview.changes, conflicts, totalChanges: preview.changes.length });
    if (latestId !== expectedBaseVersionId) return NextResponse.json({ error: "Existe una versión más reciente. Vuelve a comparar antes de confirmar." }, { status: 409 });
    if (expectedUploadedHash !== preview.sha256 || !equalToken(previewToken, expectedPreviewToken)) {
      return NextResponse.json({ error: "El archivo o los datos base cambiaron después de la vista previa. Compara nuevamente." }, { status: 409 });
    }
    // La frontera service_role reconstruye los claims mínimos del actor para
    // reutilizar las validaciones SQL antiguas. Solo se cruza después de que
    // la sesión real demostró su segundo factor en esta misma petición.
    await assertSecondFactorForPrivileged(supabase);
    uploadedStoragePath = `${ARCOTEX_WORKFORCE_COMPANY_ID}/${period.startDate}_${period.endDate}/${crypto.randomUUID()}.xlsx`;
    const upload = await supabase.storage.from("payroll-workbooks").upload(uploadedStoragePath, bytes, { contentType: XLSX_MIME, upsert: false });
    if (upload.error) throw new Error(upload.error.message);
    const accepted = await acceptTrustedPayrollWorkbook({
      actorId: profile.id,
      companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
      windowType,
      periodStart: period.startDate,
      periodEnd: period.endDate,
      expectedBaseVersionId,
      expectedSourceRevision: sourceRevision,
      contentSha256: preview.sha256,
      fileSize: bytes.byteLength,
      storagePath: uploadedStoragePath,
      generalReason: reason,
      changes: preview.changes,
    });
    versionRegistered = true;
    const stored = await loose
      .from(windowType === "MENSUAL" ? "payroll_workbook_versions" : "payroll_working_versions")
      .select("storage_path")
      .eq("id", accepted.versionId)
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .maybeSingle();
    if (stored.error) throw new Error(stored.error.message);
    if (stored.data?.storage_path !== uploadedStoragePath) {
      try {
        await removeUnregisteredPayrollWorkbook({
          companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
          periodStart: period.startDate,
          periodEnd: period.endDate,
          storagePath: uploadedStoragePath,
        });
      } catch (cleanupError) {
        console.error(
          "[payroll-workbook-upload] no se pudo limpiar una subida idempotente",
          cleanupError instanceof Error ? cleanupError.message : "error",
        );
      }
    }
    uploadedStoragePath = null;
    return NextResponse.json({ versionId: accepted.versionId, hash: accepted.contentSha256, totalChanges: preview.changes.length });
  } catch (error) {
    if (uploadedStoragePath && !versionRegistered) {
      try {
        await removeUnregisteredPayrollWorkbook({
          companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
          periodStart: period.startDate,
          periodEnd: period.endDate,
          storagePath: uploadedStoragePath,
        });
      } catch (cleanupError) {
        console.error(
          "[payroll-workbook-upload] no se pudo limpiar una subida fallida",
          cleanupError instanceof Error ? cleanupError.message : "error",
        );
      }
    }
    if (error instanceof MfaRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[payroll-workbook-upload] fallo controlado", error instanceof Error ? error.message : "error");
    return NextResponse.json({ error: "No pudimos validar o guardar el archivo. Revisa que corresponda a la empresa, período y versión descargada." }, { status: 400 });
  }
}

/** Descarga exacta de una versión aceptada; nunca se regenera ni sobrescribe. */
export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const supabase = await createClient();
  const payrollRole = await resolvePayrollCompanyRole(
    supabase as unknown as Parameters<typeof resolvePayrollCompanyRole>[0],
    ARCOTEX_WORKFORCE_COMPANY_ID,
    ["ADMIN_RRHH", "SUPER_ADMIN"],
  );
  if (!payrollRole) return NextResponse.json({ error: "Sin permiso para descargar esta versión." }, { status: 403 });
  const searchParams = new URL(request.url).searchParams;
  const versionId = searchParams.get("version");
  const loose = supabase as unknown as LooseClient;
  if (!versionId) {
    let period: AttendanceExportPeriod;
    try {
      period = resolveSubmittedWorkbookPeriod({
        periodType: searchParams.get("periodType") ?? "",
        periodStart: searchParams.get("periodStart") ?? "",
        periodEnd: searchParams.get("periodEnd") ?? "",
        legacyMonth: searchParams.get("month") ?? "",
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "El período no es válido." }, { status: 400 });
    }
    const windowType = workbookWindowType(period);
    const access = await authorizeWorkforceDataAccess(supabase, { scope: "attendance.export", period });
    if (access.status !== "ALLOWED") return workforceDataAccessFailureResponse(access)!;
    const history = loose
      .from(windowType === "MENSUAL" ? "payroll_workbook_versions" : "payroll_working_versions")
      .select(windowType === "MENSUAL"
        ? "id, version_number, base_version_id, status, content_sha256, file_size, general_reason, accepted_at, accepted_by, closed_snapshot_at"
        : "id, version_number, base_version_id, content_sha256, file_size, general_reason, accepted_at, accepted_by")
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .eq("period_start", period.startDate)
      .eq("period_end", period.endDate);
    const rows = await (windowType === "MENSUAL"
      ? history.in("status", ["ACCEPTED", "CLOSED_SNAPSHOT"])
      : history.eq("window_type", windowType))
      .order("version_number", { ascending: false })
      .limit(20);
    if (rows.error) return NextResponse.json({ error: "No pudimos cargar el historial." }, { status: 500 });
    return NextResponse.json({
      versions: (rows.data ?? []).map((row) => windowType === "MENSUAL"
        ? { ...row, scope: "monthly" }
        : { ...row, status: "ACCEPTED", closed_snapshot_at: null, scope: "working" }),
    });
  }
  if (!isUuid(versionId)) return NextResponse.json({ error: "Versión inválida." }, { status: 400 });
  const workingScope = searchParams.get("scope") === "working";
  const versionQuery = loose
    .from(workingScope ? "payroll_working_versions" : "payroll_workbook_versions")
    .select(workingScope
      ? "storage_path, file_size, period_start, period_end, content_sha256, window_type"
      : "storage_path, file_size, period_start, period_end, content_sha256, status")
    .eq("id", versionId)
    .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID);
  const row = await (workingScope
    ? versionQuery
    : versionQuery.in("status", ["ACCEPTED", "CLOSED_SNAPSHOT"]))
    .maybeSingle();
  if (row.error || !row.data || typeof row.data.storage_path !== "string") return NextResponse.json({ error: "Versión no disponible." }, { status: 404 });
  const period = {
    type: (workingScope ? String(row.data.window_type) : "PAGO") as "DIARIO" | "SEMANAL" | "QUINCENAL" | "PAGO",
    startDate: String(row.data.period_start),
    endDate: String(row.data.period_end),
    label: `Pre-nómina ${String(row.data.period_start)} al ${String(row.data.period_end)}`,
  };
  const access = await authorizeWorkforceDataAccess(supabase, { scope: "attendance.export", period });
  if (access.status !== "ALLOWED") return workforceDataAccessFailureResponse(access)!;
  const downloaded = await supabase.storage.from("payroll-workbooks").download(row.data.storage_path);
  if (downloaded.error || !downloaded.data) return NextResponse.json({ error: "No pudimos descargar la versión." }, { status: 500 });
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== row.data.content_sha256 || bytes.byteLength !== Number(row.data.file_size)) {
    console.error("[payroll-workbook-download] hash o tamaño de Storage no coincide con la versión", versionId);
    return NextResponse.json({ error: "La versión no superó la verificación de integridad." }, { status: 500 });
  }
  const artifactLabel = !workingScope && row.data.status === "CLOSED_SNAPSHOT" ? "cierre" : "version";
  const filename = `pre-nomina-${String(row.data.period_start)}-al-${String(row.data.period_end)}-${artifactLabel}.xlsx`;
  return new NextResponse(bytes, { headers: privateAttachmentHeaders(filename, bytes.byteLength, { limit: access.requestLimit, remaining: access.remaining }) });
}
