import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import { resolveEffectiveEmployeeGroup } from "./effective-employee-group";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes } from "./wall-clock";

/**
 * Generación de candidato de horas extra (Fase 7, PASO 34-37). Reutiliza
 * `overtime_records`/`overtime_policies`/el motor de aprobación ya
 * construido en Gate D (clasificación HH50/HH100 y topes pagables por
 * área/día) SIN modificarlo -- este servicio solo produce
 * la fila candidato (`overtime_records.candidate_minutes`), que hoy no
 * generaba nada automáticamente (confirmado por auditoría: Gate D solo
 * construyó la capa de aprobación sobre un valor ya existente).
 *
 * Fórmula confirmada (docs/BUSINESS_RULES_PRE_PHASE2.md §6-7):
 *   raw_overtime_minutes = clock_out - scheduled_end (horario EFECTIVO,
 *     nunca 17:00 fijo)
 *   candidate_overtime_minutes = MAX(0, raw)
 *
 * El candidato conserva SIEMPRE el tiempo real. El límite de la política se
 * aplica recién al decidir las horas pagables; recortar acá destruía la
 * evidencia necesaria para alertar 2:01 o 6:01 y para auditar real vs pago.
 *
 * Alcance por grupo (PASO 34-37, decisión explícita, no una detección
 * heurística de "horario estándar vs individual" -- la política de
 * PRODUCTION ya cubre horarios individuales correctamente vía
 * resolveEffectiveSchedule, así que "primero determinar si la política
 * existente permite overtime respecto de su effective scheduled end" se
 * satisface mecánicamente para PRODUCTION sin necesitar un caso especial):
 *   - PRODUCTION: política confirmada (Gate D) -- genera candidato normal,
 *     usando SIEMPRE el horario efectivo del trabajador (individual o
 *     general).
 *   - INSTALLATION: genera los minutos exactos sin recortarlos. Lunes a
 *     sábado se topan al aprobar; domingo HH100 no tiene tope fijo.
 *   - Días libres/feriados trabajados: el candidato es el tramo real entre
 *     entrada y salida, porque no existe una salida programada que restar.
 *   - ADMINISTRATION: `overtime_eligible=false` ya confirmado -- nunca
 *     elegible.
 */

export type GenerateOvertimeCandidateStatus =
  | "GENERATED"
  | "NO_OVERTIME"
  | "UNCHANGED"
  | "EXEMPT"
  | "DAY_OFF"
  | "NO_SCHEDULE_ASSIGNED"
  | "NO_CLOCK_OUT"
  | "NO_CLOCK_IN"
  | "NOT_ELIGIBLE"
  | "NO_POLICY"
  | "OVERTIME_POLICY_REQUIRES_CONFIRMATION";

export interface GenerateOvertimeCandidateResult {
  status: GenerateOvertimeCandidateStatus;
  overtimeRecordId: string | null;
  candidateMinutes: number | null;
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
    throw new Error("generateOvertimeCandidate: respuesta invalida del RPC atomico.");
  }
  return data as unknown as CandidateReconciliation;
}

async function reconcileOvertime(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId: string | undefined,
  ruleEngineRunId: string | undefined,
  payload: {
    attendanceRecordId: string;
    candidateMinutes: number;
    policyId: string;
  } | null
): Promise<CandidateReconciliation> {
  const { data, error } = await supabase.rpc("reconcile_overtime_candidate", {
    p_company_id: companyId ?? null,
    p_rule_engine_run_id: ruleEngineRunId ?? null,
    p_employee_id: employeeId,
    p_work_date: workDate,
    p_attendance_record_id: payload?.attendanceRecordId ?? null,
    p_candidate_minutes: payload?.candidateMinutes ?? null,
    p_overtime_policy_id: payload?.policyId ?? null,
  });
  if (error) {
    throw new Error(`generateOvertimeCandidate: fallo reconciliando horas extra: ${error.message}`);
  }
  return parseReconciliation(data);
}

