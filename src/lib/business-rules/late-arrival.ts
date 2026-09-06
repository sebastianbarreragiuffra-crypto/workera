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

type CurrentLateArrival = Pick<
  Database["public"]["Tables"]["late_arrival_records"]["Row"],
  | "id"
  | "attendance_record_id"
  | "scheduled_start"
  | "actual_start"
  | "detected_minutes"
  | "late_arrival_policy_id"
  | "calculation_version"
>;

async function loadCurrentLateArrival(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string
): Promise<CurrentLateArrival | null> {
  const { data, error } = await supabase
    .from("late_arrival_records")
    .select(
      "id, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id, calculation_version"
    )
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (error) {
    throw new Error(`generateLateArrivalCandidate: fallo consultando late_arrival_records vigente: ${error.message}`);
  }
  return data;
}

async function retireLoadedLateArrival(
  supabase: SupabaseClient<Database>,
  current: CurrentLateArrival | null
): Promise<boolean> {
  if (!current) return false;
  const { error } = await supabase
    .from("late_arrival_records")
    .update({ is_current: false })
    .eq("id", current.id)
    .eq("is_current", true);
  if (error) {
    throw new Error(`generateLateArrivalCandidate: fallo retirando late_arrival_records vigente: ${error.message}`);
  }
  return true;
}

/**
 * Retira un atraso calculado que ya no tiene causa. Se expone para que el
 * orquestador pueda limpiar un feriado trabajado, donde deliberadamente no
 * debe ejecutar la comparación contra el horario ordinario.
 */
export async function retireCurrentLateArrivalCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string
): Promise<boolean> {
  return retireLoadedLateArrival(supabase, await loadCurrentLateArrival(supabase, employeeId, workDate));
}

function sameInstant(left: string, right: string): boolean {
  return new Date(left).getTime() === new Date(right).getTime();
}

export async function generateLateArrivalCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockIn: string | null
): Promise<GenerateLateArrivalResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "EXEMPT", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "DAY_OFF") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "DAY_OFF", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "NO_SCHEDULE_ASSIGNED", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (!clockIn) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "NO_CLOCK_IN", lateArrivalRecordId: null, detectedMinutes: null };
  }

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
  if (!policy) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "NO_POLICY", lateArrivalRecordId: null, detectedMinutes: null };
  }

  const rawMinutes = minutesBetween(schedule.scheduledStart, new Date(clockIn));
  const detectedMinutes = Math.max(0, rawMinutes - policy.tolerance_minutes);

  if (detectedMinutes === 0) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate);
    return { status: "NO_LATE", lateArrivalRecordId: null, detectedMinutes: 0 };
  }

  const existing = await loadCurrentLateArrival(supabase, employeeId, workDate);
  if (
    existing &&
    existing.attendance_record_id === attendanceRecordId &&
    scheduledTimeToMinutes(existing.scheduled_start) === scheduledTimeToMinutes(schedule.scheduledStart) &&
    sameInstant(existing.actual_start, clockIn) &&
    existing.detected_minutes === detectedMinutes &&
    existing.late_arrival_policy_id === policy.id
  ) {
    return { status: "UNCHANGED", lateArrivalRecordId: existing.id, detectedMinutes };
  }
  if (existing) {
    await retireLoadedLateArrival(supabase, existing);
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
