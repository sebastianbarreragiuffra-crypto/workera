import "server-only";

import { createAdminClient } from "@/lib/supabase/admin-client";
import {
  ARCOTEX_PILOT_COMPANY_SLUG,
  ARCOTEX_PILOT_LOOKBACK_WEEKS,
  ARCOTEX_PILOT_TIME_ZONE,
  completedWeekCandidates,
  datesInRange,
  selectLatestFullyCollectedWeek,
  successfulSyncDays,
  type ArcotexAttendancePilotCollection,
  type AttendancePilotDayObservation,
  type AttendancePilotReviewQueue,
  type RuleEngineDayStatus,
  type SyncRunCoverage,
} from "./arcotex-attendance";

interface SafeProviderError {
  readonly code?: string | null;
}

interface CountResponse {
  readonly count: number | null;
  readonly error: SafeProviderError | null;
}

class SafeQueryFailure extends Error {
  constructor(readonly errorCode: string) {
    super("Falló una consulta agregada del preflight.");
  }
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,32}$/i.test(value)) return "QUERY_FAILED";
  return value.toUpperCase();
}

async function requireCount(query: PromiseLike<CountResponse>): Promise<number> {
  const result = await query;
  if (result.error || result.count === null) {
    throw new SafeQueryFailure(safeErrorCode(result.error?.code));
  }
  return result.count;
}

function safeMetric(value: number | null | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) throw new SafeQueryFailure("INVALID_AGGREGATE");
  return value as number;
}

function ruleStatus(value: string | null | undefined): RuleEngineDayStatus {
  if (value === "SUCCEEDED" || value === "PARTIAL" || value === "FAILED" || value === "RUNNING") return value;
  return value ? "OTHER" : "MISSING";
}

function pendingQueue(total: number, decided: number): { total: number; pending: number } {
  if (decided > total) throw new SafeQueryFailure("INCONSISTENT_COUNT");
  return { total, pending: total - decided };
}

