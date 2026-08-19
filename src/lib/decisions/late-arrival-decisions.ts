import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Servicio de escritura para `late_arrival_decisions` (Fase 8, PASO 6). Fase
 * 7 construyó el esquema y el motor de generación de candidatos
 * (`late-arrival.ts`), pero ningún servicio insertaba decisiones todavía --
 * necesario para que la UI pueda "capturar decisiones" en vez de escribir
 * directo a la tabla desde un componente (principio arquitectónico del
 * encargo de Fase 8).
 *
 * Traducción "Justificar / No justificar" -> columnas reales: un atraso
 * justificado no descuenta nada de la liquidación (`payroll_minutes=0`,
 * `payroll_effect='DO_NOT_DEDUCT'`); no justificado descuenta exactamente
 * los minutos detectados (`payroll_effect='DEDUCT'`) -- es el único mapeo
 * consistente con el propio significado de las columnas, no una regla nueva.
 * RLS (`can_manage_employee`) sigue siendo el enforcement real de área; este
 * servicio usa el cliente de SESIÓN (nunca el admin), así que un supervisor
 * de Instalación que intente decidir sobre un trabajador de Producción
 * recibe el mismo rechazo que si escribiera la fila a mano.
 */

export interface DecideLateArrivalInput {
  lateArrivalRecordId: string;
  justified: boolean;
  reason: string | null;
}

export interface DecideLateArrivalResult {
  decisionId: string;
}

export async function decideLateArrival(
  supabase: SupabaseClient<Database>,
  input: DecideLateArrivalInput
): Promise<DecideLateArrivalResult> {
  const { data: record, error: recordError } = await supabase
    .from("late_arrival_records")
    .select("detected_minutes")
    .eq("id", input.lateArrivalRecordId)
    .single();
  if (recordError || !record) {
    throw new Error(`decideLateArrival: registro de atraso no encontrado (${input.lateArrivalRecordId}).`);
  }

  const payrollMinutes = input.justified ? 0 : record.detected_minutes;
  const payrollEffect = input.justified ? "DO_NOT_DEDUCT" : "DEDUCT";

  const { data, error } = await supabase
    .from("late_arrival_decisions")
    .insert({
      late_arrival_record_id: input.lateArrivalRecordId,
      justified: input.justified,
      payroll_minutes: payrollMinutes,
      payroll_effect: payrollEffect,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`decideLateArrival: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}
