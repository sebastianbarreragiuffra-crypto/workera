import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Servicio de escritura para `overtime_decisions` (Fase 8, PASO 6). Solo
 * cubre "Aprobar / Rechazar" completo (lo único que pide el encargo de
 * Fase 8 -- "Permitir: APROBAR / RECHAZAR"), nunca aprobación parcial:
 * eso queda fuera de alcance hasta que exista un requisito explícito de UI
 * para editar minutos. `employee_daily_bonuses` se recalcula solo, vía el
 * trigger `overtime_decisions_recompute_bonus` ya existente (Fase 7/anterior)
 * -- este servicio nunca calcula el bono.
 */

export type OvertimeDecisionAction = "APPROVE" | "REJECT";

export interface DecideOvertimeInput {
  overtimeRecordId: string;
  action: OvertimeDecisionAction;
  reason: string | null;
}

export interface DecideOvertimeResult {
  decisionId: string;
}

export async function decideOvertime(
  supabase: SupabaseClient<Database>,
  input: DecideOvertimeInput
): Promise<DecideOvertimeResult> {
  const { data: record, error: recordError } = await supabase
    .from("overtime_records")
    .select("candidate_minutes")
    .eq("id", input.overtimeRecordId)
    .single();
  if (recordError || !record) {
    throw new Error(`decideOvertime: registro de horas extra no encontrado (${input.overtimeRecordId}).`);
  }
  if (record.candidate_minutes <= 0) {
    throw new Error(`decideOvertime: el registro no tiene minutos candidatos (${input.overtimeRecordId}).`);
  }

  const approvedMinutes = input.action === "APPROVE" ? record.candidate_minutes : 0;
  const rejectedMinutes = input.action === "APPROVE" ? 0 : record.candidate_minutes;
  const decisionStatus = input.action === "APPROVE" ? "FULLY_APPROVED" : "REJECTED";

  const { data, error } = await supabase
    .from("overtime_decisions")
    .insert({
      overtime_record_id: input.overtimeRecordId,
      approved_minutes: approvedMinutes,
      rejected_minutes: rejectedMinutes,
      decision_status: decisionStatus,
      reason: input.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`decideOvertime: fallo insertando decisión: ${error?.message ?? "sin fila devuelta"}`);
  }
  return { decisionId: data.id };
}
