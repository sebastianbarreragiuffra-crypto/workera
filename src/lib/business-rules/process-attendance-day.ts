import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { AreaCode } from "../access/scope";
import { deriveDailyAttendanceRecord, type DeriveDailyAttendanceStatus } from "./daily-attendance";
import { generateLateArrivalCandidate, type GenerateLateArrivalStatus } from "./late-arrival";
import { generateEarlyDepartureCandidate, type GenerateEarlyDepartureStatus } from "./early-departure";
import { generateOvertimeCandidate, type GenerateOvertimeCandidateStatus } from "./overtime-confirmation";
import type { BirthdayContext } from "./birthday";
import { loadHolidaySet } from "./holidays";

/**
 * Orquestador del motor de reglas (MB-2) -- la pieza que faltaba entre la
 * ingesta y la cola de revisión.
 *
 * Auditoría previa a esta fase: `deriveDailyAttendanceRecord` y los tres
 * generadores de candidatos existían, estaban probados, y NO tenían un solo
 * llamador en producción (solo sus propios `*.test.ts`). El cron de Workera
 * ingesta `workera_attendance_events` y se detiene ahí. Resultado: con
 * marcaciones reales sincronizadas, `attendance_records` seguía vacía, las
 * tablas de candidatos también, y `/revision-diaria` mostraba a todos los
 * trabajadores como "Sin novedades". Este módulo conecta ambos extremos.
 *
 * No reimplementa NINGUNA regla: solo decide a quién y en qué orden invocar.
 * Toda la lógica de atraso/salida anticipada/horas extra/bono sigue viviendo
 * donde ya estaba y no se modificó.
 *
 * Idempotente por construcción: `deriveDailyAttendanceRecord` compara
 * `source_hash` y devuelve `UNCHANGED` sin escribir, y los tres generadores
 * versionan con `is_current`. Reprocesar la misma fecha no duplica nada, que
 * es justo lo que necesita el flujo de corrección de marcación (MB-3).
 *
 * Secuencial a propósito: son ~6 consultas por trabajador y el paralelismo
 * sobre PostgREST solo agregaría contención sobre las mismas filas sin un
 * beneficio real a esta escala (44 trabajadores). Si el volumen creciera,
 * el siguiente paso es lotear por trabajador, no disparar todo en paralelo.
 */

export interface ProcessAttendanceDayOptions {
  /** Acota a un área. Sin esto, procesa a todos los trabajadores activos. */
  areaCode?: AreaCode;
  /** Acota a trabajadores puntuales -- lo usa la re-derivación tras corregir una marcación. */
  employeeIds?: string[];
}

/**
 * Motores inyectables -- mismo patrón que `SyncWorkeraAttendanceDeps` (Fase
 * 6A). Existe para poder probar la ORQUESTACIÓN (agregación de conteos,
 * aislamiento de errores, cuándo se saltan los generadores) sin tener que
 * simular seis cadenas de consultas PostgREST por trabajador. En producción
 * nunca se pasa: los defaults son los motores reales de Fase 7.
 */
export interface ProcessAttendanceDayDeps {
  deriveDailyAttendanceRecord: typeof deriveDailyAttendanceRecord;
  generateLateArrivalCandidate: typeof generateLateArrivalCandidate;
  generateEarlyDepartureCandidate: typeof generateEarlyDepartureCandidate;
  generateOvertimeCandidate: typeof generateOvertimeCandidate;
}

const DEFAULT_DEPS: ProcessAttendanceDayDeps = {
  deriveDailyAttendanceRecord,
  generateLateArrivalCandidate,
  generateEarlyDepartureCandidate,
  generateOvertimeCandidate,
};

export interface EmployeeProcessOutcome {
  employeeId: string;
  attendance: DeriveDailyAttendanceStatus;
  lateArrival: GenerateLateArrivalStatus | null;
  earlyDeparture: GenerateEarlyDepartureStatus | null;
  overtime: GenerateOvertimeCandidateStatus | null;
  error: string | null;
}

