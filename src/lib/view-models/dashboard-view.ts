import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { getDailyReview, type CallerRole, type DailyReviewCategory } from "../business-rules/daily-review";
import { getWorkeraSyncHealth, type WorkeraSyncHealth } from "../sync/scheduler";
import { areasVisibleToRole, type AreaCode } from "../access/scope";

/**
 * Dashboards por rol (Fase 8, extendido en Fase 8B.1). Solo agrega/cuenta
 * datos que el backend ya puede entregar de forma confiable -- las 5
 * categorías de "Pendientes prioritarios"/"Pendientes de revisión" son
 * EXACTAMENTE las categorías que ya calcula `getDailyReview` (Fase 7), sin
 * recalcular nada: LATE, OVERTIME_CANDIDATE, MISSING_PUNCH -> "Clock out
 * pendiente", ABSENCE -> "Licencia por validar" (aún sin decidir Sí/No),
 * LICENSE_DOCUMENT_REQUIRED + MEDICAL_DOCUMENT_REQUIRED -> "Documento
 * pendiente". Cualquier métrica que el encargo de 8B.1 pidió pero no tiene
 * un servicio backend confiable (asistencia promedio semanal, período/semana
 * cuando no hay ninguno abierto) se deja explícitamente `null`/`available:
 * false` -- nunca inventada.
 */

export interface KpiSet {
  workersActive: number;
  workersPresentToday: number;
  lateArrivalsPending: number;
  overtimePending: number;
  clockOutPending: number;
  absencesToday: number;
  pendingToClose: number;
}

export type PriorityQueueKey = "LATE" | "OVERTIME" | "CLOCK_OUT" | "LICENSE" | "DOCUMENTS";

export interface PriorityQueueItem {
  key: PriorityQueueKey;
  label: string;
  description: string;
  count: number;
  href: string;
}

export type ReviewQueueCategory = "LATE" | "OVERTIME" | "CLOCK_OUT" | "LICENSE" | "DOCUMENT";

export interface ReviewQueuePerson {
  employeeId: string;
  displayName: string;
  initials: string;
  category: ReviewQueueCategory;
  detailMinutes: number | null;
  href: string;
}

export interface BirthdayEntry {
  employeeId: string;
  displayName: string;
  birthMonth: number;
  birthDay: number;
  daysUntil: number;
  isToday: boolean;
}

export interface UpcomingHoliday {
  date: string;
  name: string;
  daysUntil: number;
}

export interface UpcomingEvents {
  birthdaysThisMonth: BirthdayEntry[];
  nextHoliday: UpcomingHoliday | null;
}

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  lateArrivalsCount: number;
  lateArrivalsMinutes: number;
  overtimeApprovedMinutes: number;
  absencesCount: number;
  bonusesGrantedCount: number;
  /** Fase 8B.1: sin servicio backend de agregación confiable todavía -- documentado como pendiente, nunca calculado de forma improvisada aquí. */
  attendanceAverageAvailable: false;
}

export interface PeriodWindow {
  start: string;
  end: string;
  status: string;
}

export interface PeriodStatus {
  weeklyReview: PeriodWindow | null;
  reportingPeriod: PeriodWindow | null;
}

export interface AdminDashboardViewModel {
  kind: "ADMIN";
  date: string;
  kpis: KpiSet;
  priorityQueue: PriorityQueueItem[];
  reviewQueue: ReviewQueuePerson[];
  upcomingEvents: UpcomingEvents;
  weekSummary: WeekSummary;
  periodStatus: PeriodStatus;
  syncHealth: WorkeraSyncHealth;
}

export interface SupervisorDashboardViewModel {
  kind: "SUPERVISOR";
  date: string;
  areaCode: AreaCode;
  kpis: KpiSet;
  priorityQueue: PriorityQueueItem[];
  reviewQueue: ReviewQueuePerson[];
  upcomingEvents: UpcomingEvents;
  weekSummary: WeekSummary;
  periodStatus: PeriodStatus;
}

export type DashboardViewModel = AdminDashboardViewModel | SupervisorDashboardViewModel;

const REVIEW_QUEUE_PRIORITY: DailyReviewCategory[] = [
  "LATE",
  "OVERTIME_CANDIDATE",
  "MISSING_PUNCH",
  "ABSENCE",
  "LICENSE_DOCUMENT_REQUIRED",
  "MEDICAL_DOCUMENT_REQUIRED",
];

