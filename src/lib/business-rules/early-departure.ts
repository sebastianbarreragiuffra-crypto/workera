import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import {
  isBirthdayWeekdayAuthorizationApplicable,
  isAfterBirthdayAuthorizationThreshold,
  type BirthdayContext,
} from "./birthday";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes } from "./wall-clock";

/**
 * Motor de salida anticipada (Fase 7, PASO 16/29-32). Genera candidatos en
 * `early_departure_records` comparando la ÚLTIMA marcación de salida válida
 * contra el horario EFECTIVO (nunca 17:00 fijo). Sin política de tolerancia
 * documentada para salida anticipada (a diferencia de atraso) -- cualquier
 * salida antes del horario efectivo es candidata.
 *
 * No genera nada para EXEMPT_FROM_TIME_CONTROL ni para un día sin turno.
 */

export type GenerateEarlyDepartureStatus =
  | "GENERATED"
  | "AUTHORIZED_BIRTHDAY_NO_CANDIDATE"
  | "NO_EARLY_DEPARTURE"
  | "UNCHANGED"
  | "EXEMPT"
  | "DAY_OFF"
  | "NO_SCHEDULE_ASSIGNED"
  | "NO_CLOCK_OUT";

export interface GenerateEarlyDepartureResult {
  status: GenerateEarlyDepartureStatus;
  earlyDepartureRecordId: string | null;
  detectedMinutes: number | null;
}

/** Minutos entre el horario de salida efectivo y la marcación real, en hora de pared de Santiago (ver wall-clock.ts). */
function minutesBetween(scheduledEnd: string, clockOut: Date): number {
  return scheduledTimeToMinutes(scheduledEnd) - santiagoWallClockMinutesSinceMidnight(clockOut);
}

function toWallClockTime(instant: Date): string {
  const totalMinutes = santiagoWallClockMinutesSinceMidnight(instant);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
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
    throw new Error("generateEarlyDepartureCandidate: respuesta invalida del RPC atomico.");
  }
  return data as unknown as CandidateReconciliation;
}

async function reconcileEarlyDeparture(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId: string | undefined,
  ruleEngineRunId: string | undefined,
  payload: {
    attendanceRecordId: string;
    scheduledEnd: string;
    actualEnd: string;
    detectedMinutes: number;
  } | null
): Promise<CandidateReconciliation> {
  const { data, error } = await supabase.rpc("reconcile_early_departure_candidate", {
    p_company_id: companyId ?? null,
    p_rule_engine_run_id: ruleEngineRunId ?? null,
    p_employee_id: employeeId,
    p_work_date: workDate,
    p_attendance_record_id: payload?.attendanceRecordId ?? null,
    p_scheduled_end: payload?.scheduledEnd ?? null,
    p_actual_end: payload?.actualEnd ?? null,
    p_detected_minutes: payload?.detectedMinutes ?? null,
  });
  if (error) {
    throw new Error(`generateEarlyDepartureCandidate: fallo reconciliando salida anticipada: ${error.message}`);
  }
  return parseReconciliation(data);
}

/**
 * Retira una salida anticipada calculada que ya no tiene causa. El
 * orquestador la usa al procesar feriados trabajados, donde no existe una
 * hora ordinaria de salida contra la cual comparar.
 */
export async function retireCurrentEarlyDepartureCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<boolean> {
  return (await reconcileEarlyDeparture(supabase, employeeId, workDate, companyId, ruleEngineRunId, null)).changed;
}

/**
 * `birthday`, si se pasa, aplica la autorización de cumpleaños (PASO 29-32)
 * ANTES de generar un candidato: una salida en o después de las 12:00 en el
 * propio cumpleaños (lunes-viernes) nunca se convierte en candidato de
 * salida anticipada -- PASO 31 ("no pedir comprobante médico, no marcarlo
 * como salida injustificada"). Antes de las 12:00 sigue evaluándose como
 * candidata normal (PASO 32).
 */
export async function generateEarlyDepartureCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockOut: string | null,
  birthday: BirthdayContext | null = null,
  companyId?: string,
  ruleEngineRunId?: string
): Promise<GenerateEarlyDepartureResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "EXEMPT", earlyDepartureRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "DAY_OFF") {
    await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "DAY_OFF", earlyDepartureRecordId: null, detectedMinutes: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_SCHEDULE_ASSIGNED", earlyDepartureRecordId: null, detectedMinutes: null };
  }
  if (!clockOut) {
    await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_CLOCK_OUT", earlyDepartureRecordId: null, detectedMinutes: null };
  }

  const clockOutDate = new Date(clockOut);

  if (birthday && isBirthdayWeekdayAuthorizationApplicable(birthday, workDate)) {
    const departureTime = toWallClockTime(clockOutDate);
    if (isAfterBirthdayAuthorizationThreshold(departureTime)) {
      await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
      return { status: "AUTHORIZED_BIRTHDAY_NO_CANDIDATE", earlyDepartureRecordId: null, detectedMinutes: 0 };
    }
    // Antes de las 12:00 en el propio cumpleaños: sigue el flujo normal de abajo.
  }

  const rawMinutes = minutesBetween(schedule.scheduledEnd, clockOutDate);
  const detectedMinutes = Math.max(0, rawMinutes);

  if (detectedMinutes === 0) {
    await retireCurrentEarlyDepartureCandidate(supabase, employeeId, workDate, companyId, ruleEngineRunId);
    return { status: "NO_EARLY_DEPARTURE", earlyDepartureRecordId: null, detectedMinutes: 0 };
  }

  const reconciled = await reconcileEarlyDeparture(supabase, employeeId, workDate, companyId, ruleEngineRunId, {
    attendanceRecordId,
    scheduledEnd: schedule.scheduledEnd,
    actualEnd: clockOut,
    detectedMinutes,
  });
  if (!reconciled.record_id) {
    throw new Error("generateEarlyDepartureCandidate: el RPC atomico no devolvio el candidato vigente.");
  }

  return {
    status: reconciled.changed ? "GENERATED" : "UNCHANGED",
    earlyDepartureRecordId: reconciled.record_id,
    detectedMinutes,
  };
}

/**
 * Calcula el plazo de comprobante médico (Fase 7, PASO 18): 3 días HÁBILES
 * desde la fecha de la decisión (no la fecha de la salida). Reexportado
 * desde business-days.ts para que el llamador no necesite dos imports.
 */
export { addBusinessDays } from "./business-days";