export interface ProcessAttendanceDayResult {
  date: string;
  employeesProcessed: number;
  attendanceDerived: number;
  attendanceUnchanged: number;
  withoutSchedule: number;
  exempt: number;
  dayOff: number;
  /** Feriados sin marcación: día de descanso pagado, no ausencia. */
  holiday: number;
  lateCandidates: number;
  earlyDepartureCandidates: number;
  overtimeCandidates: number;
  /** INSTALACIÓN: el motor no propone minutos porque su política sigue sin confirmarse por el negocio. */
  overtimeRequiresConfirmation: number;
  /** Códigos diarios (P/?) escritos o actualizados por el motor. No cuenta los que puso una persona. */
  statusesWritten: number;
  failures: { employeeId: string; message: string }[];
  outcomes: EmployeeProcessOutcome[];
}

async function loadEmployeesInScope(
  supabase: SupabaseClient<Database>,
  options: ProcessAttendanceDayOptions
): Promise<string[]> {
  if (options.employeeIds) return options.employeeIds;

  const { data, error } = await supabase
    .from("employees")
    .select("id, employee_groups!employees_company_group_fkey(code)")
    .eq("active", true)
    .order("id");
  if (error) throw new Error(`processAttendanceDay: fallo listando employees: ${error.message}`);

  const rows = data ?? [];
  if (!options.areaCode) return rows.map((r) => r.id);

  return rows
    .filter((r) => {
      const group = r.employee_groups as { code: string } | { code: string }[] | null;
      const code = Array.isArray(group) ? group[0]?.code : group?.code;
      return code === options.areaCode;
    })
    .map((r) => r.id);
}

/**
 * Marcación EFECTIVA por `attendance_record_id` (cruda + corrección vigente).
 *
 * Por qué existe (MB-3): `deriveDailyAttendanceRecord` escribe el dato CRUDO
 * de Workera, que es correcto -- ese dato es inmutable y nunca debe
 * sobrescribirse. Pero cuando un trabajador olvida marcar la salida y el jefe
 * la corrige, la corrección vive en `attendance_corrections`, una tabla
 * aparte. Sin este paso los generadores seguirían viendo `NULL` y el candidato
 * de horas extra nunca se produciría, aunque la bandera de marcación faltante
 * ya se hubiera resuelto sola.
 *
 * Se lee la VISTA, no las dos tablas por separado: el COALESCE de "qué hora
 * vale" tiene una sola definición (`attendance_effective_punches`), la misma
 * que ya usa la validación de aprobación de horas extra a nivel de base.
 * Duplicarlo acá crearía una segunda fuente de verdad.
 *
 * Una consulta por día, no por trabajador. Un fallo degrada a la marcación
 * cruda en vez de abortar: es exactamente el comportamiento previo a MB-3.
 */
async function loadEffectivePunches(
  supabase: SupabaseClient<Database>,
  date: string
): Promise<Map<string, { clockIn: string | null; clockOut: string | null }>> {
  const { data, error } = await supabase
    .from("attendance_effective_punches")
    .select("attendance_record_id, effective_clock_in, effective_clock_out")
    .eq("work_date", date);

  if (error || !data) return new Map();

  return new Map(
    data
      .filter((r): r is typeof r & { attendance_record_id: string } => r.attendance_record_id !== null)
      .map((r) => [r.attendance_record_id, { clockIn: r.effective_clock_in, clockOut: r.effective_clock_out }])
  );
}

