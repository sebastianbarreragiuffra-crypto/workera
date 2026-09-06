import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerRole } from "../access/scope";
import {
  buildAttendanceExportData,
  getAttendanceExportCloseReadiness,
  type AttendanceExportData,
  type AttendanceExportCloseReadiness,
} from "../business-rules/attendance-export";
import { resolvePayrollPeriod } from "../business-rules/attendance-export-periods";
import { commitPayrollPeriodApproval } from "../payroll-close/approval-service";
import type { Database } from "../supabase/database.types";
import { loadAcceptedPayrollWorkbookAdjustments } from "./payroll-workbook-adjustments";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApprovalPeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  status: Database["public"]["Enums"]["reporting_period_status"];
}

interface LooseError { code?: string; message: string }
interface LooseListResult { data: Record<string, unknown>[] | null; error: LooseError | null }
interface LooseQuery extends PromiseLike<LooseListResult> {
  select(columns: string): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  limit(count: number): LooseQuery;
  is(column: string, value: null): LooseQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: LooseError | null }>;
}
interface ApprovalClient {
  from(name: string): LooseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: LooseError | null }>;
}

export interface ApprovePayrollPeriodInput {
  actorId: string;
  companyId: string;
  reportingPeriodId: string;
  from: "IN_REVIEW" | "REOPENED";
  callerRole: CallerRole;
}

export interface ApprovePayrollPeriodDependencies {
  buildExportData: typeof buildAttendanceExportData;
  getReadiness(data: AttendanceExportData): AttendanceExportCloseReadiness;
  loadAdjustments: typeof loadAcceptedPayrollWorkbookAdjustments;
  commitApproval: typeof commitPayrollPeriodApproval;
}

const DEFAULT_DEPENDENCIES: ApprovePayrollPeriodDependencies = {
  buildExportData: buildAttendanceExportData,
  getReadiness: getAttendanceExportCloseReadiness,
  loadAdjustments: loadAcceptedPayrollWorkbookAdjustments,
  commitApproval: commitPayrollPeriodApproval,
};

export class PayrollPeriodApprovalBlockedError extends Error {
  constructor(
    message: string,
    readonly pendingCount: number,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "PayrollPeriodApprovalBlockedError";
  }
}

function asPeriod(row: Record<string, unknown> | null): ApprovalPeriodRow | null {
  if (
    typeof row?.id !== "string"
    || typeof row.period_start !== "string"
    || typeof row.period_end !== "string"
    || typeof row.status !== "string"
  ) return null;
  return row as unknown as ApprovalPeriodRow;
}

function approvalBlocked(readiness: AttendanceExportCloseReadiness): PayrollPeriodApprovalBlockedError {
  const detail = readiness.issues.slice(0, 5).join(" | ");
  return new PayrollPeriodApprovalBlockedError(
    `No se puede aprobar: quedan ${readiness.pendingCount} incidencia(s) o alertas por resolver.${detail ? ` ${detail}` : ""}`,
    readiness.pendingCount,
    readiness.issues,
  );
}

