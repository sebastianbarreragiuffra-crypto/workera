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
  birthday: BirthdayContext | null = null
): Promise<GenerateEarlyDepartureResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") return { status: "EXEMPT", earlyDepartureRecordId: null, detectedMinutes: null };
  if (schedule.kind === "DAY_OFF") return { status: "DAY_OFF", earlyDepartureRecordId: null, detectedMinutes: null };
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    return { status: "NO_SCHEDULE_ASSIGNED", earlyDepartureRecordId: null, detectedMinutes: null };
  }
  if (!clockOut) return { status: "NO_CLOCK_OUT", earlyDepartureRecordId: null, detectedMinutes: null };

  const clockOutDate = new Date(clockOut);

  if (birthday && isBirthdayWeekdayAuthorizationApplicable(birthday, workDate)) {
    const departureTime = toWallClockTime(clockOutDate);
    if (isAfterBirthdayAuthorizationThreshold(departureTime)) {
      return { status: "AUTHORIZED_BIRTHDAY_NO_CANDIDATE", earlyDepartureRecordId: null, detectedMinutes: 0 };
    }
    // Antes de las 12:00 en el propio cumpleaños: sigue el flujo normal de abajo.
  }

  const rawMinutes = minutesBetween(schedule.scheduledEnd, clockOutDate);
  const detectedMinutes = Math.max(0, rawMinutes);

  if (detectedMinutes === 0) {
    return { status: "NO_EARLY_DEPARTURE", earlyDepartureRecordId: null, detectedMinutes: 0 };
  }

  const { data: existing, error: existingError } = await supabase
    .from("early_departure_records")
    .select("id, detected_minutes, calculation_version")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (existingError) {
    throw new Error(`generateEarlyDepartureCandidate: fallo consultando early_departure_records vigente: ${existingError.message}`);
  }
  if (existing && existing.detected_minutes === detectedMinutes) {
    return { status: "UNCHANGED", earlyDepartureRecordId: existing.id, detectedMinutes };
  }
  if (existing) {
    const { error: updateError } = await supabase
      .from("early_departure_records")
      .update({ is_current: false })
      .eq("id", existing.id);
    if (updateError) throw new Error(`generateEarlyDepartureCandidate: fallo versionando early_departure_records: ${updateError.message}`);
  }

  const { data: inserted, error: insertError } = await supabase
    .from("early_departure_records")
    .insert({
      employee_id: employeeId,
      work_date: workDate,
      attendance_record_id: attendanceRecordId,
      scheduled_end: schedule.scheduledEnd,
      actual_end: clockOut,
      detected_minutes: detectedMinutes,
      calculation_version: (existing?.calculation_version ?? 0) + 1,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`generateEarlyDepartureCandidate: fallo insertando early_departure_records: ${insertError?.message ?? "sin fila devuelta"}`);
  }

  return { status: "GENERATED", earlyDepartureRecordId: inserted.id, detectedMinutes };
}

/**
 * Calcula el plazo de comprobante médico (Fase 7, PASO 18): 3 días HÁBILES
 * desde la fecha de la decisión (no la fecha de la salida). Reexportado
 * desde business-days.ts para que el llamador no necesite dos imports.
 */
export { addBusinessDays } from "./business-days";
