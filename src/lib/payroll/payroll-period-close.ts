import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerRole } from "../access/scope";
import {
  buildAttendanceExportData,
  buildAttendanceExportWorkbook,
  getAttendanceExportCloseReadiness,
  type AttendanceExportData,
  type AttendanceExportCloseReadiness,
} from "../business-rules/attendance-export";
import { resolvePayrollPeriod } from "../business-rules/attendance-export-periods";
import { finalizePreparedPayrollClose } from "../payroll-close/service";
import type { Database } from "../supabase/database.types";
import { loadAcceptedPayrollWorkbookAdjustments } from "./payroll-workbook-adjustments";

const PAYROLL_WORKBOOK_BUCKET = "payroll-workbooks";
const PAYROLL_WORKBOOK_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_PAYROLL_WORKBOOK_BYTES = 15 * 1024 * 1024;
// El UUID sentinel histórico de ARCOTEX antecede la convención RFC de
// version/variant. Se valida la gramática completa de PostgreSQL UUID sin
// exigir esos dos nibbles para no rechazar la empresa real.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReportingPeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  status: Database["public"]["Enums"]["reporting_period_status"];
  closed_at: string | null;
}

interface AcceptedWorkbookRow {
  id: string;
  content_sha256: string;
  file_size: number;
  storage_path: string;
}

interface ClosedSnapshotRow {
  id: string;
  content_sha256: string;
  file_size: number;
  base_version_id: string | null;
  closed_snapshot_at: string | null;
}

interface LooseError {
  code?: string;
  message: string;
}

interface LooseListResult {
  data: Record<string, unknown>[] | null;
  error: LooseError | null;
}

interface LooseQuery extends PromiseLike<LooseListResult> {
  select(columns: string): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  limit(count: number): LooseQuery;
  is(column: string, value: null): LooseQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: LooseError | null }>;
}

interface PayrollCloseClient {
  from(name: string): LooseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: LooseError | null }>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        bytes: Uint8Array,
        options: { contentType: string; upsert: false; metadata: Record<string, string> }
      ): Promise<{ error: LooseError | null }>;
      remove(paths: string[]): Promise<{ error: LooseError | null }>;
    };
  };
}

export interface ClosePayrollPeriodInput {
  companyId: string;
  reportingPeriodId: string;
  callerRole: CallerRole;
}

export interface ClosePayrollPeriodResult {
  snapshotVersionId: string;
  contentSha256: string;
  fileSize: number;
}

export class PayrollPeriodCloseBlockedError extends Error {
  constructor(
    message: string,
    readonly pendingCount: number,
    readonly issues: readonly string[]
  ) {
    super(message);
    this.name = "PayrollPeriodCloseBlockedError";
  }
}

export interface PayrollPeriodCloseDependencies {
  buildExportData: typeof buildAttendanceExportData;
  buildWorkbook: typeof buildAttendanceExportWorkbook;
  getReadiness(data: AttendanceExportData): AttendanceExportCloseReadiness;
  loadAdjustments: typeof loadAcceptedPayrollWorkbookAdjustments;
  finalizePreparedClose: typeof finalizePreparedPayrollClose;
  randomUuid(): string;
}

const DEFAULT_DEPENDENCIES: PayrollPeriodCloseDependencies = {
  buildExportData: buildAttendanceExportData,
  buildWorkbook: buildAttendanceExportWorkbook,
  getReadiness: getAttendanceExportCloseReadiness,
  loadAdjustments: loadAcceptedPayrollWorkbookAdjustments,
  finalizePreparedClose: finalizePreparedPayrollClose,
  randomUuid: () => crypto.randomUUID(),
};

function asReportingPeriod(row: Record<string, unknown> | null): ReportingPeriodRow | null {
  if (
    typeof row?.id !== "string" ||
    typeof row.period_start !== "string" ||
    typeof row.period_end !== "string" ||
    typeof row.status !== "string" ||
    !(typeof row.closed_at === "string" || row.closed_at === null)
  ) {
    return null;
  }
  return row as unknown as ReportingPeriodRow;
}

