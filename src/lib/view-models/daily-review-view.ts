import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { getDailyReview, type DailyReviewCategory, type CallerRole, type DailyReviewResult } from "../business-rules/daily-review";
import { resolveEffectiveSchedule, resolveTimeControlPolicy } from "../business-rules/schedule";
import { assertEmployeeAccessAllowed, type AreaCode } from "../access/scope";
import { formatTimeInSantiago } from "./date-utils";

/**
 * Capa de vista de Revisión Diaria (Fase 8, ampliada en Fase 8B.2). Envuelve
 * `getDailyReview` (Fase 7, sin modificar) y agrega exactamente los datos
 * adicionales que la work queue/el detalle necesitan mostrar -- nunca
 * recalcula atraso/OT/cumpleaños/prioridad de negocio, solo los presenta.
 *
 * PASO 5 del encargo de Fase 8B.2 (orden de prioridad): antes de ordenar se
 * auditó qué distingue "urgente" de "normal" en el backend real. Lo único
 * verificable de forma confiable es: (a) si una categoría tiene
 * `document_deadline` y esa fecha ya pasó ("vencido"), y (b) el tipo de
 * categoría en sí. No existe ningún campo de "prioridad"/"score" en ninguna
 * tabla -- el orden de abajo es 100% determinista y estático, documentado
 * aquí, nunca una heurística inventada en tiempo de ejecución.
 */

export interface DailyReviewCardViewModel {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode;
  clockIn: string | null;
  clockOut: string | null;
  categories: DailyReviewCategory[];
  needsReview: boolean;
  /** Categoría elegida para el contenido compacto de la card, según PENDING_PRIORITY_ORDER. */
  primaryCategory: DailyReviewCategory | null;
  primaryStatus: CaseStatus;
  lateMinutes: number | null;
  overtimeMinutes: number | null;
  earlyDepartureMinutes: number | null;
  /** Plazo de documento más próximo entre las categorías activas de este caso (si aplica). */
  documentDeadline: string | null;
  isOverdue: boolean;
}

export interface DailyReviewBoardViewModel {
  areaCode: AreaCode;
  date: string;
  cards: DailyReviewCardViewModel[];
  /** Conteos reales por filtro -- ver `computeFilterCounts`. */
  counts: FilterCounts;
}

export interface FilterCounts {
  todos: number;
  pendientes: number;
  revisados: number;
  atrasos: number;
  horasExtra: number;
  clockOut: number;
  salidaAnticipada: number;
  ausencias: number;
  documentos: number;
}

function categoryLabel(code: DailyReviewCategory | "OK"): string {
  switch (code) {
    case "LATE":
      return "Atraso";
    case "EARLY_DEPARTURE":
      return "Salida anticipada";
    case "MISSING_PUNCH":
      return "Clock out pendiente";
    case "ABSENCE":
      return "Licencia";
    case "OVERTIME_CANDIDATE":
      return "Horas extra";
    case "LICENSE_DOCUMENT_REQUIRED":
      return "Documento de licencia pendiente";
    case "MEDICAL_DOCUMENT_REQUIRED":
      return "Comprobante médico pendiente";
    case "OK":
      return "Sin novedades";
  }
}
export { categoryLabel };

export interface CaseCardContent {
  icon: string;
  title: string;
  subtitle: string;
}

/** Contenido compacto de card por categoría (Fase 8B.2, PASO 6) -- pura, sin acceso a datos, solo formatea lo que ya trae el card. */
export function buildCaseCardContent(card: DailyReviewCardViewModel): CaseCardContent {
  const clockInLabel = card.clockIn ? formatTimeInSantiago(card.clockIn) : "—";

  switch (card.primaryCategory) {
    case "LATE":
      return { icon: "⚠", title: "Atraso", subtitle: `${clockInLabel} · ${card.lateMinutes ?? "?"} min` };
    case "OVERTIME_CANDIDATE":
      return { icon: "◷", title: "Horas extra", subtitle: `${card.overtimeMinutes ?? "?"} min` };
    case "MISSING_PUNCH":
      return { icon: "●", title: "Clock out pendiente", subtitle: `Entrada ${clockInLabel}` };
    case "EARLY_DEPARTURE":
      return { icon: "●", title: "Salida anticipada", subtitle: `${card.earlyDepartureMinutes ?? "?"} min` };
    case "ABSENCE":
      return { icon: "●", title: "Licencia", subtitle: "Por confirmar" };
    case "LICENSE_DOCUMENT_REQUIRED":
      return { icon: "●", title: "Licencia", subtitle: "Respaldo pendiente" };
    case "MEDICAL_DOCUMENT_REQUIRED":
      return { icon: "●", title: "Salida médica", subtitle: "Comprobante pendiente" };
    default:
      return { icon: "✓", title: "Sin novedades", subtitle: "" };
  }
}

