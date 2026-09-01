import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { AreaCode } from "../access/scope";

/**
 * Administración de horarios y exención de control horario (MB-1).
 *
 * Por qué existe: hasta esta fase `schedule_assignments` no tenía ninguna vía
 * de escritura desde la app, y con 0 filas `resolveEffectiveSchedule` devuelve
 * `NO_SCHEDULE_ASSIGNED` para todos -- el motor de reglas de Fase 7 no produce
 * un solo candidato de atraso/salida anticipada/horas extra. Este módulo es el
 * llamador real que faltaba.
 *
 * Toda escritura pasa por las RPC de `20260901140000_schedule_administration.sql`,
 * que aportan atomicidad (cerrar la vigente + insertar la nueva). La
 * autorización sigue siendo la RLS `is_privileged_admin()` de cada tabla, no
 * un chequeo de esta capa -- por eso las escrituras usan el cliente de sesión,
 * nunca el admin client.
 *
 * La lectura del tablero es deliberadamente BULK (3 consultas fijas) en vez de
 * llamar `resolveEffectiveSchedule` por empleado (3 consultas × 44 = 132). El
 * resultado es el mismo porque replica su misma precedencia: exención primero,
 * luego la asignación vigente.
 */

export type LegalBasis = "NO_MARKING_REQUIRED" | "ARTICLE_22" | "OTHER";