function asAcceptedWorkbook(row: Record<string, unknown> | null): AcceptedWorkbookRow | null {
  if (
    typeof row?.id !== "string" ||
    typeof row.content_sha256 !== "string" ||
    typeof row.file_size !== "number" ||
    typeof row.storage_path !== "string"
  ) {
    return null;
  }
  return row as unknown as AcceptedWorkbookRow;
}

function asClosedSnapshot(row: Record<string, unknown> | null): ClosedSnapshotRow | null {
  if (
    typeof row?.id !== "string" ||
    typeof row.content_sha256 !== "string" ||
    typeof row.file_size !== "number" ||
    !(typeof row.base_version_id === "string" || row.base_version_id === null) ||
    !(typeof row.closed_snapshot_at === "string" || row.closed_snapshot_at === null)
  ) {
    return null;
  }
  return row as unknown as ClosedSnapshotRow;
}

async function readSourceRevision(client: PayrollCloseClient, companyId: string): Promise<number> {
  const result = await client.rpc("get_payroll_source_revision", { p_company_id: companyId });
  const revision = typeof result.data === "number" ? result.data : Number(result.data);
  if (result.error || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("No pudimos fijar la revisión vigente de los datos de pago.");
  }
  return revision;
}

function closeBlocked(readiness: AttendanceExportCloseReadiness): PayrollPeriodCloseBlockedError {
  const visibleIssues = readiness.issues.slice(0, 5);
  const detail = visibleIssues.length > 0 ? ` ${visibleIssues.join(" | ")}` : "";
  return new PayrollPeriodCloseBlockedError(
    `El período no se puede cerrar: ${readiness.pendingCount === 1 ? "queda" : "quedan"} ${readiness.pendingCount} ${readiness.pendingCount === 1 ? "incidencia o alerta por resolver" : "incidencias o alertas por resolver"}.${detail}`,
    readiness.pendingCount,
    readiness.issues
  );
}

function safeCommitError(error: LooseError | null): Error {
  if (error?.message.toLowerCase().includes("segundo factor") || error?.message.toLowerCase().includes("mfa")) {
    return new Error("Esta operación requiere verificación de segundo factor (MFA).");
  }
  if (error?.code === "40001" || error?.message.toLowerCase().includes("cambió")) {
    return new Error("El período o la pre-nómina cambió durante el cierre. Recarga y vuelve a comprobarlo.");
  }
  if (error?.code === "42501") {
    return new Error("No tienes autorización vigente para cerrar este período.");
  }
  return new Error("No pudimos confirmar el snapshot y cerrar el período. El período permanece sin cerrar.");
}

function errorLike(error: unknown): LooseError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.message !== "string") return null;
  return {
    message: candidate.message,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
  };
}

async function discardOrphan(
  client: PayrollCloseClient,
  operationId: string,
  storagePath: string
): Promise<void> {
  const aborted = await client.rpc("abort_payroll_period_close", { p_operation_id: operationId });
  if (aborted.error) {
    console.error("[payroll-period-close] no se pudo abortar la reserva", aborted.error.message);
  }
  const removal = await client.storage.from(PAYROLL_WORKBOOK_BUCKET).remove([storagePath]);
  if (removal.error) {
    // La policy solo permite eliminar un objeto propio que todavía no esté
    // referenciado. Si el resultado del RPC fue incierto pero alcanzó a
    // confirmar, este intento falla de manera segura y conserva el snapshot.
    console.error("[payroll-period-close] no se pudo limpiar el objeto huérfano", removal.error.message);
  }
}

/**
 * Cierra un período conservando dos evidencias inmutables y distintas:
 * la versión ACCEPTED exacta que subió RR. HH. y un CLOSED_SNAPSHOT canónico
 * recalculado desde Workera, con esa versión como base y sus ajustes aplicados.
 *
 * Storage no comparte transacción con Postgres: una reserva breve autoriza la
 * ruta, el objeto se sube inmutable, una frontera server-only verifica sus
 * bytes y el RPC final confirma snapshot + estado + log. Toda falla aborta la
 * reserva antes de compensar solo ese objeto; la RLS impide borrar una ruta
 * que siga preparada o que el commit ya haya referenciado.
 */
