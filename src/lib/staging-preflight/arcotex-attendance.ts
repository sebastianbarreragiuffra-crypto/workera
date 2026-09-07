export const ARCOTEX_PILOT_SCOPE = "ARCOTEX" as const;
export const ARCOTEX_PILOT_COMPANY_SLUG = "arcotex";
export const ARCOTEX_PILOT_TIME_ZONE = "America/Santiago";
export const ARCOTEX_PILOT_LOOKBACK_WEEKS = 8;

export interface CalendarRange {
  readonly start: string;
  readonly end: string;
}

export interface SyncRunCoverage {
  readonly startDate: string;
  readonly endDate: string;
  readonly startedAt: string;
  readonly status: string;
}

export type RuleEngineDayStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "RUNNING"
  | "MISSING"
  | "OTHER";

export interface AttendancePilotDayObservation {
  readonly date: string;
  readonly successfulSyncRuns: number;
  readonly rawEvents: number;
  readonly attendanceRecords: number;
  readonly ruleEngine: {
    readonly status: RuleEngineDayStatus;
    readonly employeesProcessed: number;
    readonly attendanceDerived: number;
    readonly lateCandidates: number;
    readonly earlyDepartureCandidates: number;
    readonly overtimeCandidates: number;
    readonly withoutSchedule: number;
    readonly failureCount: number;
  };
}

export interface ReviewQueueObservation {
  readonly total: number;
  readonly pending: number;
}

export interface AttendancePilotReviewQueue {
  readonly lateArrivals: ReviewQueueObservation;
  readonly earlyDepartures: ReviewQueueObservation;
  readonly overtime: ReviewQueueObservation;
  readonly absences: ReviewQueueObservation;
  readonly missingPunchesPending: number;
}

export type ArcotexAttendancePilotCollection =
  | {
    readonly kind: "QUERY_FAILED";
    readonly errorCode: string;
  }
  | {
    readonly kind: "COMPANY_NOT_FOUND";
    readonly companyMatches: number;
  }
  | {
    readonly kind: "NO_COMPLETE_WEEK";
    readonly activeEmployees: number;
    readonly latestCompletedWeek: CalendarRange;
    readonly latestWeekSuccessfulSyncDays: number;
    readonly searchedWeeks: number;
  }
  | {
    readonly kind: "COLLECTED_WEEK";
    readonly activeEmployees: number;
    readonly selectedWeek: CalendarRange;
    readonly skippedNewerIncompleteWeeks: number;
    readonly days: readonly AttendancePilotDayObservation[];
    readonly reviewQueue: AttendancePilotReviewQueue;
  };

export type ArcotexAttendancePilotOutcome =
  | "QUERY_FAILED"
  | "ARCOTEX_NOT_FOUND"
  | "ARCOTEX_AMBIGUOUS"
  | "NO_COMPLETE_COLLECTED_WEEK"
  | "NO_ACTIVE_EMPLOYEES"
  | "NO_COLLECTED_ATTENDANCE"
  | "NO_DERIVED_ATTENDANCE"
  | "RULE_ENGINE_INCOMPLETE"
  | "READY_FOR_SHADOW_REVIEW";

export interface ArcotexAttendancePilotReport {
  readonly generatedAt: string;
  readonly scope: typeof ARCOTEX_PILOT_SCOPE;
  readonly outcome: ArcotexAttendancePilotOutcome;
  readonly errorCode: string | null;
  readonly activeEmployees: number | null;
  readonly selectedWeek: CalendarRange | null;
  readonly skippedNewerIncompleteWeeks: number;
  readonly days: readonly AttendancePilotDayObservation[];
  readonly totals: {
    readonly rawEvents: number;
    readonly attendanceRecords: number;
    readonly ruleEngineSucceededDays: number;
    readonly ruleEngineFailureCount: number;
    readonly pendingHumanReview: number;
  } | null;
  readonly reviewQueue: AttendancePilotReviewQueue | null;
  readonly constraints: readonly string[];
  readonly note: string;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("Fecha calendario inválida para el preflight de asistencia.");
  }
}