function readinessDigest(input: {
  companyId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  sourceRevision: number;
  acceptedVersionId: string;
  readiness: AttendanceExportCloseReadiness;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Recalcula la misma cola que usa el cierre, reaplica los ajustes aceptados y
 * solo después solicita el cambio atómico a “Aprobado por RR. HH.”. La
 * revisión MVCC impide que una mutación concurrente quede aprobada con una
 * comprobación antigua.
 */
export async function approvePayrollPeriodReady(
  supabase: SupabaseClient<Database>,
  input: ApprovePayrollPeriodInput,
  dependencies: ApprovePayrollPeriodDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ approvalId: string; sourceRevision: number; acceptedVersionId: string }> {
  if (input.callerRole !== "ADMIN_RRHH") {
    throw new Error("Solo RR. HH. puede aprobar una pre-nómina.");
  }
  if (input.from !== "IN_REVIEW" && input.from !== "REOPENED") {
    throw new Error("El estado de origen no admite aprobación final.");
  }
  if (
    !UUID_PATTERN.test(input.actorId)
    || !UUID_PATTERN.test(input.companyId)
    || !UUID_PATTERN.test(input.reportingPeriodId)
  ) {
    throw new Error("La identidad de la aprobación no es válida.");
  }

  const client = supabase as unknown as ApprovalClient;
  const periodResult = await client
    .from("reporting_periods")
    .select("id, period_start, period_end, status")
    .eq("id", input.reportingPeriodId)
    .maybeSingle();
  const periodRow = asPeriod(periodResult.data);
  if (periodResult.error || !periodRow || periodRow.status !== input.from) {
    throw new Error("El período cambió o ya no está disponible para aprobación.");
  }

  const period = resolvePayrollPeriod(periodRow.period_end.slice(0, 7));
  if (period.startDate !== periodRow.period_start || period.endDate !== periodRow.period_end) {
    throw new PayrollPeriodApprovalBlockedError(
      "La aprobación final exige un período de pago exacto 16-15.",
      0,
      ["El rango configurado no corresponde al ciclo de remuneraciones 16-15."],
    );
  }

  const revisionResult = await client.rpc("get_payroll_source_revision", { p_company_id: input.companyId });
  const sourceRevision = typeof revisionResult.data === "number" ? revisionResult.data : Number(revisionResult.data);
  if (revisionResult.error || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new Error("No pudimos fijar la revisión vigente de los datos de pago.");
  }

  const acceptedResult = await client
    .from("payroll_workbook_versions")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("reporting_period_id", input.reportingPeriodId)
    .eq("status", "ACCEPTED")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const acceptedVersionId = typeof acceptedResult.data?.id === "string" ? acceptedResult.data.id : null;
  if (acceptedResult.error || !acceptedVersionId || !UUID_PATTERN.test(acceptedVersionId)) {
    throw new PayrollPeriodApprovalBlockedError(
      "Debes confirmar una versión de pre-nómina antes de aprobar.",
      0,
      ["No existe una versión ACCEPTED vigente para este período."],
    );
  }

  let data: AttendanceExportData;
  let adjustments: Awaited<ReturnType<typeof loadAcceptedPayrollWorkbookAdjustments>>;
  let openConflicts: LooseListResult;
  try {
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
  } catch {
    throw new Error("No pudimos recalcular la pre-nómina para comprobar su aprobación.");
  }
  if (openConflicts.error || (openConflicts.data ?? []).length > 0) {
    throw new PayrollPeriodApprovalBlockedError(
      "La pre-nómina conserva conflictos Workera/RR. HH. sin resolver.",
      openConflicts.data?.length ?? 1,
      ["Resuelve los conflictos persistidos antes de aprobar."],
    );
  }

  data.reportingPeriodStatus = "READY_TO_CLOSE";
  data.workbookBaseVersionId = acceptedVersionId;
  data.workbookAdjustments = adjustments;
  const readiness = dependencies.getReadiness(data);
  if (!readiness.ready || readiness.pendingCount > 0 || readiness.issues.length > 0) {
    throw approvalBlocked(readiness);
  }

  const approvalId = await dependencies.commitApproval({
    actorId: input.actorId,
    companyId: input.companyId,
    reportingPeriodId: input.reportingPeriodId,
    expectedStatus: input.from,
    expectedSourceRevision: sourceRevision,
    expectedAcceptedVersionId: acceptedVersionId,
    readinessSha256: readinessDigest({
      companyId: input.companyId,
      periodId: input.reportingPeriodId,
      periodStart: period.startDate,
      periodEnd: period.endDate,
      sourceRevision,
      acceptedVersionId,
      readiness,
    }),
  });

  return { approvalId, sourceRevision, acceptedVersionId };
}