export async function closePayrollPeriodWithSnapshot(
  supabase: SupabaseClient<Database>,
  input: ClosePayrollPeriodInput,
  dependencies: PayrollPeriodCloseDependencies = DEFAULT_DEPENDENCIES
): Promise<ClosePayrollPeriodResult> {
  if (input.callerRole !== "ADMIN_RRHH") {
    throw new Error("Solo RR. HH. puede cerrar un período de pago.");
  }
  if (!UUID_PATTERN.test(input.companyId) || !UUID_PATTERN.test(input.reportingPeriodId)) {
    throw new Error("El identificador de empresa o período no es válido.");
  }

  const client = supabase as unknown as PayrollCloseClient;
  const periodResult = await client
    .from("reporting_periods")
    .select("id, period_start, period_end, status, closed_at")
    .eq("id", input.reportingPeriodId)
    .maybeSingle();
  const periodRow = asReportingPeriod(periodResult.data);
  if (periodResult.error || !periodRow) {
    throw new Error("El período no está disponible para la empresa activa.");
  }
  if (periodRow.status === "CLOSED") {
    const existing = await client
      .from("payroll_workbook_versions")
      .select("id, content_sha256, file_size, base_version_id, closed_snapshot_at")
      .eq("company_id", input.companyId)
      .eq("reporting_period_id", input.reportingPeriodId)
      .eq("status", "CLOSED_SNAPSHOT")
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const snapshot = asClosedSnapshot(existing.data);
    if (
      !existing.error &&
      snapshot &&
      UUID_PATTERN.test(snapshot.id) &&
      snapshot.closed_snapshot_at === periodRow.closed_at
    ) {
      return {
        snapshotVersionId: snapshot.id,
        contentSha256: snapshot.content_sha256,
        fileSize: snapshot.file_size,
      };
    }
  }
  if (periodRow.status !== "READY_TO_CLOSE") {
    throw new PayrollPeriodCloseBlockedError(
      "El período debe estar Aprobado por RR. HH. antes del cierre.",
      0,
      ["El estado actual ya no corresponde a Aprobado por RR. HH."]
    );
  }

  const payrollMonth = periodRow.period_end.slice(0, 7);
  const period = resolvePayrollPeriod(payrollMonth);
  if (period.startDate !== periodRow.period_start || period.endDate !== periodRow.period_end) {
    throw new PayrollPeriodCloseBlockedError(
      "El cierre final exige un período de pago exacto 16-15.",
      0,
      ["El rango configurado no corresponde al ciclo de remuneraciones 16-15."]
    );
  }

  const sourceRevisionBefore = await readSourceRevision(client, input.companyId);
  const latest = await client
    .from("payroll_workbook_versions")
    .select("id, content_sha256, file_size, storage_path")
    .eq("company_id", input.companyId)
    .eq("reporting_period_id", input.reportingPeriodId)
    .eq("status", "ACCEPTED")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestAccepted = asAcceptedWorkbook(latest.data);
  if (latest.error || !latestAccepted) {
    throw new PayrollPeriodCloseBlockedError(
      "Debes confirmar una versión de pre-nómina antes de cerrar.",
      0,
      ["No existe una versión ACCEPTED vigente para este período."]
    );
  }
  const latestAcceptedVersionId = latestAccepted.id;

  let data: AttendanceExportData;
  let adjustments: Awaited<ReturnType<typeof loadAcceptedPayrollWorkbookAdjustments>>;
  try {
    let openConflicts: LooseListResult;
    [data, adjustments, openConflicts] = await Promise.all([
      dependencies.buildExportData(supabase, input.callerRole, period, input.companyId),
      dependencies.loadAdjustments(supabase, {
        companyId: input.companyId,
        periodStart: period.startDate,
        periodEnd: period.endDate,
      }),
      client
        .from("payroll_workbook_conflicts")
        .select("id")
        .eq("company_id", input.companyId)
        .eq("reporting_period_id", input.reportingPeriodId)
        .is("resolved_at", null)
        .limit(1),
    ]);
    if (openConflicts.error) throw new Error(openConflicts.error.message);
    if ((openConflicts.data ?? []).length > 0) {
      throw new PayrollPeriodCloseBlockedError(
        "El período conserva conflictos Workera/RR. HH. sin resolver.",
        openConflicts.data?.length ?? 1,
        ["Resuelve los conflictos persistidos antes de cerrar."]
      );
    }
  } catch (error) {
    if (error instanceof PayrollPeriodCloseBlockedError) throw error;
    console.error(
      "[payroll-period-close] fallo recalculando la pre-nómina",
      error instanceof Error ? error.message : "error desconocido"
    );
    throw new Error("No pudimos recalcular la pre-nómina para comprobar el cierre.");
  }
  data.workbookBaseVersionId = latestAcceptedVersionId;
  data.workbookAdjustments = adjustments;

  const readiness = dependencies.getReadiness(data);
  if (!readiness.ready || readiness.pendingCount > 0 || readiness.issues.length > 0) {
    throw closeBlocked(readiness);
  }

  // El gate se evalúa contra READY_TO_CLOSE. Solo después se presenta el
  // libro que quedará congelado como CERRADO; el RPC confirma que el estado
  // esperado sigue vigente antes de persistirlo.
  const snapshotData: AttendanceExportData = { ...data, reportingPeriodStatus: "CLOSED" };
  let rawBytes: Uint8Array;
  try {
    rawBytes = dependencies.buildWorkbook(snapshotData);
  } catch (error) {
    console.error(
      "[payroll-period-close] fallo generando el snapshot Excel",
      error instanceof Error ? error.message : "error desconocido"
    );
    throw new Error("No pudimos generar el snapshot Excel. El período permanece sin cerrar.");
  }
  const bytes = rawBytes;
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PAYROLL_WORKBOOK_BYTES) {
    throw new Error("El snapshot Excel quedó vacío o supera el máximo permitido de 15 MB.");
  }

  const contentSha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const sourceRevisionAfter = await readSourceRevision(client, input.companyId);
  if (sourceRevisionAfter !== sourceRevisionBefore) {
    throw new Error("Los datos de pago cambiaron mientras se generaba el snapshot. Recarga y vuelve a comprobarlo.");
  }

  const operationId = dependencies.randomUuid();
  if (!UUID_PATTERN.test(operationId)) throw new Error("No pudimos crear una ruta segura para el snapshot.");
  const storagePath = [
    input.companyId,
    `${period.startDate}_${period.endDate}`,
    "closed",
    input.reportingPeriodId,
    `${operationId}.xlsx`,
  ].join("/");

  const prepared = await client.rpc("prepare_payroll_period_close", {
    p_operation_id: operationId,
    p_company_id: input.companyId,
    p_reporting_period_id: input.reportingPeriodId,
    p_expected_status: "READY_TO_CLOSE",
    p_expected_base_version_id: latestAcceptedVersionId,
    p_expected_source_revision: sourceRevisionAfter,
    p_content_sha256: contentSha256,
    p_file_size: bytes.byteLength,
    p_storage_path: storagePath,
  });
  if (prepared.error || prepared.data !== operationId) {
    throw safeCommitError(prepared.error);
  }

  const upload = await client.storage.from(PAYROLL_WORKBOOK_BUCKET).upload(storagePath, bytes, {
    contentType: PAYROLL_WORKBOOK_MIME,
    upsert: false,
    metadata: {
      artifact_kind: "CLOSED_SNAPSHOT",
      content_sha256: contentSha256,
      reporting_period_id: input.reportingPeriodId,
      period_start: period.startDate,
      period_end: period.endDate,
      operation_id: operationId,
      base_version_id: latestAcceptedVersionId,
      source_revision: String(sourceRevisionAfter),
    },
  });
  if (upload.error) {
    await discardOrphan(client, operationId, storagePath);
    throw new Error("No pudimos guardar el snapshot Excel privado. El período permanece sin cerrar.");
  }

  let snapshotVersionId: string;
  try {
    snapshotVersionId = await dependencies.finalizePreparedClose({
      operationId,
      storagePath,
      expectedContentSha256: contentSha256,
      expectedFileSize: bytes.byteLength,
    });
  } catch (error) {
    await discardOrphan(client, operationId, storagePath);
    throw safeCommitError(errorLike(error));
  }
  if (!UUID_PATTERN.test(snapshotVersionId)) {
    await discardOrphan(client, operationId, storagePath);
    throw new Error("No pudimos confirmar el identificador del snapshot de cierre.");
  }

  return {
    snapshotVersionId,
    contentSha256,
    fileSize: bytes.byteLength,
  };
}
