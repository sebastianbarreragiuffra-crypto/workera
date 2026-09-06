import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import { resolveEffectiveEmployeeGroup } from "./effective-employee-group";
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

interface CandidateReconciliation {
  record_id: string | null;
  changed: boolean;
}

function parseReconciliation(data: unknown): CandidateReconciliation {
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { changed?: unknown }).changed !== "boolean" ||
    !(
      (data as { record_id?: unknown }).record_id === null ||
      typeof (data as { record_id?: unknown }).record_id === "string"
    )
  ) {
    throw new Error("generateLateArrivalCandidate: respuesta invalida del RPC atomico.");
  }
  return data as unknown as CandidateReconciliation;
}

async function reconcileLateArrival(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId: string | undefined,
  ruleEngineRunId: string | undefined,
  payload: {
    attendanceRecordId: string;
    scheduledStart: string;
    actualStart: string;
    detectedMinutes: number;
    policyId: string;
  } | null
): Promise<CandidateReconciliation> {
  const { data, error } = await supabase.rpc("reconcile_late_arrival_candidate", {
    p_company_id: companyId ?? null,
    p_rule_engine_run_id: ruleEngineRunId ?? null,
    p_employee_id: employeeId,
    p_work_date: workDate,
    p_attendance_record_id: payload?.attendanceRecordId ?? null,
    p_scheduled_start: payload?.scheduledStart ?? null,
    p_actual_start: payload?.actualStart ?? null,
    p_detected_minutes: payload?.detectedMinutes ?? null,
    p_late_arrival_policy_id: payload?.policyId ?? null,
  });
  if (error) {
    throw new Error(`generateLateArrivalCandidate: fallo reconciliando atraso: ${error.message}`);
  }
  return parseReconciliation(data);
}

/**
 * Retira un atraso calculado que ya no tiene causa. Se expone para que el
 * orquestador pueda limpiar un feriado trabajado, donde deliberadamente no
 * debe ejecutar la comparación contra el horario ordinario.
 */
export async function retireCurrentLateArrivalCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<boolean> {
  return (await reconcileLateArrival(supabase, employeeId, workDate, companyId, ruleEngineRunId, null)).changed;
}

export async function generateLateArrivalCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockIn: string | null,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<GenerateLateArrivalResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "EXEMPT", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "DAY_OFF") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "DAY_OFF", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_SCHEDULE_ASSIGNED", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (!clockIn) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_CLOCK_IN", lateArrivalRecordId: null, detectedMinutes: null };
  }
  if (!companyId?.trim()) {
    throw new Error("generateLateArrivalCandidate: companyId es obligatorio para resolver el grupo histórico.");
  }

  const employeeGroup = await resolveEffectiveEmployeeGroup(supabase, employeeId, workDate, companyId);

  const [year, month, day] = workDate.split("-").map(Number);
  const workDateDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const { data: policy, error: policyError } = await supabase
    .from("late_arrival_policies")
    .select("id, tolerance_minutes")
    .eq("employee_group_id", employeeGroup.id)
    .eq("day_of_week", workDateDow)
    .lte("effective_from", workDate)
    .or(`effective_to.is.null,effective_to.gte.${workDate}`)
    .maybeSingle();

  if (policyError) {
    throw new Error(`generateLateArrivalCandidate: fallo consultando late_arrival_policies: ${policyError.message}`);
  }
  if (!policy) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_POLICY", lateArrivalRecordId: null, detectedMinutes: null };
  }

  const rawMinutes = minutesBetween(schedule.scheduledStart, new Date(clockIn));
  const detectedMinutes = Math.max(0, rawMinutes - policy.tolerance_minutes);

  if (detectedMinutes === 0) {
    await retireCurrentLateArrivalCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_LATE", lateArrivalRecordId: null, detectedMinutes: 0 };
  }

  const reconciled = await reconcileLateArrival(supabase, employeeId, workDate, companyId, ruleEngineRunId, {
    attendanceRecordId,
    scheduledStart: schedule.scheduledStart,
    actualStart: clockIn,
    detectedMinutes,
    policyId: policy.id,
  });
  if (!reconciled.record_id) {
    throw new Error("generateLateArrivalCandidate: el RPC atomico no devolvio el candidato vigente.");
  }

  return {
    status: reconciled.changed ? "GENERATED" : "UNCHANGED",
    lateArrivalRecordId: reconciled.record_id,
    detectedMinutes,
  };
}
