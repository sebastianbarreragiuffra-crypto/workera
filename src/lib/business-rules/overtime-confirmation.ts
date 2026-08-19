import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes } from "./wall-clock";

/**
 * Generación de candidato de horas extra (Fase 7, PASO 34-37). Reutiliza
 * `overtime_records`/`overtime_policies`/el motor de aprobación ya
 * construido en Gate D (clasificación HH50/HH100, tope diario, selector
 * binario Producción 1h/2h) SIN modificarlo -- este servicio solo produce
 * la fila candidato (`overtime_records.candidate_minutes`), que hoy no
 * generaba nada automáticamente (confirmado por auditoría: Gate D solo
 * construyó la capa de aprobación sobre un valor ya existente).
 *
 * Fórmula confirmada (docs/BUSINESS_RULES_PRE_PHASE2.md §6-7):
 *   raw_overtime_minutes = clock_out - scheduled_end (horario EFECTIVO,
 *     nunca 17:00 fijo)
 *   candidate_overtime_minutes = MAX(0, MIN(raw, max_overtime_minutes))
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
 *   - INSTALLATION: reglas EXACTAS de overtime siguen pendientes (PASO 36,
 *     explícito en el encargo) -- NUNCA genera un candidato automático,
 *     aunque `overtime_policies.overtime_eligible=true` ya exista en la
 *     tabla (ese valor placeholder no es autorización para calcular).
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
  | "NOT_ELIGIBLE"
  | "NO_POLICY"
  | "OVERTIME_POLICY_REQUIRES_CONFIRMATION";

export interface GenerateOvertimeCandidateResult {
  status: GenerateOvertimeCandidateStatus;
  overtimeRecordId: string | null;
  candidateMinutes: number | null;
}

/** Grupos con política de overtime confirmada y lista para calcular automáticamente (PASO 34-37). */
const AUTO_GENERATE_GROUP_CODES = new Set(["PRODUCTION"]);

/** Minutos entre la marcación de salida real y el horario de salida efectivo, en hora de pared de Santiago (ver wall-clock.ts). */
function minutesBetween(scheduledEnd: string, clockOut: Date): number {
  return santiagoWallClockMinutesSinceMidnight(clockOut) - scheduledTimeToMinutes(scheduledEnd);
}

export async function generateOvertimeCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockOut: string | null
): Promise<GenerateOvertimeCandidateResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") return { status: "EXEMPT", overtimeRecordId: null, candidateMinutes: null };
  if (schedule.kind === "DAY_OFF") return { status: "DAY_OFF", overtimeRecordId: null, candidateMinutes: null };
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    return { status: "NO_SCHEDULE_ASSIGNED", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!clockOut) return { status: "NO_CLOCK_OUT", overtimeRecordId: null, candidateMinutes: null };

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("employee_group_id")
    .eq("id", employeeId)
    .single();
  if (employeeError || !employee?.employee_group_id) {
    throw new Error(`generateOvertimeCandidate: fallo resolviendo grupo del empleado: ${employeeError?.message ?? "sin grupo"}`);
  }

  const { data: group, error: groupError } = await supabase
    .from("employee_groups")
    .select("code")
    .eq("id", employee.employee_group_id)
    .single();
  if (groupError || !group) {
    throw new Error(`generateOvertimeCandidate: fallo resolviendo employee_groups.code: ${groupError?.message ?? "sin fila"}`);
  }
  const groupCode = group.code;

  if (!AUTO_GENERATE_GROUP_CODES.has(groupCode)) {
    if (groupCode === "ADMINISTRATION") {
      return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };
    }
    return { status: "OVERTIME_POLICY_REQUIRES_CONFIRMATION", overtimeRecordId: null, candidateMinutes: null };
  }

  const [year, month, day] = workDate.split("-").map(Number);
  const workDateDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const { data: policy, error: policyError } = await supabase
    .from("overtime_policies")
    .select("id, overtime_eligible, max_overtime_minutes")
    .eq("employee_group_id", employee.employee_group_id)
    .eq("day_of_week", workDateDow)
    .lte("effective_from", workDate)
    .or(`effective_to.is.null,effective_to.gte.${workDate}`)
    .maybeSingle();

  if (policyError) {
    throw new Error(`generateOvertimeCandidate: fallo consultando overtime_policies: ${policyError.message}`);
  }
  if (!policy) return { status: "NO_POLICY", overtimeRecordId: null, candidateMinutes: null };
  if (!policy.overtime_eligible) return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };

  const rawMinutes = minutesBetween(schedule.scheduledEnd, new Date(clockOut));
  const candidateMinutes = Math.max(0, Math.min(rawMinutes, policy.max_overtime_minutes ?? rawMinutes));

  if (candidateMinutes === 0) {
    return { status: "NO_OVERTIME", overtimeRecordId: null, candidateMinutes: 0 };
  }

  const { data: existing, error: existingError } = await supabase
    .from("overtime_records")
    .select("id, candidate_minutes, calculation_version")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (existingError) {
    throw new Error(`generateOvertimeCandidate: fallo consultando overtime_records vigente: ${existingError.message}`);
  }
  if (existing && existing.candidate_minutes === candidateMinutes) {
    return { status: "UNCHANGED", overtimeRecordId: existing.id, candidateMinutes };
  }
  if (existing) {
    const { error: updateError } = await supabase.from("overtime_records").update({ is_current: false }).eq("id", existing.id);
    if (updateError) throw new Error(`generateOvertimeCandidate: fallo versionando overtime_records: ${updateError.message}`);
  }

  // overtime_type_id lo asigna el trigger overtime_records_classify_rate
  // (Gate D, HH50/HH100) -- se pasa un placeholder que el trigger
  // sobrescribe siempre, nunca se confía en un valor calculado aquí.
  const { data: placeholderType, error: typeError } = await supabase
    .from("overtime_types")
    .select("id")
    .limit(1)
    .single();
  if (typeError || !placeholderType) {
    throw new Error(`generateOvertimeCandidate: fallo obteniendo un overtime_types placeholder: ${typeError?.message ?? "sin fila"}`);
  }

  const { data: inserted, error: insertError } = await supabase
    .from("overtime_records")
    .insert({
      employee_id: employeeId,
      work_date: workDate,
      attendance_record_id: attendanceRecordId,
      overtime_type_id: placeholderType.id,
      candidate_minutes: candidateMinutes,
      overtime_policy_id: policy.id,
      calculation_version: (existing?.calculation_version ?? 0) + 1,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`generateOvertimeCandidate: fallo insertando overtime_records: ${insertError?.message ?? "sin fila devuelta"}`);
  }

  return { status: "GENERATED", overtimeRecordId: inserted.id, candidateMinutes };
}
