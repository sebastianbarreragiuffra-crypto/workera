import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes } from "./wall-clock";

/**
 * Motor de atraso (Fase 7, PASO 13/14). Genera candidatos en
 * `late_arrival_records` (Fase 2A, reutilizada tal cual) comparando la
 * PRIMERA marcación de entrada válida contra el horario EFECTIVO (nunca
 * 07:30 fijo -- horario individual/exención resuelto vía
 * resolveEffectiveSchedule). Fórmula confirmada
 * (docs/BUSINESS_RULES_PRE_PHASE2.md §13):
 *
 *   detected_minutes = MAX(0, (clock_in - scheduled_start) - tolerance_minutes)
 */

export type GenerateLateArrivalStatus =
  | "GENERATED"
  | "NO_LATE"
  | "UNCHANGED"
  | "EXEMPT"
  | "DAY_OFF"
  | "NO_SCHEDULE_ASSIGNED"
  | "NO_CLOCK_IN"
  | "NO_POLICY";

export interface GenerateLateArrivalResult {
  status: GenerateLateArrivalStatus;
  lateArrivalRecordId: string | null;
  detectedMinutes: number | null;
}

/**
 * Minutos entre el horario de entrada efectivo y la marcación real, en la
 * hora de PARED de America/Santiago (nunca leyendo `.getUTCHours()` sobre
 * el instante -- ver wall-clock.ts).
 */
function minutesBetween(scheduledStart: string, clockIn: Date): number {
  return santiagoWallClockMinutesSinceMidnight(clockIn) - scheduledTimeToMinutes(scheduledStart);
}

export async function generateLateArrivalCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockIn: string | null
): Promise<GenerateLateArrivalResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") return { status: "EXEMPT", lateArrivalRecordId: null, detectedMinutes: null };
  if (schedule.kind === "DAY_OFF") return { status: "DAY_OFF", lateArrivalRecordId: null, detectedMinutes: null };
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    return { status: "NO_SCHEDULE_ASSIGNED", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (!clockIn) return { status: "NO_CLOCK_IN", lateArrivalRecordId: null, detectedMinutes: null };

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("employee_group_id")
    .eq("id", employeeId)
    .single();
  if (employeeError || !employee?.employee_group_id) {
    throw new Error(`generateLateArrivalCandidate: fallo resolviendo employee_group_id: ${employeeError?.message ?? "sin grupo"}`);
  }

  const [year, month, day] = workDate.split("-").map(Number);
  const workDateDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const { data: policy, error: policyError } = await supabase
    .from("late_arrival_policies")
    .select("id, tolerance_minutes")
    .eq("employee_group_id", employee.employee_group_id)
    .eq("day_of_week", workDateDow)
    .lte("effective_from", workDate)
    .or(`effective_to.is.null,effective_to.gte.${workDate}`)
    .maybeSingle();

  if (policyError) {
    throw new Error(`generateLateArrivalCandidate: fallo consultando late_arrival_policies: ${policyError.message}`);
  }
  if (!policy) return { status: "NO_POLICY", lateArrivalRecordId: null, detectedMinutes: null };

  const rawMinutes = minutesBetween(schedule.scheduledStart, new Date(clockIn));
  const detectedMinutes = Math.max(0, rawMinutes - policy.tolerance_minutes);

  if (detectedMinutes === 0) {
    return { status: "NO_LATE", lateArrivalRecordId: null, detectedMinutes: 0 };
  }

  const { data: existing, error: existingError } = await supabase
    .from("late_arrival_records")
    .select("id, detected_minutes, calculation_version")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (existingError) {
    throw new Error(`generateLateArrivalCandidate: fallo consultando late_arrival_records vigente: ${existingError.message}`);
  }
  if (existing && existing.detected_minutes === detectedMinutes) {
    return { status: "UNCHANGED", lateArrivalRecordId: existing.id, detectedMinutes };
  }
  if (existing) {
    const { error: updateError } = await supabase
      .from("late_arrival_records")
      .update({ is_current: false })
      .eq("id", existing.id);
    if (updateError) throw new Error(`generateLateArrivalCandidate: fallo versionando late_arrival_records: ${updateError.message}`);
  }

  const { data: inserted, error: insertError } = await supabase
    .from("late_arrival_records")
    .insert({
      employee_id: employeeId,
      work_date: workDate,
      attendance_record_id: attendanceRecordId,
      scheduled_start: schedule.scheduledStart,
      actual_start: clockIn,
      detected_minutes: detectedMinutes,
      late_arrival_policy_id: policy.id,
      calculation_version: (existing?.calculation_version ?? 0) + 1,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`generateLateArrivalCandidate: fallo insertando late_arrival_records: ${insertError?.message ?? "sin fila devuelta"}`);
  }

  return { status: "GENERATED", lateArrivalRecordId: inserted.id, detectedMinutes };
}
