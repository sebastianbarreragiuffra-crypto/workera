import "server-only";

import { createAdminClient } from "@/lib/supabase/admin-client";
import { ARCOTEX_PILOT_COMPANY_SLUG } from "./arcotex-attendance";
import {
  buildArcotexAttendanceStatusRepairPlan,
  isIsoCalendarDate,
  type ArcotexRepairableAttendanceStatus,
} from "./arcotex-attendance-status-repair";

interface RepairEventRow {
  readonly employee_id: string;
  readonly external_employee_code: string;
  readonly attendance_timestamp_raw: string;
  readonly attendance_type_code: number;
  readonly attendance_type_label: string;
  readonly attendance_status: string;
  readonly external_attendance_status: string;
  readonly origin: string | null;
  readonly origin_code: string | null;
  readonly device_name: string | null;
  readonly checksum: string | null;
}

interface RepairSummary {
  readonly date: string;
  readonly currentEvents: number;
  readonly unknownEvents: number;
  readonly unsupportedUnknownEvents: number;
  readonly alreadyNormalizedEvents: number;
  readonly targetCounts: Readonly<Record<ArcotexRepairableAttendanceStatus, number>>;
}

type RepairAdminClient = ReturnType<typeof createAdminClient>;
type RepairPlan = ReturnType<typeof buildArcotexAttendanceStatusRepairPlan<RepairEventRow>>;

interface RepairServiceDependencies {
  readonly client?: RepairAdminClient;
}

type RepairPlanReadResult =
  | { readonly kind: "PLAN"; readonly plan: RepairPlan }
  | { readonly kind: "ERROR"; readonly errorCode: string };

const STALE_RUNNING_SECONDS = 900;
const RUN_CLOSE_UNCONFIRMED = "RUN_CLOSE_UNCONFIRMED";

export type ArcotexAttendanceStatusRepairResult =
  | ({ readonly kind: "PREVIEW" } & RepairSummary)
  | ({ readonly kind: "NO_CHANGES_NEEDED" } & RepairSummary)
  | ({ readonly kind: "BLOCKED_UNRECOGNIZED_STATUS" } & RepairSummary)
  | ({ readonly kind: "BLOCKED_ACTIVE_RUN" } & RepairSummary)
  | ({
    readonly kind: "APPLIED";
    readonly versioned: number;
    readonly unchanged: number;
    readonly remainingUnknownEvents: number;
  } & RepairSummary)
  | ({
    readonly kind: "FAILED";
    readonly errorCode: string;
    readonly versioned: number;
    readonly unchanged: number;
  } & RepairSummary)
  | { readonly kind: "INVALID_DATE"; readonly date: string }
  | { readonly kind: "COMPANY_NOT_FOUND"; readonly date: string }
  | { readonly kind: "QUERY_FAILED"; readonly date: string; readonly errorCode: string };

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,32}$/i.test(value)) return "DATABASE_ERROR";
  return value.toUpperCase();
}

function summaryFor(
  date: string,
  plan: RepairPlan,
): RepairSummary {
  return {
    date,
    currentEvents: plan.currentEvents,
    unknownEvents: plan.unknownEvents,
    unsupportedUnknownEvents: plan.unsupportedUnknownEvents,
    alreadyNormalizedEvents: plan.alreadyNormalizedEvents,
    targetCounts: plan.targetCounts,
  };
}

async function readRepairPlan(
  client: RepairAdminClient,
  companyId: string,
  date: string,
): Promise<RepairPlanReadResult> {
  const eventsResult = await client
    .from("workera_attendance_events")
    .select(
      "employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code, attendance_type_label, attendance_status, external_attendance_status, origin, origin_code, device_name, checksum",
      { count: "exact" },
    )
    .eq("company_id", companyId)
    .eq("work_date", date)
    .eq("is_current", true)
    .limit(1000);
  if (eventsResult.error) {
    return { kind: "ERROR", errorCode: safeErrorCode(eventsResult.error.code) };
  }
  if (eventsResult.count === null || eventsResult.count !== eventsResult.data.length) {
    return { kind: "ERROR", errorCode: "RESULT_LIMIT_EXCEEDED" };
  }
  return {
    kind: "PLAN",
    plan: buildArcotexAttendanceStatusRepairPlan(eventsResult.data as RepairEventRow[]),
  };
}