async function loadBirthdays(
  supabase: SupabaseClient<Database>,
  employeeIds: string[]
): Promise<Map<string, BirthdayContext>> {
  if (employeeIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("employee_birthdays")
    .select("employee_id, birth_month, birth_day")
    .in("employee_id", employeeIds);

  // Un fallo acá no debe tumbar la corrida completa: sin cumpleaños el
  // generador de salida anticipada simplemente no aplica la autorización, que
  // es exactamente su comportamiento cuando el trabajador no tiene la fecha
  // cargada. Degradar es correcto; abortar el día no lo sería.
  if (error) return new Map();

  return new Map((data ?? []).map((r) => [r.employee_id, { birthMonth: r.birth_month, birthDay: r.birth_day }]));
}

/**
 * Marca el código diario de asistencia (MB-4).
 *
 * Reglas, deliberadamente mínimas:
 *   P -> hubo marcación de entrada.
 *   ? -> era día laboral y no hubo ninguna marcación.
 *   nada -> exento, día libre o sin horario: no hay nada que afirmar.
 *
 * NUNCA marca F. Convertir "no marcó" en "faltó" es una decisión de persona;
 * "?" es la señal que el jefe revisa para corregir la marcación (MB-3) o
 * reclasificar el día.
 *
 * Y nunca pisa una fila ajena: si RRHH ya marcó el día como F-J, V o L, el
 * motor la respeta aunque se reprocese el día cien veces. Solo administra las
 * filas que él mismo escribió (`source = 'system'`).
 */
async function applyDailyStatus(
  supabase: SupabaseClient<Database>,
  date: string,
  targets: { employeeId: string; code: "P" | "?" }[]
): Promise<number> {
  if (targets.length === 0) return 0;

  const { data: catalog, error: catalogError } = await supabase.from("attendance_statuses").select("id, code");
  if (catalogError) throw new Error(`applyDailyStatus: fallo leyendo attendance_statuses: ${catalogError.message}`);
  const idByCode = new Map((catalog ?? []).map((s) => [s.code, s.id]));

  const employeeIds = targets.map((t) => t.employeeId);
  const { data: existing, error: existingError } = await supabase
    .from("attendance_status_records")
    .select("id, employee_id, attendance_status_id, source, source_version")
    .in("employee_id", employeeIds)
    .eq("work_date", date)
    .eq("is_current", true);
  if (existingError) throw new Error(`applyDailyStatus: fallo leyendo attendance_status_records: ${existingError.message}`);

  const currentByEmployee = new Map((existing ?? []).map((r) => [r.employee_id, r]));
  let written = 0;

  for (const target of targets) {
    const statusId = idByCode.get(target.code);
    if (!statusId) continue;

    const current = currentByEmployee.get(target.employeeId);

    // Fila puesta por una persona o por Workera: intocable.
    if (current && current.source !== "system") continue;
    // Ya dice lo mismo: no versionar por versionar.
    if (current && current.attendance_status_id === statusId) continue;

    if (current) {
      const { error } = await supabase.from("attendance_status_records").update({ is_current: false }).eq("id", current.id);
      if (error) throw new Error(`applyDailyStatus: fallo versionando el código anterior: ${error.message}`);
    }

    const { error } = await supabase.from("attendance_status_records").insert({
      employee_id: target.employeeId,
      work_date: date,
      attendance_status_id: statusId,
      source: "system",
      // `source_hash` es NOT NULL y describe el dato que originó la fila. Para
      // una marca del motor eso es exactamente el código derivado: dos
      // corridas que concluyen lo mismo producen el mismo hash, que es la
      // señal de "nada cambió" del resto del esquema.
      source_hash: createHash("sha256").update(`SYSTEM|${target.employeeId}|${date}|${target.code}`).digest("hex"),
      source_version: (current?.source_version ?? 0) + 1,
    });
    if (error) throw new Error(`applyDailyStatus: fallo insertando el código diario: ${error.message}`);
    written += 1;
  }

  return written;
}

export async function processAttendanceDay(
  supabase: SupabaseClient<Database>,
  date: string,
  options: ProcessAttendanceDayOptions = {},
  deps: ProcessAttendanceDayDeps = DEFAULT_DEPS
): Promise<ProcessAttendanceDayResult> {
  const employeeIds = await loadEmployeesInScope(supabase, options);
  const birthdays = await loadBirthdays(supabase, employeeIds);
  // Se carga ANTES del bucle a propósito: una corrección solo puede existir
  // sobre un attendance_record que ya existía. Un registro recién derivado en
  // esta misma corrida nunca tiene corrección, y para él la marcación efectiva
  // es la cruda -- que es justo el fallback de abajo.
  const effectivePunches = await loadEffectivePunches(supabase, date);
  // Un feriado legal es día de descanso pagado: si nadie marca, NO es
  // ausencia ni tarjeta no marcada. Una sola consulta para toda la fecha.
  const isHoliday = (await loadHolidaySet(supabase, date, date).catch(() => new Set<string>())).has(date);

  const outcomes: EmployeeProcessOutcome[] = [];
  const failures: { employeeId: string; message: string }[] = [];
  const statusTargets: { employeeId: string; code: "P" | "?" }[] = [];

  for (const employeeId of employeeIds) {
    try {
      const derived = await deps.deriveDailyAttendanceRecord(supabase, employeeId, date, isHoliday);

      // Sin `attendanceRecordId` no hay nada sobre lo que generar candidatos:
      // exento, día libre, o sin horario asignado. No es un error.
      if (!derived.attendanceRecordId) {
        outcomes.push({
          employeeId,
          attendance: derived.status,
          lateArrival: null,
          earlyDeparture: null,
          overtime: null,
          error: null,
        });
        continue;
      }

      // La corrección autorizada del jefe manda sobre el dato crudo; sin
      // corrección, `effective` es idéntico al crudo.
      const effective = effectivePunches.get(derived.attendanceRecordId);
      const clockIn = effective?.clockIn ?? derived.clockIn;
      const clockOut = effective?.clockOut ?? derived.clockOut;

      // MB-4: día laboral con marcación -> P; sin ninguna marcación -> "?".
      statusTargets.push({ employeeId, code: clockIn ? "P" : "?" });

      const lateArrival = await deps.generateLateArrivalCandidate(supabase, employeeId, date, derived.attendanceRecordId, clockIn);
      const earlyDeparture = await deps.generateEarlyDepartureCandidate(
        supabase,
        employeeId,
        date,
        derived.attendanceRecordId,
        clockOut,
        birthdays.get(employeeId) ?? null
      );
      const overtime = await deps.generateOvertimeCandidate(supabase, employeeId, date, derived.attendanceRecordId, clockOut);

      outcomes.push({
        employeeId,
        attendance: derived.status,
        lateArrival: lateArrival.status,
        earlyDeparture: earlyDeparture.status,
        overtime: overtime.status,
        error: null,
      });
    } catch (err) {
      // El fallo de un trabajador nunca cancela el día: los otros 43 sí deben
      // quedar procesados y disponibles para su supervisor. El detalle queda
      // en `failures` y la corrida se marca PARTIAL, nunca SUCCEEDED en falso.
      const message = err instanceof Error ? err.message : "error desconocido";
      failures.push({ employeeId, message });
      outcomes.push({
        employeeId,
        attendance: "NO_SCHEDULE_ASSIGNED",
        lateArrival: null,
        earlyDeparture: null,
        overtime: null,
        error: message,
      });
    }
  }

  // Se aplica al final, en bloque: un fallo escribiendo el código diario no
  // debe invalidar los candidatos ya generados, que son el trabajo real de la
  // cola de revisión.
  let statusesWritten = 0;
  try {
    statusesWritten = await applyDailyStatus(supabase, date, statusTargets);
  } catch (err) {
    failures.push({ employeeId: "(código diario)", message: err instanceof Error ? err.message : "error desconocido" });
  }

  const countAttendance = (status: DeriveDailyAttendanceStatus) =>
    outcomes.filter((o) => o.error === null && o.attendance === status).length;

  return {
    statusesWritten,
    date,
    employeesProcessed: employeeIds.length,
    attendanceDerived: countAttendance("DERIVED"),
    attendanceUnchanged: countAttendance("UNCHANGED"),
    withoutSchedule: countAttendance("NO_SCHEDULE_ASSIGNED"),
    exempt: countAttendance("EXEMPT"),
    dayOff: countAttendance("DAY_OFF"),
    holiday: countAttendance("HOLIDAY"),
    lateCandidates: outcomes.filter((o) => o.lateArrival === "GENERATED").length,
    earlyDepartureCandidates: outcomes.filter((o) => o.earlyDeparture === "GENERATED").length,
    overtimeCandidates: outcomes.filter((o) => o.overtime === "GENERATED").length,
    overtimeRequiresConfirmation: outcomes.filter((o) => o.overtime === "OVERTIME_POLICY_REQUIRES_CONFIRMATION").length,
    failures,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Corrida registrada en `rule_engine_runs`

export type RuleEngineRunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED" | "ALREADY_RUNNING";

export interface RuleEngineRunOutcome {
  status: RuleEngineRunStatus;
  runId: string | null;
  date: string;
  result: ProcessAttendanceDayResult | null;
  errorSummary: string | null;
}

const STALE_RUNNING_SECONDS = 900;

/**
 * Envuelve `processAttendanceDay` con la bitácora y el control de concurrencia.
 * El índice único parcial `rule_engine_runs_no_concurrent_running_key` impide
 * dos corridas simultáneas para la misma fecha; la segunda recibe 23505 de
 * Postgres y termina como `ALREADY_RUNNING` sin tocar nada.
 *
 * `supabase` debe ser el cliente admin (service_role): la tabla no tiene
 * policy de escritura para `authenticated` a propósito, y el camino del cron
 * no tiene sesión de usuario.
 */
export async function runRuleEngineForDate(
  supabase: SupabaseClient<Database>,
  date: string,
  params: {
    triggeredBy: "CRON" | "MANUAL";
    triggeredByProfile?: string | null;
    options?: ProcessAttendanceDayOptions;
    deps?: ProcessAttendanceDayDeps;
  } = { triggeredBy: "MANUAL" }
): Promise<RuleEngineRunOutcome> {
  await supabase.rpc("reclaim_stale_rule_engine_runs", { p_stale_after_seconds: STALE_RUNNING_SECONDS });

  const { data: run, error: runError } = await supabase
    .from("rule_engine_runs")
    .insert({
      work_date: date,
      status: "RUNNING",
      triggered_by: params.triggeredBy,
      triggered_by_profile: params.triggeredByProfile ?? null,
    })
    .select("id")
    .single();

  if (runError) {
    if (runError.code === "23505") {
      return { status: "ALREADY_RUNNING", runId: null, date, result: null, errorSummary: null };
    }
    throw new Error(`runRuleEngineForDate: fallo abriendo la corrida: ${runError.message}`);
  }

  try {
    const result = await processAttendanceDay(supabase, date, params.options ?? {}, params.deps ?? DEFAULT_DEPS);
    const status = result.failures.length > 0 ? "PARTIAL" : "SUCCEEDED";

    await supabase
      .from("rule_engine_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        employees_processed: result.employeesProcessed,
        attendance_derived: result.attendanceDerived,
        late_candidates: result.lateCandidates,
        early_departure_candidates: result.earlyDepartureCandidates,
        overtime_candidates: result.overtimeCandidates,
        without_schedule: result.withoutSchedule,
        failure_count: result.failures.length,
        error_summary:
          result.failures.length > 0
            ? `${result.failures.length} trabajador(es) fallaron; primero: ${result.failures[0].message.slice(0, 200)}`
            : null,
      })
      .eq("id", run.id);

    return { status, runId: run.id, date, result, errorSummary: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    await supabase
      .from("rule_engine_runs")
      .update({ status: "FAILED", finished_at: new Date().toISOString(), error_summary: message.slice(0, 500) })
      .eq("id", run.id);

    return { status: "FAILED", runId: run.id, date, result: null, errorSummary: message };
  }
}
