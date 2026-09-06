import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  evaluatePayrollOvertime,
  type PayrollArea,
} from "../business-rules/payroll-overtime-rules";

/**
 * Servicio de escritura para `overtime_decisions` (Fase 8, PASO 6). Solo
 * La acción de aprobar puede reconocer todos o una parte de los minutos
 * reales; la regla canónica determina cuántos son pagables. Si existe un tope, se conserva el
 * candidato real y se inserta una decisión PARTIALLY_APPROVED por la
 * diferencia. `employee_daily_bonuses` se recalcula vía el trigger
 * `overtime_decisions_recompute_bonus`; este servicio nunca persiste el bono.
 */

export type OvertimeDecisionAction = "APPROVE" | "REJECT";

export interface DecideOvertimeInput {
  overtimeRecordId: string;
  action: OvertimeDecisionAction;
  /** Minutos reconocidos por la persona competente antes de aplicar el tope. */
  approvedMinutes?: number | null;
  reason: string | null;
}

export interface DecideOvertimeResult {
  decisionId: string;
}

interface OvertimeRecordForDecision {
  candidate_minutes: number;
  work_date: string;
  overtime_policy:
    | { employee_groups: { code: string } | { code: string }[] | null }
    | { employee_groups: { code: string } | { code: string }[] | null }[]
    | null;
  overtime_type: { code: string } | { code: string }[] | null;
}

function one<T>(relation: T | T[] | null): T | null {
  return Array.isArray(relation) ? relation[0] ?? null : relation;
}

function payrollAreaFromGroupCode(code: string | null): PayrollArea {
  if (code === "PRODUCTION" || code === "INSTALLATION" || code === "ADMINISTRATION") return code;
  throw new Error(`decideOvertime: grupo laboral no soportado (${code ?? "sin grupo"}).`);
}

function dayOfWeek(workDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);
  if (!match) throw new Error(`decideOvertime: fecha de trabajo inválida (${workDate}).`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`decideOvertime: fecha de trabajo inválida (${workDate}).`);
  }
  return parsed.getUTCDay();
}

export async function decideOvertime(
  supabase: SupabaseClient<Database>,
  input: DecideOvertimeInput
): Promise<DecideOvertimeResult> {
  const { data: record, error: recordError } = await supabase
    .from("overtime_records")
    .select(
      "candidate_minutes, work_date, attendance_records!inner(is_current), "
      + "overtime_policy:overtime_policies!overtime_records_overtime_policy_id_fkey(employee_groups(code)), "
      + "overtime_type:overtime_types!overtime_records_overtime_type_id_fkey(code)"
    )
    .eq("id", input.overtimeRecordId)
    // Un id histórico sigue existiendo por auditoría, pero ya no es una
    // propuesta decidible ni puede volver a gatillar un bono.
    .eq("is_current", true)
    .eq("attendance_records.is_current", true)
    .single();
  if (recordError || !record) {
    throw new Error(`decideOvertime: registro de horas extra no encontrado (${input.overtimeRecordId}).`);
  }
  const decisionRecord = record as unknown as OvertimeRecordForDecision;
  if (decisionRecord.candidate_minutes <= 0) {
    throw new Error(`decideOvertime: el registro no tiene minutos candidatos (${input.overtimeRecordId}).`);
  }

  let approvedMinutes = 0;
  if (input.action === "APPROVE") {
    const requestedMinutes = input.approvedMinutes ?? decisionRecord.candidate_minutes;
    if (!Number.isInteger(requestedMinutes) || requestedMinutes < 0) {
      throw new Error("decideOvertime: los minutos reconocidos deben ser un entero no negativo.");
    }
    if (requestedMinutes > decisionRecord.candidate_minutes) {
      throw new Error("decideOvertime: los minutos reconocidos no pueden superar los minutos reales.");
    }
    if (requestedMinutes === 0) {
      throw new Error("decideOvertime: use Rechazar cuando no reconoce minutos.");
    }
    // El grupo queda congelado en la política vinculada al registro. Consultar
    // la ficha actual del trabajador cambiaría retroactivamente una decisión
    // histórica si la persona se mueve de área.
    const overtimePolicy = one(decisionRecord.overtime_policy);
    const group = one(overtimePolicy?.employee_groups ?? null);
    const overtimeType = one(decisionRecord.overtime_type);
    const area = payrollAreaFromGroupCode(group?.code ?? null);
    const workDateDay = dayOfWeek(decisionRecord.work_date);
    const frozenRate = overtimeType?.code === "OVERTIME_50"
      ? "HH50"
      : overtimeType?.code === "OVERTIME_100"
        ? "HH100"
        : null;
    if (!frozenRate) {
      throw new Error(`decideOvertime: clasificación de horas extra inválida (${overtimeType?.code ?? "sin tipo"}).`);
    }

    // Un HH100 congelado en un día que no es domingo representa un feriado.
    // Domingo ya es HH100 por calendario, sin depender del catálogo vigente.
    const evaluation = evaluatePayrollOvertime({
      area,
      realMinutes: decisionRecord.candidate_minutes,
      dayOfWeek: workDateDay,
      isHoliday: frozenRate === "HH100" && workDateDay !== 0,
      approvedMinutes: requestedMinutes,
    });
    if (evaluation.blocked) {
      throw new Error(`decideOvertime: horas extra no aprobables. ${evaluation.warnings.join(" ")}`);
    }
    if (evaluation.rate !== frozenRate) {
      throw new Error(
        `decideOvertime: la clasificación congelada ${frozenRate} contradice la fecha ${decisionRecord.work_date}.`
      );
    }
    approvedMinutes = evaluation.payableMinutes;
  } else if (input.action !== "REJECT") {
    throw new Error(`decideOvertime: acción inválida (${String(input.action)}).`);
  }

  const rejectedMinutes = decisionRecord.candidate_minutes - approvedMinutes;
  const decisionStatus = approvedMinutes === 0
    ? "REJECTED"
    : rejectedMinutes === 0
      ? "FULLY_APPROVED"
      : "PARTIALLY_APPROVED";
  if (decisionStatus !== "FULLY_APPROVED" && !input.reason?.trim()) {
    throw new Error("decideOvertime: el rechazo o reconocimiento parcial exige motivo.");
  }

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