const CASE_STATUS_LABEL: Record<Exclude<CaseStatus, null>, string> = {
  PENDIENTE: "Pendiente",
  VENCIDO: "Vencido",
  REQUIERE_DOCUMENTO: "Requiere documento",
  REVISADO: "Revisado",
};

export function caseStatusLabel(status: CaseStatus): string {
  return status ? CASE_STATUS_LABEL[status] : "Revisado";
}

/**
 * Orden determinista de prioridad DENTRO de "Pendientes" (Fase 8B.2, PASO 5):
 *   1. Cualquier caso VENCIDO (deadline de documento ya pasado) -- sin importar la categoría.
 *   2. Licencia con documento de respaldo pendiente (ya se dijo "Sí", falta el papel).
 *   3. Salida anticipada médica con comprobante pendiente.
 *   4. Clock out pendiente (trabajador sin marcación de salida -- puede seguir "trabajando").
 *   5. Salida anticipada sin triage (aún no se decide si es médica/otra/injustificada).
 *   6. Atraso pendiente de justificar.
 *   7. Horas extra pendientes de aprobar.
 *   8. Licencia pendiente de confirmar si corresponde (Sí/No todavía sin responder).
 * Un caso puede tener varias categorías simultáneas -- se usa la de mayor prioridad
 * de esta lista para decidir dónde aparece y qué se muestra en la card compacta.
 */
export const PENDING_PRIORITY_ORDER: DailyReviewCategory[] = [
  "LICENSE_DOCUMENT_REQUIRED",
  "MEDICAL_DOCUMENT_REQUIRED",
  "MISSING_PUNCH",
  "EARLY_DEPARTURE",
  "LATE",
  "OVERTIME_CANDIDATE",
  "ABSENCE",
];

export type CaseStatus =
  | "PENDIENTE"
  | "VENCIDO"
  | "REQUIERE_DOCUMENTO"
  | "REVISADO"
  | null;

function pickPrimaryCategory(categories: DailyReviewCategory[]): DailyReviewCategory | null {
  return PENDING_PRIORITY_ORDER.find((c) => categories.includes(c)) ?? categories[0] ?? null;
}