export function categoryToReviewQueueCategory(category: DailyReviewCategory): ReviewQueueCategory {
  switch (category) {
    case "LATE":
      return "LATE";
    case "OVERTIME_CANDIDATE":
      return "OVERTIME";
    case "MISSING_PUNCH":
      return "CLOCK_OUT";
    case "ABSENCE":
      return "LICENSE";
    case "LICENSE_DOCUMENT_REQUIRED":
    case "MEDICAL_DOCUMENT_REQUIRED":
      return "DOCUMENT";
    case "EARLY_DEPARTURE":
      return "CLOCK_OUT";
  }
}

export function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Lunes-domingo (ISO), en el dominio calendario sintético UTC (mismo patrón que sync/target-date.ts). */
export function currentWeekRange(date: string): { start: string; end: string } {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d);
  const dow = new Date(asUtc).getUTCDay(); // 0=domingo..6=sábado
  const isoDow = dow === 0 ? 7 : dow;
  const startMs = asUtc - (isoDow - 1) * 86_400_000;
  const endMs = startMs + 6 * 86_400_000;
  const fmt = (ms: number) => {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  };
  return { start: fmt(startMs), end: fmt(endMs) };
}

async function getScopedEmployeeIds(supabase: SupabaseClient<Database>, areaCodes: AreaCode[]): Promise<string[]> {
  const { data: groups, error: groupsError } = await supabase.from("employee_groups").select("id, code").in("code", areaCodes);
  if (groupsError) throw new Error(`getScopedEmployeeIds: fallo leyendo employee_groups: ${groupsError.message}`);
  const groupIds = (groups ?? []).map((g) => g.id);
  if (groupIds.length === 0) return [];

  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("id")
    .in("employee_group_id", groupIds)
    .eq("active", true);
  if (employeesError) throw new Error(`getScopedEmployeeIds: fallo leyendo employees: ${employeesError.message}`);
  return (employees ?? []).map((e) => e.id);
}

