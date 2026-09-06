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
 *   - INSTALLATION: genera los minutos exactos, sin selector 1h/2h y sin
 *     tope fijo de negocio. La fila de política usa 1440 solo como límite
 *     técnico de un día, según la decisión ya cerrada en Gate D.
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

interface CurrentOvertimeRecord {
  id: string;
  attendance_record_id: string;
  candidate_minutes: number;
  overtime_policy_id: string;
  overtime_types: { code: string } | { code: string }[] | null;
  calculation_version: number;
}

async function loadCurrentOvertimeRecord(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string
): Promise<CurrentOvertimeRecord | null> {
  const { data, error } = await supabase
    .from("overtime_records")
    .select("id, attendance_record_id, candidate_minutes, overtime_policy_id, overtime_types(code), calculation_version")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (error) {
    throw new Error(`generateOvertimeCandidate: fallo consultando overtime_records vigente: ${error.message}`);
  }
  return data;
}

/**
 * Un resultado sin candidato también es un recálculo autoritativo. Mantener la
 * versión anterior como vigente haría que la cola siguiera ofreciendo horas
 * que la marcación/política actual ya no respalda.
 */
async function retireCurrentOvertimeRecord(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string
): Promise<void> {
  const current = await loadCurrentOvertimeRecord(supabase, employeeId, workDate);
  if (!current) return;

  const { error } = await supabase
    .from("overtime_records")
    .update({ is_current: false })
    .eq("id", current.id)
    .eq("is_current", true);
  if (error) {
    throw new Error(`generateOvertimeCandidate: fallo retirando overtime_records vigente: ${error.message}`);
  }
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

function relationCode(relation: CurrentOvertimeRecord["overtime_types"]): string | null {
  if (Array.isArray(relation)) return relation[0]?.code ?? null;
  return relation?.code ?? null;
}

export async function generateOvertimeCandidate(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockOut: string | null,
  clockIn: string | null = null,
  isHoliday = false
): Promise<GenerateOvertimeCandidateResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "EXEMPT", overtimeRecordId: null, candidateMinutes: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NO_SCHEDULE_ASSIGNED", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!clockOut) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NO_CLOCK_OUT", overtimeRecordId: null, candidateMinutes: null };
  }

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
      await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
      return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };
    }
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "OVERTIME_POLICY_REQUIRES_CONFIRMATION", overtimeRecordId: null, candidateMinutes: null };
  }

  const usesWorkedSpan = schedule.kind === "DAY_OFF" || isHoliday;
  if (usesWorkedSpan && !clockIn) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NO_CLOCK_IN", overtimeRecordId: null, candidateMinutes: null };
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
  if (!policy) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NO_POLICY", overtimeRecordId: null, candidateMinutes: null };
  }
  if (!policy.overtime_eligible) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NOT_ELIGIBLE", overtimeRecordId: null, candidateMinutes: null };
  }

  const rawMinutes = schedule.kind === "SCHEDULED" && !isHoliday
    ? minutesBetween(schedule.scheduledEnd, new Date(clockOut))
    : minutesBetweenInstants(clockIn!, clockOut);
  if (!Number.isFinite(rawMinutes)) {
    throw new Error("generateOvertimeCandidate: marcaciones inválidas para calcular horas extra.");
  }
  // En Producción, un feriado usa el límite HH100 confirmado (6h), aunque la
  // fila semanal normal de overtime_policies tenga 120 minutos.
  const candidateLimit = groupCode === "PRODUCTION" && isHoliday
    ? 360
    : (policy.max_overtime_minutes ?? rawMinutes);
  const candidateMinutes = Math.max(0, Math.min(rawMinutes, candidateLimit));

  if (candidateMinutes === 0) {
    await retireCurrentOvertimeRecord(supabase, employeeId, workDate);
    return { status: "NO_OVERTIME", overtimeRecordId: null, candidateMinutes: 0 };
  }

  const existing = await loadCurrentOvertimeRecord(supabase, employeeId, workDate);
  const expectedTypeCode = isHoliday || workDateDow === 0 ? "OVERTIME_100" : "OVERTIME_50";
  if (
    existing &&
    existing.attendance_record_id === attendanceRecordId &&
    existing.overtime_policy_id === policy.id &&
    relationCode(existing.overtime_types) === expectedTypeCode &&
    existing.candidate_minutes === candidateMinutes
  ) {
    return { status: "UNCHANGED", overtimeRecordId: existing.id, candidateMinutes };
  }
  if (existing) {
    const { error: updateError } = await supabase
      .from("overtime_records")
      .update({ is_current: false })
      .eq("id", existing.id)
      .eq("is_current", true);
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