export async function collectArcotexAttendancePilot(
  now: Date = new Date(),
): Promise<ArcotexAttendancePilotCollection> {
  const client = createAdminClient("arcotex-attendance-preflight");
  try {
    const companyResult = await client
      .from("companies")
      .select("id")
      .eq("slug", ARCOTEX_PILOT_COMPANY_SLUG)
      .eq("active", true)
      .limit(2);
    if (companyResult.error) throw new SafeQueryFailure(safeErrorCode(companyResult.error.code));
    if ((companyResult.data?.length ?? 0) !== 1) {
      return { kind: "COMPANY_NOT_FOUND", companyMatches: companyResult.data?.length ?? 0 };
    }
    const companyId = companyResult.data![0].id;

    const activeEmployees = await requireCount(
      client.from("employees").select("id", { count: "exact", head: true })
        .eq("company_id", companyId).eq("active", true),
    );
    const candidates = completedWeekCandidates(now, ARCOTEX_PILOT_TIME_ZONE, ARCOTEX_PILOT_LOOKBACK_WEEKS);
    const oldestStart = candidates.at(-1)!.start;
    const newestEnd = candidates[0].end;
    const syncResult = await client
      .from("sync_runs")
      .select("target_period_start, target_period_end, started_at, status")
      .eq("company_id", companyId)
      .gte("target_period_end", oldestStart)
      .lte("target_period_start", newestEnd);
    if (syncResult.error) throw new SafeQueryFailure(safeErrorCode(syncResult.error.code));
    const syncRuns: SyncRunCoverage[] = (syncResult.data ?? []).flatMap((run) =>
      run.target_period_start && run.target_period_end
        ? [{
          startDate: run.target_period_start,
          endDate: run.target_period_end,
          startedAt: run.started_at,
          status: run.status,
        }]
        : []
    );
    const selected = selectLatestFullyCollectedWeek(candidates, syncRuns);
    if (!selected) {
      return {
        kind: "NO_COMPLETE_WEEK",
        activeEmployees,
        latestCompletedWeek: candidates[0],
        latestWeekSuccessfulSyncDays: successfulSyncDays(candidates[0], syncRuns),
        searchedWeeks: candidates.length,
      };
    }

    const days: AttendancePilotDayObservation[] = await Promise.all(
      datesInRange(selected.range).map(async (date) => {
        const latestRuleResult = await client
          .from("attendance_rule_engine_day_readiness")
          .select("status, employees_processed, attendance_derived, late_candidates, early_departure_candidates, overtime_candidates, without_schedule, failure_count, is_input_fresh")
          .eq("company_id", companyId)
          .eq("work_date", date)
          .limit(1)
          .maybeSingle();
        if (latestRuleResult.error) throw new SafeQueryFailure(safeErrorCode(latestRuleResult.error.code));

        const [rawEvents, unresolvedSourceStatuses, attendanceRecords] = await Promise.all([
          requireCount(
            client.from("workera_attendance_events").select("id", { count: "exact", head: true })
              .eq("company_id", companyId).eq("work_date", date).eq("is_current", true),
          ),
          requireCount(
            client.from("workera_attendance_events").select("id", { count: "exact", head: true })
              .eq("company_id", companyId).eq("work_date", date).eq("is_current", true)
              .eq("attendance_status", "UNKNOWN_EXTERNAL_STATUS"),
          ),
          requireCount(
            client.from("attendance_records")
              .select("id, employees!inner(company_id)", { count: "exact", head: true })
              .eq("employees.company_id", companyId).eq("work_date", date).eq("is_current", true),
          ),
        ]);
        const latestRule = latestRuleResult.data;
        return {
          date,
          successfulSyncRuns: syncRuns.filter((run) =>
            run.status === "SUCCEEDED" && run.startDate <= date && run.endDate >= date
          ).length,
          rawEvents,
          unresolvedSourceStatuses,
          attendanceRecords,
          ruleEngine: latestRule
            ? {
              status: ruleStatus(latestRule.status),
              inputFresh: latestRule.is_input_fresh === true,
              employeesProcessed: safeMetric(latestRule.employees_processed),
              attendanceDerived: safeMetric(latestRule.attendance_derived),
              lateCandidates: safeMetric(latestRule.late_candidates),
              earlyDepartureCandidates: safeMetric(latestRule.early_departure_candidates),
              overtimeCandidates: safeMetric(latestRule.overtime_candidates),
              withoutSchedule: safeMetric(latestRule.without_schedule),
              failureCount: safeMetric(latestRule.failure_count),
            }
            : {
              status: "MISSING",
              inputFresh: false,
              employeesProcessed: 0,
              attendanceDerived: 0,
              lateCandidates: 0,
              earlyDepartureCandidates: 0,
              overtimeCandidates: 0,
              withoutSchedule: 0,
              failureCount: 0,
            },
        };
      }),
    );

    const start = selected.range.start;
    const end = selected.range.end;
    const [
      lateTotal,
      lateDecided,
      earlyTotal,
      earlyDecided,
      overtimeTotal,
      overtimeDecided,
      absenceTotal,
      absenceDecided,
      missingPunchesPending,
    ] = await Promise.all([
      requireCount(client.from("late_arrival_records")
        .select("id, employees!inner(company_id)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)),
      requireCount(client.from("late_arrival_records")
        .select("id, employees!inner(company_id), late_arrival_decisions!inner(is_current)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)
        .eq("late_arrival_decisions.is_current", true)),
      requireCount(client.from("early_departure_records")
        .select("id, employees!inner(company_id)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)),
      requireCount(client.from("early_departure_records")
        .select("id, employees!inner(company_id), early_departure_decisions!inner(is_current)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)
        .eq("early_departure_decisions.is_current", true)),
      requireCount(client.from("overtime_records")
        .select("id, employees!inner(company_id)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)),
      requireCount(client.from("overtime_records")
        .select("id, employees!inner(company_id), overtime_decisions!inner(is_current)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).gte("work_date", start).lte("work_date", end)
        .eq("overtime_decisions.is_current", true)),
      requireCount(client.from("absence_records")
        .select("id, employees!inner(company_id)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).lte("start_date", end).gte("end_date", start)),
      requireCount(client.from("absence_records")
        .select("id, employees!inner(company_id), absence_decisions!inner(is_current)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("is_current", true).lte("start_date", end).gte("end_date", start)
        .eq("absence_decisions.is_current", true)),
      requireCount(client.from("attendance_missing_punch_flags")
        .select("id, employees!inner(company_id), attendance_records!inner(is_current)", { count: "exact", head: true })
        .eq("employees.company_id", companyId).eq("attendance_records.is_current", true)
        .gte("work_date", start).lte("work_date", end).in("status", ["PENDING_CONTACT", "CONTACTED"])),
    ]);

    const reviewQueue: AttendancePilotReviewQueue = {
      lateArrivals: pendingQueue(lateTotal, lateDecided),
      earlyDepartures: pendingQueue(earlyTotal, earlyDecided),
      overtime: pendingQueue(overtimeTotal, overtimeDecided),
      absences: pendingQueue(absenceTotal, absenceDecided),
      missingPunchesPending,
    };
    return {
      kind: "COLLECTED_WEEK",
      activeEmployees,
      selectedWeek: selected.range,
      skippedNewerIncompleteWeeks: selected.skippedNewerIncompleteWeeks,
      days,
      reviewQueue,
    };
  } catch (error) {
    return {
      kind: "QUERY_FAILED",
      errorCode: error instanceof SafeQueryFailure ? error.errorCode : "QUERY_FAILED",
    };
  }
}