async function buildPriorityAndReviewQueue(
  supabase: SupabaseClient<Database>,
  reviews: { review: Awaited<ReturnType<typeof getDailyReview>>; area: AreaCode }[],
  date: string
): Promise<{ priorityQueue: PriorityQueueItem[]; reviewQueue: ReviewQueuePerson[] }> {
  const counts: Record<PriorityQueueKey, number> = { LATE: 0, OVERTIME: 0, CLOCK_OUT: 0, LICENSE: 0, DOCUMENTS: 0 };
  const perPerson: { employeeId: string; displayName: string; areaCode: AreaCode; category: DailyReviewCategory }[] = [];

  for (const { review, area } of reviews) {
    for (const entry of review.requiresReview) {
      const primaryCategory = REVIEW_QUEUE_PRIORITY.find((c) => entry.categories.includes(c));
      if (!primaryCategory) continue;
      perPerson.push({ employeeId: entry.employeeId, displayName: entry.displayName, areaCode: area, category: primaryCategory });

      if (primaryCategory === "LATE") counts.LATE += 1;
      else if (primaryCategory === "OVERTIME_CANDIDATE") counts.OVERTIME += 1;
      else if (primaryCategory === "MISSING_PUNCH") counts.CLOCK_OUT += 1;
      else if (primaryCategory === "ABSENCE") counts.LICENSE += 1;
      else counts.DOCUMENTS += 1;
    }
  }

  const employeeIds = perPerson.map((p) => p.employeeId);
  const [lateRows, overtimeRows] = await Promise.all([
    employeeIds.length > 0
      ? supabase
          .from("late_arrival_records")
          .select("employee_id, detected_minutes")
          .in("employee_id", employeeIds)
          .eq("work_date", date)
          .eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
    employeeIds.length > 0
      ? supabase
          .from("overtime_records")
          .select("employee_id, candidate_minutes")
          .in("employee_id", employeeIds)
          .eq("work_date", date)
          .eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (lateRows.error) throw new Error(`buildPriorityAndReviewQueue: fallo leyendo atrasos: ${lateRows.error.message}`);
  if (overtimeRows.error) throw new Error(`buildPriorityAndReviewQueue: fallo leyendo horas extra: ${overtimeRows.error.message}`);

  const lateMinutesByEmployee = new Map((lateRows.data ?? []).map((r) => [r.employee_id, r.detected_minutes]));
  const overtimeMinutesByEmployee = new Map((overtimeRows.data ?? []).map((r) => [r.employee_id, r.candidate_minutes]));

  const reviewQueue: ReviewQueuePerson[] = perPerson.map((p) => {
    const category = categoryToReviewQueueCategory(p.category);
    const detailMinutes =
      category === "LATE" ? (lateMinutesByEmployee.get(p.employeeId) ?? null) : category === "OVERTIME" ? (overtimeMinutesByEmployee.get(p.employeeId) ?? null) : null;
    return {
      employeeId: p.employeeId,
      displayName: p.displayName,
      initials: initialsOf(p.displayName),
      category,
      detailMinutes,
      href: `/revision-diaria?fecha=${date}&area=${p.areaCode}&empleado=${p.employeeId}`,
    };
  });

  const priorityQueue: PriorityQueueItem[] = [
    {
      key: "LATE",
      label: "Atrasos por justificar",
      description: "Marcas fuera del horario que requieren justificación",
      count: counts.LATE,
      href: `/revision-diaria?fecha=${date}&filtro=atrasos`,
    },
    {
      key: "OVERTIME",
      label: "Horas extra por aprobar",
      description: "Horas extra registradas que requieren aprobación",
      count: counts.OVERTIME,
      href: `/revision-diaria?fecha=${date}&filtro=horas-extra`,
    },
    {
      key: "CLOCK_OUT",
      label: "Clock out pendientes",
      description: "Trabajadores que aún no marcan salida",
      count: counts.CLOCK_OUT,
      href: `/revision-diaria?fecha=${date}`,
    },
    {
      key: "LICENSE",
      label: "Licencias por validar",
      description: "Ausencias que requieren confirmar si corresponden a licencia",
      count: counts.LICENSE,
      href: `/revision-diaria?fecha=${date}&filtro=ausencias`,
    },
    {
      key: "DOCUMENTS",
      label: "Documentos pendientes",
      description: "Licencias o comprobantes médicos a la espera de respaldo",
      count: counts.DOCUMENTS,
      href: `/revision-diaria?fecha=${date}&filtro=ausencias`,
    },
  ];

  return { priorityQueue, reviewQueue };
}

async function getUpcomingEvents(supabase: SupabaseClient<Database>, employeeIds: string[] | null, today: string): Promise<UpcomingEvents> {
  const [y, m, d] = today.split("-").map(Number);

  let birthdayQuery = supabase.from("employee_birthdays").select("employee_id, birth_month, birth_day, employees(display_name)").eq("birth_month", m);
  if (employeeIds) birthdayQuery = birthdayQuery.in("employee_id", employeeIds);
  const [birthdayRes, holidayRes] = await Promise.all([
    birthdayQuery,
    supabase.from("holidays").select("holiday_date, name").eq("active", true).gte("holiday_date", today).order("holiday_date", { ascending: true }).limit(1),
  ]);
  if (birthdayRes.error) throw new Error(`getUpcomingEvents: fallo leyendo cumpleaños: ${birthdayRes.error.message}`);
  if (holidayRes.error) throw new Error(`getUpcomingEvents: fallo leyendo feriados: ${holidayRes.error.message}`);

  const birthdaysThisMonth: BirthdayEntry[] = (birthdayRes.data ?? [])
    .map((row) => {
      const employeeRelation = row.employees as { display_name: string } | { display_name: string }[] | null;
      const displayName = (Array.isArray(employeeRelation) ? employeeRelation[0]?.display_name : employeeRelation?.display_name) ?? "";
      return {
        employeeId: row.employee_id,
        displayName,
        birthMonth: row.birth_month,
        birthDay: row.birth_day,
        daysUntil: row.birth_day - d,
        isToday: row.birth_day === d,
      };
    })
    .sort((a, b) => a.birthDay - b.birthDay);

  const holidayRow = holidayRes.data?.[0] ?? null;
  const nextHoliday: UpcomingHoliday | null = holidayRow
    ? {
        date: holidayRow.holiday_date,
        name: holidayRow.name,
        daysUntil: Math.round((Date.UTC(...(holidayRow.holiday_date.split("-").map(Number) as [number, number, number])) - Date.UTC(y, m - 1, d)) / 86_400_000),
      }
    : null;

  return { birthdaysThisMonth, nextHoliday };
}

async function getWeekSummary(supabase: SupabaseClient<Database>, employeeIds: string[] | null, date: string): Promise<WeekSummary> {
  const { start, end } = currentWeekRange(date);

  let lateQuery = supabase.from("late_arrival_records").select("employee_id, detected_minutes").eq("is_current", true).gte("work_date", start).lte("work_date", end);
  if (employeeIds) lateQuery = lateQuery.in("employee_id", employeeIds);

  let overtimeQuery = supabase
    .from("overtime_decisions")
    .select("approved_minutes, overtime_records!inner(work_date, employee_id)")
    .eq("is_current", true)
    .in("decision_status", ["FULLY_APPROVED", "PARTIALLY_APPROVED"])
    .gte("overtime_records.work_date", start)
    .lte("overtime_records.work_date", end);
  if (employeeIds) overtimeQuery = overtimeQuery.in("overtime_records.employee_id", employeeIds);

  let absenceQuery = supabase.from("absence_records").select("employee_id").eq("is_current", true).lte("start_date", end).gte("end_date", start);
  if (employeeIds) absenceQuery = absenceQuery.in("employee_id", employeeIds);

  let bonusQuery = supabase.from("employee_daily_bonuses").select("employee_id").gte("work_date", start).lte("work_date", end);
  if (employeeIds) bonusQuery = bonusQuery.in("employee_id", employeeIds);

  const [lateRes, overtimeRes, absenceRes, bonusRes] = await Promise.all([lateQuery, overtimeQuery, absenceQuery, bonusQuery]);

  for (const res of [lateRes, overtimeRes, absenceRes, bonusRes]) {
    if (res.error) throw new Error(`getWeekSummary: fallo agregando resumen semanal: ${res.error.message}`);
  }

  const lateRows = lateRes.data ?? [];
  const overtimeRows = overtimeRes.data ?? [];

  return {
    weekStart: start,
    weekEnd: end,
    lateArrivalsCount: lateRows.length,
    lateArrivalsMinutes: lateRows.reduce((sum, r) => sum + r.detected_minutes, 0),
    overtimeApprovedMinutes: overtimeRows.reduce((sum, r) => sum + r.approved_minutes, 0),
    absencesCount: (absenceRes.data ?? []).length,
    bonusesGrantedCount: (bonusRes.data ?? []).length,
    attendanceAverageAvailable: false,
  };
}

export async function getPeriodStatus(supabase: SupabaseClient<Database>, date: string): Promise<PeriodStatus> {
  const [weeklyRes, periodRes] = await Promise.all([
    supabase.from("weekly_reviews").select("period_start, period_end, status").lte("period_start", date).gte("period_end", date).maybeSingle(),
    supabase.from("reporting_periods").select("period_start, period_end, status").lte("period_start", date).gte("period_end", date).maybeSingle(),
  ]);
  if (weeklyRes.error) throw new Error(`getPeriodStatus: fallo leyendo weekly_reviews: ${weeklyRes.error.message}`);
  if (periodRes.error) throw new Error(`getPeriodStatus: fallo leyendo reporting_periods: ${periodRes.error.message}`);

  return {
    weeklyReview: weeklyRes.data ? { start: weeklyRes.data.period_start, end: weeklyRes.data.period_end, status: weeklyRes.data.status } : null,
    reportingPeriod: periodRes.data ? { start: periodRes.data.period_start, end: periodRes.data.period_end, status: periodRes.data.status } : null,
  };
}

async function computeKpis(
  supabase: SupabaseClient<Database>,
  employeeIds: string[],
  date: string,
  pendingToClose: number
): Promise<KpiSet> {
  if (employeeIds.length === 0) {
    return { workersActive: 0, workersPresentToday: 0, lateArrivalsPending: 0, overtimePending: 0, clockOutPending: 0, absencesToday: 0, pendingToClose };
  }

  const [presentRes, lateRes, overtimeRes, clockOutRes, absenceRes] = await Promise.all([
    supabase
      .from("attendance_records")
      .select("id", { count: "exact", head: true })
      .in("employee_id", employeeIds)
      .eq("work_date", date)
      .eq("is_current", true)
      .not("actual_clock_in", "is", null),
    supabase
      .from("late_arrival_records")
      .select("id, late_arrival_decisions!left(is_current)")
      .in("employee_id", employeeIds)
      .eq("work_date", date)
      .eq("is_current", true),
    supabase
      .from("overtime_records")
      .select("id, overtime_decisions!left(is_current)")
      .in("employee_id", employeeIds)
      .eq("work_date", date)
      .eq("is_current", true),
    supabase
      .from("attendance_missing_punch_flags")
      .select("id", { count: "exact", head: true })
      .in("employee_id", employeeIds)
      .eq("work_date", date)
      .in("status", ["PENDING_CONTACT", "CONTACTED"]),
    supabase
      .from("absence_records")
      .select("id", { count: "exact", head: true })
      .in("employee_id", employeeIds)
      .eq("is_current", true)
      .lte("start_date", date)
      .gte("end_date", date),
  ]);

  for (const res of [presentRes, lateRes, overtimeRes, clockOutRes, absenceRes]) {
    if (res.error) throw new Error(`computeKpis: fallo consultando KPIs: ${res.error.message}`);
  }

  const lateArrivalsPending = (lateRes.data ?? []).filter(
    (row) => !(Array.isArray(row.late_arrival_decisions) ? row.late_arrival_decisions : [row.late_arrival_decisions]).some((d) => d && d.is_current)
  ).length;
  const overtimePending = (overtimeRes.data ?? []).filter(
    (row) => !(Array.isArray(row.overtime_decisions) ? row.overtime_decisions : [row.overtime_decisions]).some((d) => d && d.is_current)
  ).length;

  return {
    workersActive: employeeIds.length,
    workersPresentToday: presentRes.count ?? 0,
    lateArrivalsPending,
    overtimePending,
    clockOutPending: clockOutRes.count ?? 0,
    absencesToday: absenceRes.count ?? 0,
    pendingToClose,
  };
}

export async function getAdminDashboard(supabase: SupabaseClient<Database>, date: string): Promise<AdminDashboardViewModel> {
  const areaCodes: AreaCode[] = ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"];

  const [reviews, syncHealth, employeeIds, weekSummary, periodStatus, upcomingEvents] = await Promise.all([
    Promise.all(areaCodes.map(async (code) => ({ review: await getDailyReview(supabase, "SUPER_ADMIN", code, date), area: code }))),
    getWorkeraSyncHealth(),
    getScopedEmployeeIds(supabase, areaCodes),
    getWeekSummary(supabase, null, date),
    getPeriodStatus(supabase, date),
    getUpcomingEvents(supabase, null, date),
  ]);

  const pendingToClose = reviews.reduce((sum, r) => sum + r.review.requiresReview.length, 0);
  const [kpis, queues] = await Promise.all([computeKpis(supabase, employeeIds, date, pendingToClose), buildPriorityAndReviewQueue(supabase, reviews, date)]);

  return {
    kind: "ADMIN",
    date,
    kpis,
    priorityQueue: queues.priorityQueue,
    reviewQueue: queues.reviewQueue,
    upcomingEvents,
    weekSummary,
    periodStatus,
    syncHealth,
  };
}

export async function getSupervisorDashboard(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  date: string
): Promise<SupervisorDashboardViewModel> {
  const areaCode = areasVisibleToRole(callerRole)[0];

  const [review, employeeIds, periodStatus] = await Promise.all([
    getDailyReview(supabase, callerRole, areaCode, date),
    getScopedEmployeeIds(supabase, [areaCode]),
    getPeriodStatus(supabase, date),
  ]);

  const pendingToClose = review.requiresReview.length;
  const [kpis, queues, weekSummary, upcomingEvents] = await Promise.all([
    computeKpis(supabase, employeeIds, date, pendingToClose),
    buildPriorityAndReviewQueue(supabase, [{ review, area: areaCode }], date),
    getWeekSummary(supabase, employeeIds, date),
    getUpcomingEvents(supabase, employeeIds, date),
  ]);

  return {
    kind: "SUPERVISOR",
    date,
    areaCode,
    kpis,
    priorityQueue: queues.priorityQueue,
    reviewQueue: queues.reviewQueue,
    upcomingEvents,
    weekSummary,
    periodStatus,
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
