import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { santiagoWallClockToInstant } from "../business-rules/wall-clock";
import { nextDate } from "../view-models/date-utils";
import { WORKERA_COMPANY_ID } from "../tenant/company-scope";

/**
 * Servicio de escritura para `attendance_corrections` (MB-3).
 *
 * El esquema completo existía desde Gate D -- constraints de mismo día
 * calendario en America/Santiago, orden clock_out >= clock_in, motivo no
 * vacío, bloqueo en período cerrado, bloqueo por conflicto con una decisión de
 * horas extra activa, y un trigger que resuelve sola la bandera de marcación
 * faltante. Lo que NO existía era ninguna forma de llegar ahí desde la app:
 * `attendance_corrections` tenía CERO referencias en `src/`, y
 * `/revision-diaria` mostraba "Clock out pendiente" como texto informativo sin
 * acción posible.
 *
 * Este módulo no reimplementa ninguna de esas validaciones: las deja fallar en
 * la base y traduce el error a algo que el supervisor pueda entender. Usa
 * siempre el cliente de SESIÓN, nunca el admin: la RLS
 * `attendance_corrections_insert` exige `corrected_by = auth.uid() AND
 * can_manage_employee(employee_id)`, así que el alcance por área lo sigue
 * aplicando la base.
 *
 * El dato crudo de Workera NUNCA se toca: la corrección es una fila aparte que
 * se superpone vía `attendance_effective_punches`.
 */

export interface SubmitAttendanceCorrectionInput {
  attendanceRecordId: string;
  employeeId: string;
  workDate: string;
  /** "HH:MM" en hora de pared de Santiago, o null para dejar el valor crudo. */
  correctedClockIn: string | null;
  correctedClockOut: string | null;
  /**
   * La salida ocurrió al día calendario SIGUIENTE a `workDate` (turno que
   * cruza medianoche) -- nunca se infiere automáticamente comparando horas:
   * un supervisor debe declararlo explícitamente. La constraint de base
   * `attendance_corrections_clock_out_reasonable_day_chk` ya modela esto
   * (`work_date` o `work_date + 1`); sin esta bandera, cualquier corrección
   * de salida después de medianoche se anclaba al mismo `workDate` y quedaba
   * 24 horas antes de la hora real (bug encontrado en auditoría, nunca
   * causaba un error de la base porque la fecha resultante seguía cayendo
   * dentro del rango permitido -- solo producía el día equivocado).
   */
  correctedClockOutNextDay?: boolean;
  reason: string;
  correctedBy: string;
}

export interface SubmitAttendanceCorrectionResult {
  correctionId: string;
}

/** Traduce los errores de la base a algo accionable, sin ocultar que falló. */
function describeConstraintFailure(message: string): string {
  if (message.includes("clock_in_same_day")) {
    return "La hora de entrada debe caer en el mismo día de la marcación.";
  }
  if (message.includes("clock_out_reasonable_day")) {
    return "La hora de salida debe caer en el mismo día de la marcación o en el siguiente.";
  }
  if (message.includes("clock_order")) {
    return "La hora de salida no puede ser anterior a la de entrada.";
  }
  if (message.includes("at_least_one_field")) {
    return "Ingresa al menos una de las dos horas.";
  }
  if (message.includes("reason_not_blank")) {
    return "El motivo de la corrección no puede estar vacío.";
  }
  if (message.toLowerCase().includes("closed") || message.includes("period")) {
    return "El período de esa fecha está cerrado: ya no admite correcciones.";
  }
  if (message.toLowerCase().includes("overtime")) {
    return "Ya existe una decisión de horas extra activa para ese día. Debe revertirse antes de corregir la marcación.";
  }
  if (message.includes("row-level security") || message.includes("violates row-level")) {
    return "No tienes permiso para corregir la marcación de este trabajador.";
  }
  return message;
}

export async function submitAttendanceCorrection(
  supabase: SupabaseClient<Database>,
  input: SubmitAttendanceCorrectionInput
): Promise<SubmitAttendanceCorrectionResult> {
  if (!input.correctedClockIn && !input.correctedClockOut) {
    throw new Error("Ingresa al menos una de las dos horas.");
  }
  if (!input.reason.trim()) {
    throw new Error("El motivo de la corrección es obligatorio.");
  }

  // Versionado no destructivo, igual que el resto del esquema: la corrección
  // anterior se conserva como historial, nunca se sobrescribe.
  const { error: supersedeError } = await supabase
    .from("attendance_corrections")
    .update({ is_current: false })
    .eq("company_id", WORKERA_COMPANY_ID)
    .eq("attendance_record_id", input.attendanceRecordId)
    .eq("is_current", true);
  if (supersedeError) {
    throw new Error(`submitAttendanceCorrection: fallo versionando la corrección anterior: ${describeConstraintFailure(supersedeError.message)}`);
  }

  const { data, error } = await supabase
    .from("attendance_corrections")
    .insert({
      company_id: WORKERA_COMPANY_ID,
      attendance_record_id: input.attendanceRecordId,
      employee_id: input.employeeId,
      work_date: input.workDate,
      corrected_clock_in: input.correctedClockIn
        ? santiagoWallClockToInstant(input.workDate, input.correctedClockIn).toISOString()
        : null,
      corrected_clock_out: input.correctedClockOut
        ? santiagoWallClockToInstant(
            input.correctedClockOutNextDay ? nextDate(input.workDate) : input.workDate,
            input.correctedClockOut
          ).toISOString()
        : null,
      reason: input.reason.trim(),
      corrected_by: input.correctedBy,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(describeConstraintFailure(error?.message ?? "no se pudo registrar la corrección."));
  }

  return { correctionId: data.id };
}