/**
 * Un resultado sin candidato también es un recálculo autoritativo. Mantener la
 * versión anterior como vigente haría que la cola siguiera ofreciendo horas
 * que la marcación/política actual ya no respalda.
 */
async function retireCurrentOvertimeRecord(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<void> {
  await reconcileOvertime(supabase, employeeId, workDate, companyId, ruleEngineRunId, null);
}

/** Grupos con política de overtime confirmada y lista para calcular automáticamente. */
const AUTO_GENERATE_GROUP_CODES = new Set(["PRODUCTION", "INSTALLATION"]);

/** Minutos entre la marcación de salida real y el horario de salida efectivo, en hora de pared de Santiago (ver wall-clock.ts). */
function minutesBetween(scheduledEnd: string, clockOut: Date): number {
  return santiagoWallClockMinutesSinceMidnight(clockOut) - scheduledTimeToMinutes(scheduledEnd);
}

/** Minutos efectivamente trabajados cuando el día no tiene una salida programada. */
function minutesBetweenInstants(clockIn: string, clockOut: string): number {
  return Math.floor((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60_000);
}

export async function generateOvertimeCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockOut: string | null,
  clockIn: string | null = null,
  isHoliday = false,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<GenerateOvertimeCandidateResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "EXEMPT", overtimeRecordId: null, candidateMinutes: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_SCHEDULE_ASSIGNED", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!clockOut) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_CLOCK_OUT", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!companyId?.trim()) {
    throw new Error("generateOvertimeCandidate: companyId es obligatorio para resolver el grupo histórico.");
  }

  const employeeGroup = await resolveEffectiveEmployeeGroup(supabase, employeeId, workDate, companyId);
  const groupCode = employeeGroup.code;

  if (!AUTO_GENERATE_GROUP_CODES.has(groupCode)) {
    if (groupCode === "ADMINISTRATION") {
      await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
      return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };
    }
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "OVERTIME_POLICY_REQUIRES_CONFIRMATION", overtimeRecordId: null, candidateMinutes: null };
  }

  const usesWorkedSpan = schedule.kind === "DAY_OFF" || isHoliday;
  if (usesWorkedSpan && !clockIn) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_CLOCK_IN", overtimeRecordId: null, candidateMinutes: null };
  }

  const [year, month, day] = workDate.split("-").map(Number);
  const workDateDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const { data: policy, error: policyError } = await supabase
    .from("overtime_policies")
    .select("id, overtime_eligible, max_overtime_minutes")
    .eq("employee_group_id", employeeGroup.id)
    .eq("day_of_week", workDateDow)
    .lte("effective_from", workDate)
    .or(`effective_to.is.null,effective_to.gte.${workDate}`)
    .maybeSingle();

  if (policyError) {
    throw new Error(`generateOvertimeCandidate: fallo consultando overtime_policies: ${policyError.message}`);
  }
  if (!policy) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_POLICY", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!policy.overtime_eligible) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };
  }

  const rawMinutes = schedule.kind === "SCHEDULED" && !isHoliday
    ? minutesBetween(schedule.scheduledEnd, new Date(clockOut))
    : minutesBetweenInstants(clockIn!, clockOut);
  if (!Number.isFinite(rawMinutes)) {
    throw new Error("generateOvertimeCandidate: marcaciones inválidas para calcular horas extra.");
  }
  const candidateMinutes = Math.max(0, rawMinutes);

  if (candidateMinutes === 0) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_OVERTIME", overtimeRecordId: null, candidateMinutes: 0 };
  }

  const reconciled = await reconcileOvertime(supabase, employeeId, workDate, companyId, ruleEngineRunId, {
    attendanceRecordId,
    candidateMinutes,
    policyId: policy.id,
  });
  if (!reconciled.record_id) {
    throw new Error("generateOvertimeCandidate: el RPC atomico no devolvio el candidato vigente.");
  }

  return {
    status: reconciled.changed ? "GENERATED" : "UNCHANGED",
    overtimeRecordId: reconciled.record_id,
    candidateMinutes,
  };
}
