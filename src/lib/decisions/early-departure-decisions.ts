import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { addBusinessDays } from "../business-rules/business-days";
import { loadHolidaySet, holidayWindow } from "../business-rules/holidays";

/**
 * Servicio de escritura para `early_departure_decisions` (Fase 8, PASO 6).
 * Cubre el flujo del encargo (PASO "Salida médica"): el supervisor primero
 * marca el motivo; si es médico, el caso queda `NEEDS_REVIEW` con documento
 * pendiente (plazo de 3 días hábiles vía `addBusinessDays`, ya existente en
 * Fase 7 -- no reimplementado) hasta que se adjunte el comprobante, momento
 * en que una SEGUNDA decisión (nunca un UPDATE -- estas tablas son
 * append-only con `is_current`) cierra el caso como `DO_NOT_DEDUCT`. El
 * trigger `validate_early_departure_decision` (Fase 7) rechaza ese cierre si
 * no existe ya un `supporting_documents` adjunto -- este servicio no
 * duplica esa validación, solo dispara el intento y deja que la base la
 * rechace si corresponde.
 *
 * `BIRTHDAY_AUTHORIZED` NUNCA se crea desde aquí: el motor
 * (`generateEarlyDepartureCandidate`, Fase 7) ni siquiera genera un
 * `early_departure_record` cuando la salida está autorizada por cumpleaños
 * -- no hay nada que decidir manualmente en ese caso.
 */

const MEDICAL_DOCUMENT_DEADLINE_BUSINESS_DAYS = 3;

export interface MarkEarlyDepartureMedicalInput {
  earlyDepartureRecordId: string;
  workDate: string;
  reason: string | null;
}

export async function markEarlyDepartureMedical(
  supabase: SupabaseClient<Database>,
  input: MarkEarlyDepartureMedicalInput
): Promise<{ decisionId: string }> {
  const { from, to } = holidayWindow(input.workDate);
  const holidays = await loadHolidaySet(supabase, from, to);
  const deadline = addBusinessDays(input.workDate, MEDICAL_DOCUMENT_DEADLINE_BUSINESS_DAYS, holidays);
  const { data, error } = await supabase
    .from("early_departure_decisions")
    .insert({
      early_departure_record_id: input.earlyDepartureRecordId,
      reason_category: "MEDICAL",
      document_required: true,
      document_deadline: deadline,
      payroll_minutes: 0,
      payroll_effect: "NEEDS_REVIEW",
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`markEarlyDepartureMedical: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}

export interface ConfirmEarlyDepartureMedicalDocumentInput {
  earlyDepartureRecordId: string;
  workDate: string;
  reason: string | null;
}

/** Requiere que ya exista un `supporting_documents` adjunto -- si no, el trigger rechaza el insert con un error claro. */
export async function confirmEarlyDepartureMedicalDocument(
  supabase: SupabaseClient<Database>,
  input: ConfirmEarlyDepartureMedicalDocumentInput
): Promise<{ decisionId: string }> {
  const { from, to } = holidayWindow(input.workDate);
  const holidays = await loadHolidaySet(supabase, from, to);
  const deadline = addBusinessDays(input.workDate, MEDICAL_DOCUMENT_DEADLINE_BUSINESS_DAYS, holidays);
  const { data, error } = await supabase
    .from("early_departure_decisions")
    .insert({
      early_departure_record_id: input.earlyDepartureRecordId,
      reason_category: "MEDICAL",
      document_required: true,
      document_deadline: deadline,
      payroll_minutes: 0,
      payroll_effect: "DO_NOT_DEDUCT",
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`confirmEarlyDepartureMedicalDocument: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}

export type NonMedicalEarlyDepartureReason = "OTHER_JUSTIFIED" | "UNJUSTIFIED";

export interface DecideEarlyDepartureOtherInput {
  earlyDepartureRecordId: string;
  reasonCategory: NonMedicalEarlyDepartureReason;
  reason: string | null;
}

export async function decideEarlyDepartureOther(
  supabase: SupabaseClient<Database>,
  input: DecideEarlyDepartureOtherInput
): Promise<{ decisionId: string }> {
  const { data: record, error: recordError } = await supabase
    .from("early_departure_records")
    .select("detected_minutes")
    .eq("id", input.earlyDepartureRecordId)
    .single();
  if (recordError || !record) {
    throw new Error(`decideEarlyDepartureOther: registro no encontrado (${input.earlyDepartureRecordId}).`);
  }

  const justified = input.reasonCategory === "OTHER_JUSTIFIED";
  const payrollMinutes = justified ? 0 : record.detected_minutes;
  const payrollEffect = justified ? "DO_NOT_DEDUCT" : "DEDUCT";

  const { data, error } = await supabase
    .from("early_departure_decisions")
    .insert({
      early_departure_record_id: input.earlyDepartureRecordId,
      reason_category: input.reasonCategory,
      document_required: false,
      document_deadline: null,
      payroll_minutes: payrollMinutes,
      payroll_effect: payrollEffect,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`decideEarlyDepartureOther: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}