export interface WorkScheduleRule {
  dayOfWeek: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

export interface WorkScheduleSummary {
  id: string;
  name: string;
  rules: WorkScheduleRule[];
  /** Resumen legible tipo "L-J 07:30-17:00 · V 07:30-14:50". */
  label: string;
  assignedCount: number;
}

export interface ScheduleAdminRow {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode | null;
  timeControl: "NORMAL" | "EXEMPT";
  legalBasis: LegalBasis | null;
  workScheduleId: string | null;
  workScheduleName: string | null;
  effectiveFrom: string | null;
}

export interface ScheduleAdminBoard {
  date: string;
  rows: ScheduleAdminRow[];
  schedules: WorkScheduleSummary[];
  totalActive: number;
  unassignedCount: number;
  exemptCount: number;
}

// ---------------------------------------------------------------------------
// Resumen legible de un horario (puro)

/** Orden chileno de lectura: lunes primero, domingo último. `work_schedule_rules.day_of_week` es 0=domingo..6=sábado. */
const DISPLAY_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_INITIALS: Record<number, string> = { 1: "L", 2: "M", 3: "X", 4: "J", 5: "V", 6: "S", 0: "D" };

/** "07:30:00" -> "07:30". Postgres `time` llega con segundos que nunca aportan nada acá. */
function trimSeconds(value: string): string {
  return value.slice(0, 5);
}

/**
 * Agrupa días CONSECUTIVOS (en orden de lectura) que comparten el mismo tramo,
 * para que "Horario estándar planta" se lea "L-J 07:30-17:00 · V 07:30-14:50"
 * y no como cinco tramos sueltos.
 */
export function summarizeScheduleRules(rules: WorkScheduleRule[]): string {
  const byDay = new Map(rules.map((r) => [r.dayOfWeek, r]));
  const segments: string[] = [];

  let runStart: number | null = null;
  let runEnd: number | null = null;
  let runLabel: string | null = null;

  const flush = () => {
    if (runStart === null || runEnd === null || runLabel === null) return;
    const days = runStart === runEnd ? DAY_INITIALS[runStart] : `${DAY_INITIALS[runStart]}-${DAY_INITIALS[runEnd]}`;
    segments.push(`${days} ${runLabel}`);
    runStart = null;
    runEnd = null;
    runLabel = null;
  };

  for (const day of DISPLAY_DAY_ORDER) {
    const rule = byDay.get(day);
    const label =
      rule && rule.scheduledStart && rule.scheduledEnd
        ? `${trimSeconds(rule.scheduledStart)}-${trimSeconds(rule.scheduledEnd)}`
        : null;

    // Un día libre corta la racha sin generar segmento propio: enumerar
    // "S-D libre" no aporta, la ausencia ya lo dice.
    if (label === null) {
      flush();
      continue;
    }

    if (runLabel === label) {
      runEnd = day;
      continue;
    }

    flush();
    runStart = day;
    runEnd = day;
    runLabel = label;
  }
  flush();

  return segments.length > 0 ? segments.join(" · ") : "Sin días laborales definidos";
}

// ---------------------------------------------------------------------------
// Ensamblado del tablero (puro, para poder probarlo sin base de datos)

export interface RawEmployeeRow {
  id: string;
  display_name: string;
  employee_groups: { code: string } | { code: string }[] | null;
}

export interface RawAssignmentRow {
  employee_id: string;
  work_schedule_id: string;
  effective_from: string;
  work_schedules: { name: string } | { name: string }[] | null;
}

export interface RawPolicyRow {
  employee_id: string;
  policy_code: string;
  legal_basis: string | null;
}

/** PostgREST devuelve un embed to-one como objeto o como array de 1 según el plan de consulta; ambos casos son el mismo dato. */
function unwrapEmbed<T>(value: T | T[] | null): T | null {
  if (value === null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function buildScheduleAdminRows(
  employees: RawEmployeeRow[],
  assignments: RawAssignmentRow[],
  policies: RawPolicyRow[]
): ScheduleAdminRow[] {
  const assignmentByEmployee = new Map(assignments.map((a) => [a.employee_id, a]));
  const exemptionByEmployee = new Map(
    policies.filter((p) => p.policy_code === "EXEMPT_FROM_TIME_CONTROL").map((p) => [p.employee_id, p])
  );

  return employees.map((employee) => {
    const exemption = exemptionByEmployee.get(employee.id) ?? null;
    const assignment = assignmentByEmployee.get(employee.id) ?? null;
    const group = unwrapEmbed(employee.employee_groups);

    return {
      employeeId: employee.id,
      displayName: employee.display_name,
      areaCode: (group?.code as AreaCode | undefined) ?? null,
      timeControl: exemption ? "EXEMPT" : "NORMAL",
      legalBasis: (exemption?.legal_basis as LegalBasis | null) ?? null,
      workScheduleId: assignment?.work_schedule_id ?? null,
      workScheduleName: unwrapEmbed(assignment?.work_schedules ?? null)?.name ?? null,
      effectiveFrom: assignment?.effective_from ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Lectura

export async function getScheduleAdminBoard(
  supabase: SupabaseClient<Database>,
  date: string
): Promise<ScheduleAdminBoard> {
  const vigentFilter = `effective_to.is.null,effective_to.gte.${date}`;

  const [employeesRes, assignmentsRes, policiesRes, schedulesRes] = await Promise.all([
    supabase
      .from("employees")
      .select("id, display_name, employee_groups!employees_company_group_fkey(code)")
      .eq("active", true)
      .order("display_name"),
    supabase
      .from("schedule_assignments")
      .select("employee_id, work_schedule_id, effective_from, work_schedules(name)")
      .lte("effective_from", date)
      .or(vigentFilter),
    supabase
      .from("employee_time_control_policies")
      .select("employee_id, policy_code, legal_basis")
      .lte("effective_from", date)
      .or(vigentFilter),
    supabase.from("work_schedules").select("id, name, work_schedule_rules(day_of_week, scheduled_start, scheduled_end)").order("name"),
  ]);

  if (employeesRes.error) throw new Error(`getScheduleAdminBoard: fallo leyendo employees: ${employeesRes.error.message}`);
  if (assignmentsRes.error) throw new Error(`getScheduleAdminBoard: fallo leyendo schedule_assignments: ${assignmentsRes.error.message}`);
  if (policiesRes.error) throw new Error(`getScheduleAdminBoard: fallo leyendo employee_time_control_policies: ${policiesRes.error.message}`);
  if (schedulesRes.error) throw new Error(`getScheduleAdminBoard: fallo leyendo work_schedules: ${schedulesRes.error.message}`);

  const assignments = (assignmentsRes.data ?? []) as RawAssignmentRow[];
  const rows = buildScheduleAdminRows(
    (employeesRes.data ?? []) as RawEmployeeRow[],
    assignments,
    (policiesRes.data ?? []) as RawPolicyRow[]
  );

  const assignedCountBySchedule = new Map<string, number>();
  for (const a of assignments) {
    assignedCountBySchedule.set(a.work_schedule_id, (assignedCountBySchedule.get(a.work_schedule_id) ?? 0) + 1);
  }

  const schedules: WorkScheduleSummary[] = (schedulesRes.data ?? []).map((s) => {
    const rules: WorkScheduleRule[] = (s.work_schedule_rules ?? []).map((r) => ({
      dayOfWeek: r.day_of_week,
      scheduledStart: r.scheduled_start,
      scheduledEnd: r.scheduled_end,
    }));
    return {
      id: s.id,
      name: s.name,
      rules,
      label: summarizeScheduleRules(rules),
      assignedCount: assignedCountBySchedule.get(s.id) ?? 0,
    };
  });

  return {
    date,
    rows,
    schedules,
    totalActive: rows.length,
    // Un exento no cuenta como "sin horario": no necesita uno, y la acción
    // masiva tampoco se lo asigna (ver `assign_schedule_to_unassigned`).
    unassignedCount: rows.filter((r) => r.timeControl === "NORMAL" && r.workScheduleId === null).length,
    exemptCount: rows.filter((r) => r.timeControl === "EXEMPT").length,
  };
}

// ---------------------------------------------------------------------------
// Escritura (siempre vía RPC, siempre con el cliente de sesión)

export async function assignScheduleToEmployee(
  supabase: SupabaseClient<Database>,
  params: { employeeId: string; workScheduleId: string; effectiveFrom: string }
): Promise<void> {
  const { error } = await supabase.rpc("apply_schedule_assignment", {
    p_employee_id: params.employeeId,
    p_work_schedule_id: params.workScheduleId,
    p_effective_from: params.effectiveFrom,
  });
  if (error) throw new Error(`assignScheduleToEmployee: ${error.message}`);
}

export async function assignScheduleToUnassigned(
  supabase: SupabaseClient<Database>,
  params: { workScheduleId: string; effectiveFrom: string }
): Promise<number> {
  const { data, error } = await supabase.rpc("assign_schedule_to_unassigned", {
    p_work_schedule_id: params.workScheduleId,
    p_effective_from: params.effectiveFrom,
  });
  if (error) throw new Error(`assignScheduleToUnassigned: ${error.message}`);
  return data ?? 0;
}

export async function setTimeControlExemption(
  supabase: SupabaseClient<Database>,
  params: { employeeId: string; legalBasis: LegalBasis; effectiveFrom: string; reason: string; actorId: string }
): Promise<void> {
  const { error } = await supabase.rpc("set_time_control_exemption", {
    p_employee_id: params.employeeId,
    p_legal_basis: params.legalBasis,
    p_effective_from: params.effectiveFrom,
    p_reason: params.reason,
    p_actor_id: params.actorId,
  });
  if (error) throw new Error(`setTimeControlExemption: ${error.message}`);
}

export async function clearTimeControlExemption(
  supabase: SupabaseClient<Database>,
  params: { employeeId: string; effectiveFrom: string }
): Promise<void> {
  const { error } = await supabase.rpc("clear_time_control_exemption", {
    p_employee_id: params.employeeId,
    p_effective_from: params.effectiveFrom,
  });
  if (error) throw new Error(`clearTimeControlExemption: ${error.message}`);
}

export async function upsertWorkSchedule(
  supabase: SupabaseClient<Database>,
  params: { scheduleId: string | null; name: string; rules: WorkScheduleRule[] }
): Promise<string> {
  const { data, error } = await supabase.rpc("upsert_work_schedule", {
    p_schedule_id: params.scheduleId,
    p_name: params.name,
    p_rules: params.rules.map((r) => ({
      day_of_week: r.dayOfWeek,
      scheduled_start: r.scheduledStart ?? "",
      scheduled_end: r.scheduledEnd ?? "",
    })),
  });
  if (error) throw new Error(`upsertWorkSchedule: ${error.message}`);
  if (!data) throw new Error("upsertWorkSchedule: la función no devolvió el id del horario.");
  return data;
}
