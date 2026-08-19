import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Resolución centralizada de horario efectivo y exención de control horario
 * (Fase 7, PASO 3/33). Un ÚNICO punto de verdad reutilizado por atrasos,
 * salidas anticipadas y confirmación de overtime -- ninguno de esos motores
 * debe volver a consultar `schedule_assignments`/`employee_time_control_policies`
 * por su cuenta.
 *
 * Orden de precedencia (PASO 33), tal como lo permite el esquema REAL (no
 * existe una tabla de "horario de grupo" separada -- `schedule_assignments`
 * es siempre por-empleado; el "horario general" es simplemente el mismo
 * `work_schedule_id` asignado a muchos trabajadores vía esa misma tabla):
 *
 *   A. EXEMPT_FROM_TIME_CONTROL (employee_time_control_policies vigente)
 *   B. el schedule_assignment vigente del trabajador para esa fecha
 *      (cubre tanto "horario individual" como "horario de grupo" -- ambos
 *      son la misma mecánica, solo cambia qué work_schedule_id apunta)
 *   C. excepción diaria puntual: no existe una tabla separada para esto hoy
 *      -- un cambio de un solo día ya es modelable como un
 *      schedule_assignment de 1 día (effective_from=effective_to=esa
 *      fecha), sin necesitar una tabla nueva.
 *
 * Nunca hardcodea nombres de trabajadores -- toda decisión sale de las
 * tablas, nunca de un `if (employee.name === ...)`.
 */

export type TimeControlPolicyResult =
  | { code: "NORMAL" }
  | { code: "EXEMPT_FROM_TIME_CONTROL"; legalBasis: "NO_MARKING_REQUIRED" | "ARTICLE_22" | "OTHER" };

export async function resolveTimeControlPolicy(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  date: string
): Promise<TimeControlPolicyResult> {
  const { data, error } = await supabase
    .from("employee_time_control_policies")
    .select("policy_code, legal_basis")
    .eq("employee_id", employeeId)
    .lte("effective_from", date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .maybeSingle();

  if (error) {
    throw new Error(`resolveTimeControlPolicy: fallo consultando employee_time_control_policies: ${error.message}`);
  }

  if (!data || data.policy_code === "NORMAL") {
    return { code: "NORMAL" };
  }

  return {
    code: "EXEMPT_FROM_TIME_CONTROL",
    legalBasis: data.legal_basis as "NO_MARKING_REQUIRED" | "ARTICLE_22" | "OTHER",
  };
}

export type EffectiveScheduleResult =
  | { kind: "EXEMPT"; legalBasis: "NO_MARKING_REQUIRED" | "ARTICLE_22" | "OTHER" }
  /** El schedule_assignment vigente existe, pero ese día de la semana no tiene turno (fin de semana habitual). */
  | { kind: "DAY_OFF"; workScheduleId: string }
  | { kind: "SCHEDULED"; workScheduleId: string; scheduledStart: string; scheduledEnd: string }
  /** No hay ningún schedule_assignment vigente para este trabajador/fecha -- gap real, nunca se asume el horario general. */
  | { kind: "NO_SCHEDULE_ASSIGNED" };

function isoWeekdayToPostgresDow(date: string): number {
  // work_schedule_rules.day_of_week: 0=domingo..6=sábado (confirmado en migración 02).
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export async function resolveEffectiveSchedule(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  date: string
): Promise<EffectiveScheduleResult> {
  const timeControl = await resolveTimeControlPolicy(supabase, employeeId, date);
  if (timeControl.code === "EXEMPT_FROM_TIME_CONTROL") {
    return { kind: "EXEMPT", legalBasis: timeControl.legalBasis };
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("schedule_assignments")
    .select("work_schedule_id")
    .eq("employee_id", employeeId)
    .lte("effective_from", date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .maybeSingle();

  if (assignmentError) {
    throw new Error(`resolveEffectiveSchedule: fallo consultando schedule_assignments: ${assignmentError.message}`);
  }
  if (!assignment) {
    return { kind: "NO_SCHEDULE_ASSIGNED" };
  }

  const dow = isoWeekdayToPostgresDow(date);
  const { data: rule, error: ruleError } = await supabase
    .from("work_schedule_rules")
    .select("scheduled_start, scheduled_end")
    .eq("work_schedule_id", assignment.work_schedule_id)
    .eq("day_of_week", dow)
    .maybeSingle();

  if (ruleError) {
    throw new Error(`resolveEffectiveSchedule: fallo consultando work_schedule_rules: ${ruleError.message}`);
  }
  if (!rule || rule.scheduled_start === null || rule.scheduled_end === null) {
    return { kind: "DAY_OFF", workScheduleId: assignment.work_schedule_id };
  }

  return {
    kind: "SCHEDULED",
    workScheduleId: assignment.work_schedule_id,
    scheduledStart: rule.scheduled_start,
    scheduledEnd: rule.scheduled_end,
  };
}
