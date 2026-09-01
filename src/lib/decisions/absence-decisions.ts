import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { addBusinessDays } from "../business-rules/business-days";
import { loadHolidaySet, holidayWindow } from "../business-rules/holidays";

/**
 * Servicio de escritura para `absence_decisions` (Fase 8, PASO 6). Cubre el
 * flujo "¿Trabajador con licencia? Sí/No" del encargo: "Sí" exige documento
 * de respaldo obligatorio antes de poder confirmar (`PENDING_DOCUMENT` ->
 * `CONFIRMED`, el trigger `validate_absence_decision_document` de Fase 7
 * bloquea el cierre sin documento adjunto); "No" queda `DISPUTED` para que
 * RRHH revise manualmente.
 *
 * Plazo de 3 días hábiles: el encargo solo especifica ese número
 * explícitamente para la salida médica (PASO 19); se reutiliza aquí como
 * supuesto documentado por consistencia, no como una cifra distinta
 * inventada -- si RRHH define un plazo distinto para licencias, es un
 * ajuste de UN número en este archivo, no una reescritura de reglas.
 */

const ABSENCE_DOCUMENT_DEADLINE_BUSINESS_DAYS = 3;

export interface MarkAbsencePendingDocumentInput {
  absenceRecordId: string;
  startDate: string;
  reason: string | null;
}

export async function markAbsencePendingDocument(
  supabase: SupabaseClient<Database>,
  input: MarkAbsencePendingDocumentInput
): Promise<{ decisionId: string }> {
  const { from, to } = holidayWindow(input.startDate);
  const holidays = await loadHolidaySet(supabase, from, to);
  const deadline = addBusinessDays(input.startDate, ABSENCE_DOCUMENT_DEADLINE_BUSINESS_DAYS, holidays);
  const { data, error } = await supabase
    .from("absence_decisions")
    .insert({
      absence_record_id: input.absenceRecordId,
      decision_status: "PENDING_DOCUMENT",
      document_required: true,
      document_deadline: deadline,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`markAbsencePendingDocument: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}

export interface ConfirmAbsenceDocumentInput {
  absenceRecordId: string;
  startDate: string;
  reason: string | null;
}

/** Requiere que ya exista un `supporting_documents` adjunto al `absence_record` -- si no, el trigger rechaza el insert. */
export async function confirmAbsenceDocument(
  supabase: SupabaseClient<Database>,
  input: ConfirmAbsenceDocumentInput
): Promise<{ decisionId: string }> {
  const { from, to } = holidayWindow(input.startDate);
  const holidays = await loadHolidaySet(supabase, from, to);
  const deadline = addBusinessDays(input.startDate, ABSENCE_DOCUMENT_DEADLINE_BUSINESS_DAYS, holidays);
  const { data, error } = await supabase
    .from("absence_decisions")
    .insert({
      absence_record_id: input.absenceRecordId,
      decision_status: "CONFIRMED",
      document_required: true,
      document_deadline: deadline,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`confirmAbsenceDocument: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}

export interface DisputeAbsenceInput {
  absenceRecordId: string;
  reason: string | null;
}

/** "No está con licencia" -- queda para revisión manual de RRHH, nunca se confirma automáticamente. */
export async function disputeAbsence(
  supabase: SupabaseClient<Database>,
  input: DisputeAbsenceInput
): Promise<{ decisionId: string }> {
  const { data, error } = await supabase
    .from("absence_decisions")
    .insert({
      absence_record_id: input.absenceRecordId,
      decision_status: "DISPUTED",
      document_required: false,
      document_deadline: null,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`disputeAbsence: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}