export async function getDailyReviewBoard(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  areaCode: DailyReviewResult["groupCode"],
  date: string
): Promise<DailyReviewBoardViewModel> {
  const review = await getDailyReview(supabase, callerRole, areaCode, date);

  const allEmployees = [...review.requiresReview, ...review.noIssues];
  const employeeIds = allEmployees.map((e) => e.employeeId);
  const pendingIds = review.requiresReview.map((e) => e.employeeId);

  // ---------------------------------------------------------------------
  // Fase 8B.2, PASO 35 (performance): TODO lo de abajo es por lote (una
  // consulta por tabla para el board completo), nunca una consulta por
  // trabajador. El board puede tener decenas de casos.
  const [attendanceRes, lateRes, overtimeRes, earlyRes, absenceRes] = await Promise.all([
    employeeIds.length > 0
      ? supabase
          .from("attendance_records")
          .select("employee_id, actual_clock_in, actual_clock_out")
          .in("employee_id", employeeIds)
          .eq("work_date", date)
          .eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
    pendingIds.length > 0
      ? supabase.from("late_arrival_records").select("employee_id, detected_minutes").in("employee_id", pendingIds).eq("work_date", date).eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
    pendingIds.length > 0
      ? supabase.from("overtime_records").select("employee_id, candidate_minutes").in("employee_id", pendingIds).eq("work_date", date).eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
    pendingIds.length > 0
      ? supabase
          .from("early_departure_records")
          .select("employee_id, detected_minutes, early_departure_decisions(document_deadline, is_current)")
          .in("employee_id", pendingIds)
          .eq("work_date", date)
          .eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
    pendingIds.length > 0
      ? supabase
          .from("absence_records")
          .select("employee_id, absence_decisions(document_deadline, is_current)")
          .in("employee_id", pendingIds)
          .lte("start_date", date)
          .gte("end_date", date)
          .eq("is_current", true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const res of [attendanceRes, lateRes, overtimeRes, earlyRes, absenceRes]) {
    if (res.error) throw new Error(`getDailyReviewBoard: fallo leyendo datos del día: ${res.error.message}`);
  }

  const attendanceByEmployee = new Map<string, { clockIn: string | null; clockOut: string | null }>();
  for (const row of attendanceRes.data ?? []) attendanceByEmployee.set(row.employee_id, { clockIn: row.actual_clock_in, clockOut: row.actual_clock_out });

  const lateByEmployee = new Map((lateRes.data ?? []).map((r) => [r.employee_id, r.detected_minutes]));
  const overtimeByEmployee = new Map((overtimeRes.data ?? []).map((r) => [r.employee_id, r.candidate_minutes]));

  const earlyByEmployee = new Map<string, { minutes: number; deadline: string | null }>();
  for (const row of earlyRes.data ?? []) {
    const decisions = Array.isArray(row.early_departure_decisions) ? row.early_departure_decisions : [row.early_departure_decisions].filter(Boolean);
    const current = decisions.find((d) => d && d.is_current);
    earlyByEmployee.set(row.employee_id, { minutes: row.detected_minutes, deadline: current?.document_deadline ?? null });
  }

  const absenceDeadlineByEmployee = new Map<string, string | null>();
  for (const row of absenceRes.data ?? []) {
    const decisions = Array.isArray(row.absence_decisions) ? row.absence_decisions : [row.absence_decisions].filter(Boolean);
    const current = decisions.find((d) => d && d.is_current);
    absenceDeadlineByEmployee.set(row.employee_id, current?.document_deadline ?? null);
  }

  const cards: DailyReviewCardViewModel[] = allEmployees.map((entry) => {
    const attendance = attendanceByEmployee.get(entry.employeeId) ?? { clockIn: null, clockOut: null };
    const primaryCategory = pickPrimaryCategory(entry.categories);
    const needsReview = entry.categories.length > 0;

    let documentDeadline: string | null = null;
    if (entry.categories.includes("MEDICAL_DOCUMENT_REQUIRED")) documentDeadline = earlyByEmployee.get(entry.employeeId)?.deadline ?? null;
    else if (entry.categories.includes("LICENSE_DOCUMENT_REQUIRED")) documentDeadline = absenceDeadlineByEmployee.get(entry.employeeId) ?? null;
    const isOverdue = Boolean(documentDeadline && documentDeadline < date);

    let primaryStatus: CaseStatus = null;
    if (needsReview) primaryStatus = isOverdue ? "VENCIDO" : documentDeadline ? "REQUIERE_DOCUMENTO" : "PENDIENTE";

    return {
      employeeId: entry.employeeId,
      displayName: entry.displayName,
      areaCode: review.groupCode,
      clockIn: attendance.clockIn,
      clockOut: attendance.clockOut,
      categories: entry.categories,
      needsReview,
      primaryCategory,
      primaryStatus,
      lateMinutes: lateByEmployee.get(entry.employeeId) ?? null,
      overtimeMinutes: overtimeByEmployee.get(entry.employeeId) ?? null,
      earlyDepartureMinutes: earlyByEmployee.get(entry.employeeId)?.minutes ?? null,
      documentDeadline,
      isOverdue,
    };
  });

  return { areaCode: review.groupCode, date, cards, counts: computeFilterCounts(cards) };
}

export function computeFilterCounts(cards: DailyReviewCardViewModel[]): FilterCounts {
  return {
    todos: cards.length,
    pendientes: cards.filter((c) => c.needsReview).length,
    revisados: cards.filter((c) => !c.needsReview).length,
    atrasos: cards.filter((c) => c.categories.includes("LATE")).length,
    horasExtra: cards.filter((c) => c.categories.includes("OVERTIME_CANDIDATE")).length,
    clockOut: cards.filter((c) => c.categories.includes("MISSING_PUNCH")).length,
    salidaAnticipada: cards.filter((c) => c.categories.includes("EARLY_DEPARTURE")).length,
    ausencias: cards.filter((c) => c.categories.includes("ABSENCE")).length,
    documentos: cards.filter((c) => c.categories.includes("LICENSE_DOCUMENT_REQUIRED") || c.categories.includes("MEDICAL_DOCUMENT_REQUIRED")).length,
  };
}

/** Orden estable dentro de "Pendientes": VENCIDO primero, luego PENDING_PRIORITY_ORDER, estable por nombre dentro de cada grupo. */
export function sortPendingCards(cards: DailyReviewCardViewModel[]): DailyReviewCardViewModel[] {
  const withIndex = cards.map((card, i) => ({ card, i }));
  withIndex.sort((a, b) => {
    if (a.card.isOverdue !== b.card.isOverdue) return a.card.isOverdue ? -1 : 1;
    const aRank = a.card.primaryCategory ? PENDING_PRIORITY_ORDER.indexOf(a.card.primaryCategory) : PENDING_PRIORITY_ORDER.length;
    const bRank = b.card.primaryCategory ? PENDING_PRIORITY_ORDER.indexOf(b.card.primaryCategory) : PENDING_PRIORITY_ORDER.length;
    if (aRank !== bRank) return aRank - bRank;
    const nameCompare = a.card.displayName.localeCompare(b.card.displayName);
    if (nameCompare !== 0) return nameCompare;
    return a.i - b.i;
  });
  return withIndex.map((w) => w.card);
}

/**
 * Fase 8B.2, PASO 24 -- "Siguiente pendiente". Dado el orden ya calculado
 * por `sortPendingCards` y el caso recién decidido, devuelve el próximo
 * `employeeId` pendiente (nunca fuera del scope ya filtrado del supervisor).
 * `null` cuando no queda ningún pendiente -- la página debe mostrar el
 * empty state positivo, no intentar seleccionar nada.
 */
export function findNextPendingEmployeeId(sortedPendingCards: DailyReviewCardViewModel[], justDecidedEmployeeId: string): string | null {
  const remaining = sortedPendingCards.filter((c) => c.employeeId !== justDecidedEmployeeId);
  return remaining[0]?.employeeId ?? null;
}

// ---------------------------------------------------------------------------
// Detalle de un trabajador (drawer de revisión).

export interface DailyReviewDecisionAudit {
  status: string;
  decidedAt: string;
}

export interface DailyReviewDetailViewModel {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode;
  date: string;

  timeControl:
    | { kind: "NORMAL" }
    | { kind: "EXEMPT"; legalBasis: "NO_MARKING_REQUIRED" | "ARTICLE_22" | "OTHER" };

  schedule:
    | { kind: "SCHEDULED"; scheduledStart: string; scheduledEnd: string }
    | { kind: "DAY_OFF" }
    | { kind: "NO_SCHEDULE_ASSIGNED" }
    | { kind: "EXEMPT" };

  clockIn: string | null;
  clockOut: string | null;

  timeline: { label: string; timestamp: string; origin: string | null }[];

  lateArrival: {
    recordId: string;
    detectedMinutes: number;
    decision: { justified: boolean; payrollMinutes: number; reason: string | null; decidedAt: string } | null;
  } | null;

  earlyDeparture: {
    recordId: string;
    detectedMinutes: number;
    decision: {
      reasonCategory: string;
      documentRequired: boolean;
      documentDeadline: string | null;
      payrollEffect: string;
      reason: string | null;
      decidedAt: string;
    } | null;
  } | null;

  overtime: {
    recordId: string;
    candidateMinutes: number;
    decision: { status: string; approvedMinutes: number; rejectedMinutes: number; reason: string | null; decidedAt: string } | null;
    bonusAmount: number | null;
  } | null;

  absence: {
    recordId: string;
    absenceTypeName: string;
    startDate: string;
    endDate: string;
    decision: { status: string; documentRequired: boolean; documentDeadline: string | null; decidedAt: string } | null;
  } | null;

  missingPunch: boolean;
  /** Real (`employee_birthdays`), puramente informativo -- nunca se usa aquí para recalcular la regla de las 12:00 (esa decisión ya la tomó el motor al generar o no un candidato). */
  isBirthdayToday: boolean;
  documents: { id: string; documentType: string; originalFilename: string; uploadedAt: string }[];
}

export async function getDailyReviewDetail(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  employeeId: string,
  date: string
): Promise<DailyReviewDetailViewModel> {
  const areaCode = await assertEmployeeAccessAllowed(supabase, callerRole, employeeId);

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("id, display_name")
    .eq("id", employeeId)
    .single();
  if (employeeError || !employee) {
    throw new Error(`getDailyReviewDetail: empleado no encontrado (${employeeId}).`);
  }

  const [policy, effectiveSchedule, attendanceRes, lateRes, earlyRes, overtimeRes, absenceRes, missingPunchRes, documentsRes, birthdayRes, timelineRes] =
    await Promise.all([
      resolveTimeControlPolicy(supabase, employeeId, date),
      resolveEffectiveSchedule(supabase, employeeId, date),
      supabase
        .from("attendance_records")
        .select("actual_clock_in, actual_clock_out")
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("late_arrival_records")
        .select("id, detected_minutes, late_arrival_decisions(justified, payroll_minutes, reason, is_current, decided_at)")
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("early_departure_records")
        .select(
          "id, detected_minutes, early_departure_decisions(reason_category, document_required, document_deadline, payroll_effect, reason, is_current, decided_at)"
        )
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("overtime_records")
        .select(
          "id, candidate_minutes, overtime_decisions(decision_status, approved_minutes, rejected_minutes, reason, is_current, decided_at, employee_daily_bonuses(amount))"
        )
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("absence_records")
        .select("id, start_date, end_date, absence_types(name), absence_decisions(decision_status, document_required, document_deadline, is_current, decided_at)")
        .eq("employee_id", employeeId)
        .lte("start_date", date)
        .gte("end_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("attendance_missing_punch_flags")
        .select("status")
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .in("status", ["PENDING_CONTACT", "CONTACTED"])
        .maybeSingle(),
      supabase
        .from("supporting_documents")
        .select("id, document_type, original_filename, uploaded_at")
        .eq("employee_id", employeeId),
      supabase.from("employee_birthdays").select("birth_month, birth_day").eq("employee_id", employeeId).maybeSingle(),
      supabase
        .from("workera_attendance_events")
        .select("attendance_type_label, attendance_timestamp_interpreted, origin")
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .order("attendance_timestamp_interpreted", { ascending: true }),
    ]);

  for (const res of [attendanceRes, lateRes, earlyRes, overtimeRes, absenceRes, missingPunchRes, documentsRes, birthdayRes, timelineRes]) {
    if (res.error) throw new Error(`getDailyReviewDetail: fallo leyendo datos del día: ${res.error.message}`);
  }

  const timeControl: DailyReviewDetailViewModel["timeControl"] =
    policy.code === "EXEMPT_FROM_TIME_CONTROL" ? { kind: "EXEMPT", legalBasis: policy.legalBasis } : { kind: "NORMAL" };

  let schedule: DailyReviewDetailViewModel["schedule"];
  switch (effectiveSchedule.kind) {
    case "SCHEDULED":
      schedule = { kind: "SCHEDULED", scheduledStart: effectiveSchedule.scheduledStart, scheduledEnd: effectiveSchedule.scheduledEnd };
      break;
    case "DAY_OFF":
      schedule = { kind: "DAY_OFF" };
      break;
    case "EXEMPT":
      schedule = { kind: "EXEMPT" };
      break;
    default:
      schedule = { kind: "NO_SCHEDULE_ASSIGNED" };
  }

  const lateRow = lateRes.data;
  const lateDecisions = lateRow ? (Array.isArray(lateRow.late_arrival_decisions) ? lateRow.late_arrival_decisions : [lateRow.late_arrival_decisions].filter(Boolean)) : [];
  const currentLateDecision = lateDecisions.find((d) => d && d.is_current) ?? null;

  const earlyRow = earlyRes.data;
  const earlyDecisions = earlyRow ? (Array.isArray(earlyRow.early_departure_decisions) ? earlyRow.early_departure_decisions : [earlyRow.early_departure_decisions].filter(Boolean)) : [];
  const currentEarlyDecision = earlyDecisions.find((d) => d && d.is_current) ?? null;

  const overtimeRow = overtimeRes.data;
  const overtimeDecisionsRaw = overtimeRow ? (Array.isArray(overtimeRow.overtime_decisions) ? overtimeRow.overtime_decisions : [overtimeRow.overtime_decisions].filter(Boolean)) : [];
  const currentOvertimeDecision = overtimeDecisionsRaw.find((d) => d && d.is_current) ?? null;
  const bonusRows = currentOvertimeDecision
    ? Array.isArray(currentOvertimeDecision.employee_daily_bonuses)
      ? currentOvertimeDecision.employee_daily_bonuses
      : [currentOvertimeDecision.employee_daily_bonuses].filter(Boolean)
    : [];

  const absenceRow = absenceRes.data;
  const absenceDecisions = absenceRow ? (Array.isArray(absenceRow.absence_decisions) ? absenceRow.absence_decisions : [absenceRow.absence_decisions].filter(Boolean)) : [];
  const currentAbsenceDecision = absenceDecisions.find((d) => d && d.is_current) ?? null;
  const absenceTypeRelation = absenceRow ? (absenceRow.absence_types as { name: string } | { name: string }[] | null) : null;
  const absenceTypeName = (Array.isArray(absenceTypeRelation) ? absenceTypeRelation[0]?.name : absenceTypeRelation?.name) ?? "Ausencia";

  return {
    employeeId: employee.id,
    displayName: employee.display_name,
    areaCode,
    date,
    timeControl,
    schedule,
    clockIn: attendanceRes.data?.actual_clock_in ?? null,
    clockOut: attendanceRes.data?.actual_clock_out ?? null,
    timeline: (timelineRes.data ?? [])
      .filter((e) => e.attendance_timestamp_interpreted)
      .map((e) => ({ label: e.attendance_type_label, timestamp: e.attendance_timestamp_interpreted as string, origin: e.origin })),
    lateArrival: lateRow
      ? {
          recordId: lateRow.id,
          detectedMinutes: lateRow.detected_minutes,
          decision: currentLateDecision
            ? {
                justified: currentLateDecision.justified,
                payrollMinutes: currentLateDecision.payroll_minutes,
                reason: currentLateDecision.reason,
                decidedAt: currentLateDecision.decided_at,
              }
            : null,
        }
      : null,
    earlyDeparture: earlyRow
      ? {
          recordId: earlyRow.id,
          detectedMinutes: earlyRow.detected_minutes,
          decision: currentEarlyDecision
            ? {
                reasonCategory: currentEarlyDecision.reason_category,
                documentRequired: currentEarlyDecision.document_required,
                documentDeadline: currentEarlyDecision.document_deadline,
                payrollEffect: currentEarlyDecision.payroll_effect,
                reason: currentEarlyDecision.reason,
                decidedAt: currentEarlyDecision.decided_at,
              }
            : null,
        }
      : null,
    overtime: overtimeRow
      ? {
          recordId: overtimeRow.id,
          candidateMinutes: overtimeRow.candidate_minutes,
          decision: currentOvertimeDecision
            ? {
                status: currentOvertimeDecision.decision_status,
                approvedMinutes: currentOvertimeDecision.approved_minutes,
                rejectedMinutes: currentOvertimeDecision.rejected_minutes,
                reason: currentOvertimeDecision.reason,
                decidedAt: currentOvertimeDecision.decided_at,
              }
            : null,
          bonusAmount: bonusRows[0]?.amount ?? null,
        }
      : null,
    absence: absenceRow
      ? {
          recordId: absenceRow.id,
          absenceTypeName,
          startDate: absenceRow.start_date,
          endDate: absenceRow.end_date,
          decision: currentAbsenceDecision
            ? {
                status: currentAbsenceDecision.decision_status,
                documentRequired: currentAbsenceDecision.document_required,
                documentDeadline: currentAbsenceDecision.document_deadline,
                decidedAt: currentAbsenceDecision.decided_at,
              }
            : null,
        }
      : null,
    missingPunch: Boolean(missingPunchRes.data),
    isBirthdayToday: isBirthdayMatch(birthdayRes.data, date),
    documents: (documentsRes.data ?? []).map((d) => ({
      id: d.id,
      documentType: d.document_type,
      originalFilename: d.original_filename,
      uploadedAt: d.uploaded_at,
    })),
  };
}

function isBirthdayMatch(row: { birth_month: number; birth_day: number } | null | undefined, date: string): boolean {
  if (!row) return false;
  const [, month, day] = date.split("-").map(Number);
  return row.birth_month === month && row.birth_day === day;
}
