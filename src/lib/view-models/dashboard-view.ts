import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { getDailyReview, type CallerRole } from "../business-rules/daily-review";
import { getWorkeraSyncHealth, type WorkeraSyncHealth } from "../sync/scheduler";
import { areasVisibleToRole, type AreaCode } from "../access/scope";

/**
 * Dashboards por rol (Fase 8, PASO 4). Solo agrega/cuenta datos que el
 * backend ya puede entregar de forma confiable -- ninguna métrica nueva se
 * inventa aquí (ej. nada de tendencias, promedios históricos, proyecciones:
 * el encargo pide explícitamente no inventar analytics todavía).
 */

export interface AttentionCounts {
  licenseDocumentPending: number;
  medicalDocumentPending: number;
  overtimePending: number;
  lateArrivalPending: number;
}

export interface AreaActivitySummary {
  areaCode: AreaCode;
  requiresReview: number;
  noIssues: number;
}

export interface AdminDashboardViewModel {
  kind: "ADMIN";
  date: string;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  overtimePendingToday: number;
  attention: AttentionCounts;
  areaActivity: AreaActivitySummary[];
  syncHealth: WorkeraSyncHealth;
}

export interface SupervisorDashboardViewModel {
  kind: "SUPERVISOR";
  date: string;
  areaCode: AreaCode;
  requiresReview: number;
  noIssues: number;
}

export type DashboardViewModel = AdminDashboardViewModel | SupervisorDashboardViewModel;

async function countAttentionItems(supabase: SupabaseClient<Database>, date: string): Promise<AttentionCounts> {
  const [licenseRes, medicalRes, overtimeRes, lateRes] = await Promise.all([
    supabase
      .from("absence_decisions")
      .select("id", { count: "exact", head: true })
      .eq("decision_status", "PENDING_DOCUMENT")
      .eq("is_current", true),
    supabase
      .from("early_departure_decisions")
      .select("id", { count: "exact", head: true })
      .eq("reason_category", "MEDICAL")
      .eq("payroll_effect", "NEEDS_REVIEW")
      .eq("is_current", true),
    supabase
      .from("overtime_records")
      .select("id, overtime_decisions!left(is_current)")
      .eq("work_date", date)
      .eq("is_current", true),
    supabase
      .from("late_arrival_records")
      .select("id, late_arrival_decisions!left(is_current)")
      .eq("work_date", date)
      .eq("is_current", true),
  ]);

  for (const res of [licenseRes, overtimeRes, lateRes]) {
    if (res.error) throw new Error(`countAttentionItems: fallo consultando pendientes: ${res.error.message}`);
  }
  if (medicalRes.error) throw new Error(`countAttentionItems: fallo consultando pendientes: ${medicalRes.error.message}`);

  const overtimePending = (overtimeRes.data ?? []).filter(
    (row) => !(Array.isArray(row.overtime_decisions) ? row.overtime_decisions : [row.overtime_decisions]).some((d) => d && d.is_current)
  ).length;
  const lateArrivalPending = (lateRes.data ?? []).filter(
    (row) => !(Array.isArray(row.late_arrival_decisions) ? row.late_arrival_decisions : [row.late_arrival_decisions]).some((d) => d && d.is_current)
  ).length;

  return {
    licenseDocumentPending: licenseRes.count ?? 0,
    medicalDocumentPending: medicalRes.count ?? 0,
    overtimePending,
    lateArrivalPending,
  };
}

export async function getAdminDashboard(
  supabase: SupabaseClient<Database>,
  date: string
): Promise<AdminDashboardViewModel> {
  const areaCodes: AreaCode[] = ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"];

  const [reviews, attention, syncHealth, presentRes] = await Promise.all([
    Promise.all(areaCodes.map((code) => getDailyReview(supabase, "SUPER_ADMIN", code, date))),
    countAttentionItems(supabase, date),
    getWorkeraSyncHealth(),
    supabase
      .from("attendance_records")
      .select("id", { count: "exact", head: true })
      .eq("work_date", date)
      .eq("is_current", true)
      .not("actual_clock_in", "is", null),
  ]);
  if (presentRes.error) throw new Error(`getAdminDashboard: fallo consultando presentes: ${presentRes.error.message}`);

  const areaActivity: AreaActivitySummary[] = reviews.map((review) => ({
    areaCode: review.groupCode,
    requiresReview: review.requiresReview.length,
    noIssues: review.noIssues.length,
  }));

  const lateToday = areaActivity.reduce(
    (sum, area, i) => sum + reviews[i].requiresReview.filter((e) => e.categories.includes("LATE")).length,
    0
  );
  const absentToday = areaActivity.reduce(
    (sum, area, i) => sum + reviews[i].requiresReview.filter((e) => e.categories.includes("ABSENCE")).length,
    0
  );

  return {
    kind: "ADMIN",
    date,
    presentToday: presentRes.count ?? 0,
    lateToday,
    absentToday,
    overtimePendingToday: attention.overtimePending,
    attention,
    areaActivity,
    syncHealth,
  };
}

export async function getSupervisorDashboard(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  date: string
): Promise<SupervisorDashboardViewModel> {
  const areaCode = areasVisibleToRole(callerRole)[0];
  const review = await getDailyReview(supabase, callerRole, areaCode, date);
  return {
    kind: "SUPERVISOR",
    date,
    areaCode: review.groupCode,
    requiresReview: review.requiresReview.length,
    noIssues: review.noIssues.length,
  };
}

export async function getDashboardForRole(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  date: string
): Promise<DashboardViewModel> {
  if (callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH") {
    return getAdminDashboard(supabase, date);
  }
  return getSupervisorDashboard(supabase, callerRole, date);
}