async function confirmFailedRunClosed(
  client: RepairAdminClient,
  params: {
    readonly companyId: string;
    readonly syncRunId: string;
    readonly recordsRead: number;
    readonly versioned: number;
    readonly unchanged: number;
    readonly errorCode: string;
  },
): Promise<boolean> {
  try {
    const finishResult = await client.rpc("finish_workera_sync_run", {
      p_company_id: params.companyId,
      p_sync_run_id: params.syncRunId,
      p_status: "FAILED",
      p_records_read: params.recordsRead,
      p_records_created: 0,
      p_records_updated: params.versioned,
      p_records_unchanged: params.unchanged,
      p_error_summary: {
        reason: "ARCOTEX_PRESERVED_STATUS_REPAIR_FAILED",
        code: safeErrorCode(params.errorCode),
      },
      p_error_category: "DATABASE",
    });
    return !finishResult.error && finishResult.data === true;
  } catch {
    return false;
  }
}

/**
 * Renormalización operativa, tenant-scoped y sin consultar nuevamente al
 * proveedor. Cada cambio usa el mismo RPC versionado de la ingesta normal y
 * queda asociado a una corrida MANUAL de sync para el día exacto.
 */
export async function repairArcotexAttendanceStatusesForDate(
  date: string,
  apply: boolean,
  dependencies: RepairServiceDependencies = {},
): Promise<ArcotexAttendanceStatusRepairResult> {
  if (!isIsoCalendarDate(date)) return { kind: "INVALID_DATE", date };

  const client = dependencies.client ?? createAdminClient("arcotex-attendance-status-repair");
  const companyResult = await client
    .from("companies")
    .select("id")
    .eq("slug", ARCOTEX_PILOT_COMPANY_SLUG)
    .eq("active", true)
    .limit(2);
  if (companyResult.error) {
    return { kind: "QUERY_FAILED", date, errorCode: safeErrorCode(companyResult.error.code) };
  }
  if ((companyResult.data?.length ?? 0) !== 1) return { kind: "COMPANY_NOT_FOUND", date };
  const companyId = companyResult.data![0].id;

  if (!apply) {
    const previewResult = await readRepairPlan(client, companyId, date);
    if (previewResult.kind === "ERROR") {
      return { kind: "QUERY_FAILED", date, errorCode: previewResult.errorCode };
    }
    const previewPlan = previewResult.plan;
    const previewSummary = summaryFor(date, previewPlan);
    if (previewPlan.unknownEvents === 0) return { kind: "NO_CHANGES_NEEDED", ...previewSummary };
    if (previewPlan.unsupportedUnknownEvents > 0) {
      return { kind: "BLOCKED_UNRECOGNIZED_STATUS", ...previewSummary };
    }
    return { kind: "PREVIEW", ...previewSummary };
  }

  const reclaimResult = await client.rpc("reclaim_stale_workera_sync_runs", {
    p_company_id: companyId,
    p_stale_after_seconds: STALE_RUNNING_SECONDS,
  });
  if (reclaimResult.error) {
    return { kind: "QUERY_FAILED", date, errorCode: safeErrorCode(reclaimResult.error.code) };
  }
  if (!Number.isSafeInteger(reclaimResult.data) || reclaimResult.data < 0) {
    return { kind: "QUERY_FAILED", date, errorCode: "INVALID_RECLAIM_RESULT" };
  }

  const beginResult = await client.rpc("begin_workera_sync_run", {
    p_company_id: companyId,
    p_period_start: date,
    p_period_end: date,
    p_triggered_by: "MANUAL",
    p_attempt: 1,
    p_retry_of: null,
  });
  if (beginResult.error) {
    return { kind: "QUERY_FAILED", date, errorCode: safeErrorCode(beginResult.error.code) };
  }
  if (!beginResult.data) {
    const blockedResult = await readRepairPlan(client, companyId, date);
    if (blockedResult.kind === "ERROR") {
      return { kind: "QUERY_FAILED", date, errorCode: blockedResult.errorCode };
    }
    return { kind: "BLOCKED_ACTIVE_RUN", ...summaryFor(date, blockedResult.plan) };
  }
  const syncRunId = beginResult.data;

  const lockedResult = await readRepairPlan(client, companyId, date);
  if (lockedResult.kind === "ERROR") {
    const closed = await confirmFailedRunClosed(client, {
      companyId,
      syncRunId,
      recordsRead: 0,
      versioned: 0,
      unchanged: 0,
      errorCode: lockedResult.errorCode,
    });
    return {
      kind: "QUERY_FAILED",
      date,
      errorCode: closed ? lockedResult.errorCode : RUN_CLOSE_UNCONFIRMED,
    };
  }
  const plan = lockedResult.plan;
  const summary = summaryFor(date, plan);

  if (plan.unsupportedUnknownEvents > 0) {
    const closed = await confirmFailedRunClosed(client, {
      companyId,
      syncRunId,
      recordsRead: plan.currentEvents,
      versioned: 0,
      unchanged: plan.alreadyNormalizedEvents,
      errorCode: "UNRECOGNIZED_STATUS",
    });
    if (!closed) {
      return {
        kind: "FAILED",
        ...summary,
        errorCode: RUN_CLOSE_UNCONFIRMED,
        versioned: 0,
        unchanged: 0,
      };
    }
    return { kind: "BLOCKED_UNRECOGNIZED_STATUS", ...summary };
  }

  let versioned = 0;
  let unchanged = 0;
  try {
    for (const target of plan.targets) {
      const row = target.row;
      const upsertResult = await client.rpc("upsert_workera_attendance_event", {
        p_company_id: companyId,
        p_sync_run_id: syncRunId,
        p_employee_id: row.employee_id,
        p_external_employee_code: row.external_employee_code,
        p_attendance_timestamp_raw: row.attendance_timestamp_raw,
        p_attendance_type_code: row.attendance_type_code,
        p_attendance_type_label: row.attendance_type_label,
        p_attendance_status: target.normalizedStatus,
        p_external_attendance_status: row.external_attendance_status,
        p_origin: row.origin,
        p_origin_code: row.origin_code,
        p_device_name: row.device_name,
        p_checksum: row.checksum,
      });
      if (upsertResult.error) throw new Error(safeErrorCode(upsertResult.error.code));
      if (upsertResult.data === "VERSIONED") versioned += 1;
      else if (upsertResult.data === "UNCHANGED") unchanged += 1;
      else throw new Error("UNEXPECTED_UPSERT_RESULT");
    }

    const remainingResult = await client
      .from("workera_attendance_events")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("work_date", date)
      .eq("is_current", true)
      .eq("attendance_status", "UNKNOWN_EXTERNAL_STATUS");
    if (remainingResult.error || remainingResult.count === null) {
      throw new Error(safeErrorCode(remainingResult.error?.code));
    }
    if (remainingResult.count !== 0) throw new Error("POSTCONDITION_FAILED");

    const finishResult = await client.rpc("finish_workera_sync_run", {
      p_company_id: companyId,
      p_sync_run_id: syncRunId,
      p_status: "SUCCEEDED",
      p_records_read: plan.currentEvents,
      p_records_created: 0,
      p_records_updated: versioned,
      p_records_unchanged: plan.alreadyNormalizedEvents + unchanged,
      p_error_summary: null,
      p_error_category: null,
    });
    if (finishResult.error || finishResult.data !== true) throw new Error("RUN_CLOSE_FAILED");

    return plan.unknownEvents === 0
      ? { kind: "NO_CHANGES_NEEDED", ...summary }
      : {
        kind: "APPLIED",
        ...summary,
        versioned,
        unchanged,
        remainingUnknownEvents: 0,
      };
  } catch (error) {
    const errorCode = error instanceof Error ? safeErrorCode(error.message) : "REPAIR_FAILED";
    const closed = await confirmFailedRunClosed(client, {
      companyId,
      syncRunId,
      recordsRead: plan.currentEvents,
      versioned,
      unchanged: plan.alreadyNormalizedEvents + unchanged,
      errorCode,
    });
    return {
      kind: "FAILED",
      ...summary,
      errorCode: closed ? errorCode : RUN_CLOSE_UNCONFIRMED,
      versioned,
      unchanged,
    };
  }
}