function shiftIsoDate(value: string, days: number): string {
  assertIsoDate(value);
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDateInTimeZone(now: Date, timeZone: string): string {
  if (Number.isNaN(now.getTime())) throw new Error("Reloj inválido para el preflight de asistencia.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("No fue posible resolver la fecha local del preflight.");
  return `${year}-${month}-${day}`;
}

function mondayOfWeek(value: string): string {
  assertIsoDate(value);
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  return shiftIsoDate(value, -(isoDay - 1));
}

export function datesInRange(range: CalendarRange): string[] {
  assertIsoDate(range.start);
  assertIsoDate(range.end);
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  if (start > end) throw new Error("El rango del preflight de asistencia está invertido.");
  const dates: string[] = [];
  for (let value = start; value <= end; value += DAY_MS) {
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Ventanas lunes-domingo ya cerradas en la zona de ARCOTEX. La primera es la
 * semana calendario anterior; nunca incluye el día actual ni una semana en
 * curso. La aritmética se hace sobre fechas calendario sintéticas para no
 * depender de días de 23/25 horas durante cambios de DST en Chile.
 */
export function completedWeekCandidates(
  now: Date,
  timeZone = ARCOTEX_PILOT_TIME_ZONE,
  count = ARCOTEX_PILOT_LOOKBACK_WEEKS,
): CalendarRange[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 52) {
    throw new Error("La cantidad de semanas del preflight debe estar entre 1 y 52.");
  }
  const today = calendarDateInTimeZone(now, timeZone);
  const currentMonday = mondayOfWeek(today);
  return Array.from({ length: count }, (_, index) => {
    const start = shiftIsoDate(currentMonday, -7 * (index + 1));
    return { start, end: shiftIsoDate(start, 6) };
  });
}

export function successfulSyncDays(range: CalendarRange, runs: readonly SyncRunCoverage[]): number {
  return datesInRange(range).filter((date) => {
    const coveringRuns = runs
      .filter((run) => run.startDate <= date && run.endDate >= date)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return coveringRuns[0]?.status === "SUCCEEDED";
  }).length;
}

export function selectLatestFullyCollectedWeek(
  candidates: readonly CalendarRange[],
  runs: readonly SyncRunCoverage[],
): { readonly range: CalendarRange; readonly skippedNewerIncompleteWeeks: number } | null {
  for (let index = 0; index < candidates.length; index += 1) {
    if (successfulSyncDays(candidates[index], runs) === 7) {
      return { range: candidates[index], skippedNewerIncompleteWeeks: index };
    }
  }
  return null;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateQueue(queue: ReviewQueueObservation): void {
  if (!isNonNegativeInteger(queue.total) || !isNonNegativeInteger(queue.pending) || queue.pending > queue.total) {
    throw new Error("La cola agregada del preflight contiene conteos inválidos.");
  }
}

function constraints(): readonly string[] {
  return [
    "Usar únicamente asistencia ya recolectada; este control no sincroniza ni importa datos.",
    "La primera marcha blanca es revisión en sombra: toda decisión sigue siendo humana.",
    "No enviar resultados a remuneraciones ni ejecutar descuentos o pagos automáticos.",
    "Mantener fuera del alcance cargas documentales, gastos, correo, WhatsApp, OCR y nuevas empresas.",
  ];
}

export function buildArcotexAttendancePilotReport(
  collection: ArcotexAttendancePilotCollection,
  generatedAt = new Date().toISOString(),
): ArcotexAttendancePilotReport {
  const base = {
    generatedAt,
    scope: ARCOTEX_PILOT_SCOPE,
    constraints: constraints(),
  } as const;

  if (collection.kind === "QUERY_FAILED") {
    return {
      ...base,
      outcome: "QUERY_FAILED",
      errorCode: collection.errorCode,
      activeEmployees: null,
      selectedWeek: null,
      skippedNewerIncompleteWeeks: 0,
      days: [],
      totals: null,
      reviewQueue: null,
      note: "No se pudo completar el inventario agregado; no iniciar la marcha blanca.",
    };
  }
  if (collection.kind === "COMPANY_NOT_FOUND") {
    return {
      ...base,
      outcome: collection.companyMatches === 0 ? "ARCOTEX_NOT_FOUND" : "ARCOTEX_AMBIGUOUS",
      errorCode: null,
      activeEmployees: null,
      selectedWeek: null,
      skippedNewerIncompleteWeeks: 0,
      days: [],
      totals: null,
      reviewQueue: null,
      note: "La empresa ARCOTEX no pudo resolverse de forma única; no iniciar la marcha blanca.",
    };
  }
  if (collection.kind === "NO_COMPLETE_WEEK") {
    return {
      ...base,
      outcome: collection.activeEmployees === 0 ? "NO_ACTIVE_EMPLOYEES" : "NO_COMPLETE_COLLECTED_WEEK",
      errorCode: null,
      activeEmployees: collection.activeEmployees,
      selectedWeek: null,
      skippedNewerIncompleteWeeks: 0,
      days: [],
      totals: null,
      reviewQueue: null,
      note: `La semana cerrada más reciente (${collection.latestCompletedWeek.start} al ${collection.latestCompletedWeek.end}) tiene ${collection.latestWeekSuccessfulSyncDays}/7 días sincronizados; se revisaron ${collection.searchedWeeks} semanas.`,
    };
  }

  if (collection.days.length !== 7) {
    throw new Error("Una semana recolectada debe contener exactamente siete observaciones diarias.");
  }
  const expectedDates = datesInRange(collection.selectedWeek);
  if (collection.days.some((day, index) => day.date !== expectedDates[index])) {
    throw new Error("Las observaciones diarias no coinciden con la semana seleccionada.");
  }
  for (const day of collection.days) {
    for (const value of [
      day.successfulSyncRuns,
      day.rawEvents,
      day.attendanceRecords,
      day.ruleEngine.employeesProcessed,
      day.ruleEngine.attendanceDerived,
      day.ruleEngine.lateCandidates,
      day.ruleEngine.earlyDepartureCandidates,
      day.ruleEngine.overtimeCandidates,
      day.ruleEngine.withoutSchedule,
      day.ruleEngine.failureCount,
    ]) {
      if (!isNonNegativeInteger(value)) throw new Error("El preflight contiene un conteo diario inválido.");
    }
  }
  validateQueue(collection.reviewQueue.lateArrivals);
  validateQueue(collection.reviewQueue.earlyDepartures);
  validateQueue(collection.reviewQueue.overtime);
  validateQueue(collection.reviewQueue.absences);
  if (!isNonNegativeInteger(collection.activeEmployees) || !isNonNegativeInteger(collection.reviewQueue.missingPunchesPending)) {
    throw new Error("El preflight contiene un conteo agregado inválido.");
  }

  const rawEvents = collection.days.reduce((sum, day) => sum + day.rawEvents, 0);
  const attendanceRecords = collection.days.reduce((sum, day) => sum + day.attendanceRecords, 0);
  const ruleEngineSucceededDays = collection.days.filter((day) => day.ruleEngine.status === "SUCCEEDED").length;
  const ruleEngineFailureCount = collection.days.reduce((sum, day) => sum + day.ruleEngine.failureCount, 0);
  const pendingHumanReview = collection.reviewQueue.lateArrivals.pending
    + collection.reviewQueue.earlyDepartures.pending
    + collection.reviewQueue.overtime.pending
    + collection.reviewQueue.absences.pending
    + collection.reviewQueue.missingPunchesPending;

  let outcome: ArcotexAttendancePilotOutcome;
  if (collection.activeEmployees === 0) outcome = "NO_ACTIVE_EMPLOYEES";
  else if (rawEvents === 0) outcome = "NO_COLLECTED_ATTENDANCE";
  else if (attendanceRecords === 0) outcome = "NO_DERIVED_ATTENDANCE";
  else if (ruleEngineSucceededDays !== 7) outcome = "RULE_ENGINE_INCOMPLETE";
  else outcome = "READY_FOR_SHADOW_REVIEW";

  return {
    ...base,
    outcome,
    errorCode: null,
    activeEmployees: collection.activeEmployees,
    selectedWeek: collection.selectedWeek,
    skippedNewerIncompleteWeeks: collection.skippedNewerIncompleteWeeks,
    days: collection.days,
    totals: {
      rawEvents,
      attendanceRecords,
      ruleEngineSucceededDays,
      ruleEngineFailureCount,
      pendingHumanReview,
    },
    reviewQueue: collection.reviewQueue,
    note: collection.skippedNewerIncompleteWeeks > 0
      ? `Se omitieron ${collection.skippedNewerIncompleteWeeks} semana(s) más reciente(s) porque su recolección aún no estaba completa.`
      : "Se seleccionó la semana cerrada más reciente con recolección completa.",
  };
}

export function renderArcotexAttendancePilotReport(report: ArcotexAttendancePilotReport): string {
  const lines = [
    "GESTORA — preflight marcha blanca de asistencia ARCOTEX (solo lectura)",
    `Resultado: ${report.outcome}`,
    `Generado: ${report.generatedAt}`,
    `Alcance: ${report.scope}`,
    `Dotación activa actual: ${report.activeEmployees ?? "NO DISPONIBLE"}`,
    report.selectedWeek
      ? `Semana seleccionada: ${report.selectedWeek.start} al ${report.selectedWeek.end}`
      : "Semana seleccionada: NINGUNA",
    report.note,
  ];

  if (report.totals && report.reviewQueue) {
    lines.push(
      "",
      "Cobertura agregada:",
      `  - Marcaciones fuente vigentes: ${report.totals.rawEvents}`,
      `  - Registros diarios derivados vigentes: ${report.totals.attendanceRecords}`,
      `  - Motor de reglas completado: ${report.totals.ruleEngineSucceededDays}/7 días`,
      `  - Fallos registrados por el motor: ${report.totals.ruleEngineFailureCount}`,
      "",
      "Cola para revisión humana:",
      `  - Atrasos pendientes: ${report.reviewQueue.lateArrivals.pending}/${report.reviewQueue.lateArrivals.total}`,
      `  - Salidas anticipadas pendientes: ${report.reviewQueue.earlyDepartures.pending}/${report.reviewQueue.earlyDepartures.total}`,
      `  - Horas extra pendientes: ${report.reviewQueue.overtime.pending}/${report.reviewQueue.overtime.total}`,
      `  - Ausencias pendientes: ${report.reviewQueue.absences.pending}/${report.reviewQueue.absences.total}`,
      `  - Marcaciones faltantes pendientes: ${report.reviewQueue.missingPunchesPending}`,
      `  - Total pendiente de revisión humana: ${report.totals.pendingHumanReview}`,
      "",
      "Detalle diario agregado:",
      ...report.days.map((day) =>
        `  - ${day.date}: sync=${day.successfulSyncRuns}, fuente=${day.rawEvents}, derivados=${day.attendanceRecords}, reglas=${day.ruleEngine.status}, fallos=${day.ruleEngine.failureCount}`
      ),
    );
  }
  if (report.errorCode) lines.push("", `Código seguro de error: ${report.errorCode}`);
  lines.push("", ...report.constraints.map((constraint) => `! ${constraint}`));
  return lines.join("\n");
}
