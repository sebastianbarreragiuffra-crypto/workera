import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { getDailyReview, type DailyReviewCategory, type CallerRole, type DailyReviewResult } from "../business-rules/daily-review";
import { resolveEffectiveSchedule, resolveTimeControlPolicy } from "../business-rules/schedule";
import { assertEmployeeAccessAllowed, type AreaCode } from "../access/scope";

/**
 * Capa de vista (Fase 8, PASO 2 del encargo: "definir DTOs/view-models
 * necesarios para UI... preferir adaptar backend->UI en server/service
 * layer"). Envuelve `getDailyReview` (Fase 7, sin modificar) y agrega
 * exactamente los datos adicionales que la tarjeta/drawer necesitan
 * mostrar -- nunca recalcula atraso/OT/cumpleaños, solo los presenta.
 */

export interface DailyReviewCardViewModel {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode;
  clockIn: string | null;
  clockOut: string | null;
  categories: DailyReviewCategory[];
  needsReview: boolean;
}

export interface DailyReviewBoardViewModel {
  areaCode: AreaCode;
  date: string;
  cards: DailyReviewCardViewModel[];
}

function categoryLabel(code: DailyReviewCategory | "OK"): string {
  switch (code) {
    case "LATE":
      return "Atraso";
    case "EARLY_DEPARTURE":
      return "Salida anticipada";
    case "MISSING_PUNCH":
      return "Marcación faltante";
    case "ABSENCE":
      return "Ausencia";
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

export async function getDailyReviewBoard(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  areaCode: DailyReviewResult["groupCode"],
  date: string
): Promise<DailyReviewBoardViewModel> {
  const review = await getDailyReview(supabase, callerRole, areaCode, date);

  const allEmployees = [...review.requiresReview, ...review.noIssues];
  const employeeIds = allEmployees.map((e) => e.employeeId);

  const attendanceByEmployee = new Map<string, { clockIn: string | null; clockOut: string | null }>();
  if (employeeIds.length > 0) {
    const { data: attendanceRows, error } = await supabase
      .from("attendance_records")
      .select("employee_id, actual_clock_in, actual_clock_out")
      .in("employee_id", employeeIds)
      .eq("work_date", date)
      .eq("is_current", true);
    if (error) throw new Error(`getDailyReviewBoard: fallo leyendo attendance_records: ${error.message}`);
    for (const row of attendanceRows ?? []) {
      attendanceByEmployee.set(row.employee_id, { clockIn: row.actual_clock_in, clockOut: row.actual_clock_out });
    }
  }

  const cards: DailyReviewCardViewModel[] = allEmployees.map((entry) => {
    const attendance = attendanceByEmployee.get(entry.employeeId) ?? { clockIn: null, clockOut: null };
    return {
      employeeId: entry.employeeId,
      displayName: entry.displayName,
      areaCode: review.groupCode,
      clockIn: attendance.clockIn,
      clockOut: attendance.clockOut,
      categories: entry.categories,
      needsReview: entry.categories.length > 0,
    };
  });

  // requiresReview primero (ya viene en ese orden porque concatenamos
  // requiresReview + noIssues), estable por nombre dentro de cada grupo.
  return { areaCode: review.groupCode, date, cards };
}

// ---------------------------------------------------------------------------
// Detalle de un trabajador (drawer de revisión).

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

  lateArrival: {
    recordId: string;
    detectedMinutes: number;
    decision: { justified: boolean; payrollMinutes: number; reason: string | null } | null;
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
    } | null;
  } | null;

  overtime: {
    recordId: string;
    candidateMinutes: number;
    decision: { status: string; approvedMinutes: number; rejectedMinutes: number; reason: string | null } | null;
    bonusAmount: number | null;
  } | null;

  absence: {
    recordId: string;
    decision: { status: string; documentRequired: boolean; documentDeadline: string | null } | null;
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

  const [policy, effectiveSchedule, attendanceRes, lateRes, earlyRes, overtimeRes, absenceRes, missingPunchRes, documentsRes, birthdayRes] =
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
        .select("id, detected_minutes, late_arrival_decisions(justified, payroll_minutes, reason, is_current)")
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("early_departure_records")
        .select(
          "id, detected_minutes, early_departure_decisions(reason_category, document_required, document_deadline, payroll_effect, reason, is_current)"
        )
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("overtime_records")
        .select(
          "id, candidate_minutes, overtime_decisions(decision_status, approved_minutes, rejected_minutes, reason, is_current, employee_daily_bonuses(amount))"
        )
        .eq("employee_id", employeeId)
        .eq("work_date", date)
        .eq("is_current", true)
        .maybeSingle(),
      supabase
        .from("absence_records")
        .select("id, absence_decisions(decision_status, document_required, document_deadline, is_current)")
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
    ]);

  for (const res of [attendanceRes, lateRes, earlyRes, overtimeRes, absenceRes, missingPunchRes, documentsRes, birthdayRes]) {
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

  return {
    employeeId: employee.id,
    displayName: employee.display_name,
    areaCode,
    date,
    timeControl,
    schedule,
    clockIn: attendanceRes.data?.actual_clock_in ?? null,
    clockOut: attendanceRes.data?.actual_clock_out ?? null,
    lateArrival: lateRow
      ? {
          recordId: lateRow.id,
          detectedMinutes: lateRow.detected_minutes,
          decision: currentLateDecision
            ? { justified: currentLateDecision.justified, payrollMinutes: currentLateDecision.payroll_minutes, reason: currentLateDecision.reason }
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
              }
            : null,
          bonusAmount: bonusRows[0]?.amount ?? null,
        }
      : null,
    absence: absenceRow
      ? {
          recordId: absenceRow.id,
          decision: currentAbsenceDecision
            ? {
                status: currentAbsenceDecision.decision_status,
                documentRequired: currentAbsenceDecision.document_required,
                documentDeadline: currentAbsenceDecision.document_deadline,
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
