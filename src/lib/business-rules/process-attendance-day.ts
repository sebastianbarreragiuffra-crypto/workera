import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { AreaCode } from "../access/scope";
import { deriveDailyAttendanceRecord, type DeriveDailyAttendanceStatus } from "./daily-attendance";
import {
  generateLateArrivalCandidate,
  retireCurrentLateArrivalCandidate,
  type GenerateLateArrivalStatus,
} from "./late-arrival";
import {
  generateEarlyDepartureCandidate,
  retireCurrentEarlyDepartureCandidate,
  type GenerateEarlyDepartureStatus,
} from "./early-departure";
import { generateOvertimeCandidate, type GenerateOvertimeCandidateStatus } from "./overtime-confirmation";
import type { BirthdayContext } from "./birthday";
import { loadHolidaySet } from "./holidays";
import { resolveEffectiveEmployeeGroup } from "./effective-employee-group";

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
  /** Tenant raíz de la corrida. Obligatorio porque este motor usa service_role y no hereda RLS de una sesión. */
  companyId: string;
  /** Lease exacto de `rule_engine_runs`; todos los RPC de escritura lo revalidan. */
  ruleEngineRunId: string;
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
  retireCurrentLateArrivalCandidate: typeof retireCurrentLateArrivalCandidate;
  retireCurrentEarlyDepartureCandidate: typeof retireCurrentEarlyDepartureCandidate;
  generateOvertimeCandidate: typeof generateOvertimeCandidate;
}

const DEFAULT_DEPS: ProcessAttendanceDayDeps = {
  deriveDailyAttendanceRecord,
  generateLateArrivalCandidate,
  generateEarlyDepartureCandidate,
  retireCurrentLateArrivalCandidate,
  retireCurrentEarlyDepartureCandidate,
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
  /** Compatibilidad histórica: candidatos que aún requieren una política no configurada. */
  overtimeRequiresConfirmation: number;
  /** Códigos diarios (P/?) escritos o actualizados por el motor. No cuenta los que puso una persona. */
  statusesWritten: number;
  failures: { employeeId: string; message: string }[];
  outcomes: EmployeeProcessOutcome[];
}

const PAGE_SIZE = 1_000;
const ID_BATCH_SIZE = 150;

interface PageResponse<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function fetchAllPages<T>(
  context: string,
  fetchPage: (from: number, to: number) => PromiseLike<PageResponse<T>>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${context}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function chunksOf<T>(values: T[], size = ID_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

interface EmployeeScopeRow {
  id: string;
  active?: boolean;
  hire_date?: string | null;
  employee_groups: { code: string } | { code: string }[] | null;
}

async function loadEmployeesWithFacts(
  supabase: SupabaseClient<Database>,
  companyId: string,
  date: string,
  employeeIds: string[]
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const [rawPages, attendancePages] = await Promise.all([
    Promise.all(
      chunksOf(employeeIds).map((ids) =>
        fetchAllPages<{ employee_id: string }>("processAttendanceDay: fallo comprobando marcaciones inactivas", (from, to) =>
          supabase
            .from("workera_attendance_events")
            .select("employee_id")
            .eq("company_id", companyId)
            .eq("work_date", date)
            .eq("is_current", true)
            .in("employee_id", ids)
            .order("employee_id")
            .range(from, to) as unknown as PromiseLike<PageResponse<{ employee_id: string }>>
        )
      )
    ),
    Promise.all(
      chunksOf(employeeIds).map((ids) =>
        fetchAllPages<{ employee_id: string }>("processAttendanceDay: fallo comprobando asistencia inactiva", (from, to) =>
          supabase
            .from("attendance_records")
            .select("employee_id")
            .eq("work_date", date)
            .eq("is_current", true)
            .in("employee_id", ids)
            .order("employee_id")
            .range(from, to) as unknown as PromiseLike<PageResponse<{ employee_id: string }>>
        )
      )
    ),
  ]);
  return new Set([...rawPages.flat(2), ...attendancePages.flat(2)].map((row) => row.employee_id));
}

async function loadEmployeesWithHistoricalGroup(
  supabase: SupabaseClient<Database>,
  date: string,
  employeeIds: string[]
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();

  type HistoricalGroupRow = { employee_id: string; effective_to: string | null };
  const pages = await Promise.all(
    chunksOf(employeeIds).map((ids) =>
      fetchAllPages<HistoricalGroupRow>(
        "processAttendanceDay: fallo comprobando cobertura histórica de grupo",
        (from, to) =>
          supabase
            .from("employee_group_assignments")
            .select("employee_id, effective_to")
            .in("employee_id", ids)
            .lte("effective_from", date)
            .order("employee_id")
            .range(from, to) as unknown as PromiseLike<PageResponse<HistoricalGroupRow>>
      )
    )
  );

  return new Set(
    pages
      .flat()
      .filter((row) => row.effective_to === null || row.effective_to >= date)
      .map((row) => row.employee_id)
  );
}

async function loadEmployeesInScope(
  supabase: SupabaseClient<Database>,
  date: string,
  options: ProcessAttendanceDayOptions
): Promise<string[]> {
  if (options.employeeIds?.length === 0) return [];

  const requestedBatches = options.employeeIds ? chunksOf([...new Set(options.employeeIds)]) : [null];
  const pages = await Promise.all(
    requestedBatches.map((ids) =>
      fetchAllPages<EmployeeScopeRow>("processAttendanceDay: fallo listando employees", (from, to) => {
        let query = supabase
          .from("employees")
          .select("id, active, hire_date, employee_groups!employees_company_group_fkey(code)")
          .eq("company_id", options.companyId);
        // La corrida completa procesa el padrón activo. Un reproceso explícito
        // también debe aceptar a una persona hoy inactiva: sus hechos
        // históricos pueden necesitar corrección para finiquito/remuneración.
        if (ids) query = query.in("id", ids);
        return query.order("id").range(from, to) as unknown as PromiseLike<PageResponse<EmployeeScopeRow>>;
      })
    )
  );

  // Nunca deriva jornadas anteriores al ingreso, incluso en un rerun manual.
  let rows = pages.flat().filter((row) => !row.hire_date || row.hire_date <= date);
  if (!options.employeeIds) {
    const candidateIds = rows.map((row) => row.id);
    const employeesWithFacts = await loadEmployeesWithFacts(
      supabase,
      options.companyId,
      date,
      candidateIds
    );
    rows = rows.filter((row) => row.active !== false || employeesWithFacts.has(row.id));

    // En un reproceso histórico, el padrón activo de hoy no demuestra por sí
    // solo que una persona pertenecía a la empresa en esa fecha. La historia
    // de grupo es la fuente temporal. Un trabajador sin cobertura se incluye
    // únicamente si ya tiene hechos del día, para que el motor falle cerrado
    // en vez de ocultar una inconsistencia; sin hechos, se excluye y nunca se
    // inventa una ausencia retroactiva.
    const employeesWithHistoricalGroup = await loadEmployeesWithHistoricalGroup(
      supabase,
      date,
      rows.map((row) => row.id)
    );
    rows = rows.filter(
      (row) => employeesWithHistoricalGroup.has(row.id) || employeesWithFacts.has(row.id)
    );
  }
  if (!options.areaCode) return rows.map((r) => r.id);

  const historicalGroups = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      group: await resolveEffectiveEmployeeGroup(supabase, row.id, date, options.companyId),
    }))
  );
  return historicalGroups.filter((row) => row.group.code === options.areaCode).map((row) => row.id);
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
 * Una consulta por día, no por trabajador. Un fallo aborta la corrida: usar
 * silenciosamente la marcación cruda ignoraría una corrección autorizada y
 * podría producir candidatos financieros obsoletos.
 */
async function loadEffectivePunches(
  supabase: SupabaseClient<Database>,
  date: string,
  employeeIds: string[]
): Promise<Map<string, { clockIn: string | null; clockOut: string | null }>> {
  if (employeeIds.length === 0) return new Map();

  type EffectivePunchRow = {
    attendance_record_id: string | null;
    effective_clock_in: string | null;
    effective_clock_out: string | null;
  };
  const pages = await Promise.all(
    chunksOf(employeeIds).map((ids) =>
      fetchAllPages<EffectivePunchRow>("loadEffectivePunches: fallo leyendo attendance_effective_punches", (from, to) =>
        supabase
          .from("attendance_effective_punches")
          .select("attendance_record_id, effective_clock_in, effective_clock_out")
          .eq("work_date", date)
          .in("employee_id", ids)
          .order("attendance_record_id")
          .range(from, to) as unknown as PromiseLike<PageResponse<EffectivePunchRow>>
      )
    )
  );
  const data = pages.flat();

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

  type BirthdayRow = { employee_id: string; birth_month: number; birth_day: number };
  const pages = await Promise.all(
    chunksOf(employeeIds).map((ids) =>
      fetchAllPages<BirthdayRow>("loadBirthdays: fallo leyendo employee_birthdays", (from, to) =>
        supabase
          .from("employee_birthdays")
          .select("employee_id, birth_month, birth_day")
          .in("employee_id", ids)
          .order("employee_id")
          .range(from, to) as unknown as PromiseLike<PageResponse<BirthdayRow>>
      )
    )
  );

  return new Map(pages.flat().map((r) => [r.employee_id, { birthMonth: r.birth_month, birthDay: r.birth_day }]));
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
  companyId: string,
  ruleEngineRunId: string,
  date: string,
  targets: { employeeId: string; code: "P" | "?" }[]
): Promise<number> {
  if (targets.length === 0) return 0;

  const { data: catalog, error: catalogError } = await supabase.from("attendance_statuses").select("id, code");
  if (catalogError) throw new Error(`applyDailyStatus: fallo leyendo attendance_statuses: ${catalogError.message}`);
  const idByCode = new Map((catalog ?? []).map((s) => [s.code, s.id]));

  let written = 0;

  for (const target of targets) {
    const statusId = idByCode.get(target.code);
    if (!statusId) continue;
    const { data, error } = await supabase.rpc("replace_system_attendance_status", {
      p_company_id: companyId,
      p_rule_engine_run_id: ruleEngineRunId,
      p_employee_id: target.employeeId,
      p_work_date: date,
      p_attendance_status_id: statusId,
      // El hash describe exactamente la conclusión del motor. El RPC calcula
      // y versiona el historial en la misma transacción.
      p_source_hash: createHash("sha256")
        .update(`SYSTEM|${target.employeeId}|${date}|${target.code}`)
        .digest("hex"),
    });
    if (error) throw new Error(`applyDailyStatus: fallo publicando el código diario: ${error.message}`);
    if (data === true) written += 1;
  }

  return written;
}

export async function processAttendanceDay(
  supabase: SupabaseClient<Database>,
  date: string,
  options: ProcessAttendanceDayOptions,
  deps: ProcessAttendanceDayDeps = DEFAULT_DEPS
): Promise<ProcessAttendanceDayResult> {
  const companyId = requireCompanyId(options.companyId);
  const ruleEngineRunId = requireRuleEngineRunId(options.ruleEngineRunId);
  const employeeIds = await loadEmployeesInScope(supabase, date, { ...options, companyId });
  const birthdays = await loadBirthdays(supabase, employeeIds);
  // Se carga ANTES del bucle a propósito: una corrección solo puede existir
  // sobre un attendance_record que ya existía. Un registro recién derivado en
  // esta misma corrida nunca tiene corrección, y para él la marcación efectiva
  // es la cruda -- que es justo el fallback de abajo.
  const effectivePunches = await loadEffectivePunches(supabase, date, employeeIds);
  // Un feriado legal es día de descanso pagado: si nadie marca, NO es
  // ausencia ni tarjeta no marcada. Una sola consulta para toda la fecha.
  // Fallar cerrado: continuar sin calendario puede convertir un feriado en
  // ausencia o calcular una tasa de horas extra incorrecta.
  const isHoliday = (await loadHolidaySet(supabase, date, date)).has(date);

  const outcomes: EmployeeProcessOutcome[] = [];
  const failures: { employeeId: string; message: string }[] = [];
  const statusTargets: { employeeId: string; code: "P" | "?" }[] = [];

  for (const employeeId of employeeIds) {
    try {
      const derived = await deps.deriveDailyAttendanceRecord(
        supabase,
        employeeId,
        date,
        companyId,
        isHoliday,
        ruleEngineRunId
      );

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

      // Un feriado trabajado no tiene hora ordinaria de entrada/salida contra
      // la cual medir atraso o salida anticipada. Sí conserva el candidato de
      // horas extra, clasificado HH100 por el trigger de base de datos. Antes
      // de omitir esos generadores se retira cualquier candidato que hubiera
      // quedado vigente cuando la jornada todavía no estaba marcada feriado.
      if (isHoliday) {
        await deps.retireCurrentLateArrivalCandidate(supabase, employeeId, date, companyId, ruleEngineRunId);
        await deps.retireCurrentEarlyDepartureCandidate(supabase, employeeId, date, companyId, ruleEngineRunId);
      }
      const lateArrival = isHoliday
        ? null
        : await deps.generateLateArrivalCandidate(
            supabase,
            employeeId,
            date,
            derived.attendanceRecordId,
            clockIn,
            companyId,
            ruleEngineRunId
          );
      const earlyDeparture = isHoliday
        ? null
        : await deps.generateEarlyDepartureCandidate(
            supabase,
            employeeId,
            date,
            derived.attendanceRecordId,
            clockOut,
            birthdays.get(employeeId) ?? null,
            companyId,
            ruleEngineRunId
          );
      const overtime = await deps.generateOvertimeCandidate(
        supabase,
        employeeId,
        date,
        derived.attendanceRecordId,
        clockOut,
        clockIn,
        isHoliday,
        companyId,
        ruleEngineRunId
      );

      // MB-4: día laboral con marcación -> P; sin ninguna marcación -> "?".
      // Se agrega solo DESPUÉS de completar todos los generadores: si alguno
      // falla, no publicamos un P/? que haga parecer cerrada una jornada cuyo
      // grafo financiero quedó parcialmente recalculado.
      statusTargets.push({ employeeId, code: clockIn ? "P" : "?" });

      outcomes.push({
        employeeId,
        attendance: derived.status,
        lateArrival: lateArrival?.status ?? null,
        earlyDeparture: earlyDeparture?.status ?? null,
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
    statusesWritten = await applyDailyStatus(supabase, companyId, ruleEngineRunId, date, statusTargets);
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

function requireCompanyId(companyId: string | undefined): string {
  const normalized = companyId?.trim();
  if (!normalized) {
    throw new Error("processAttendanceDay: companyId es obligatorio para una operación con service_role.");
  }
  return normalized;
}

function requireRuleEngineRunId(runId: string | undefined): string {
  const normalized = runId?.trim();
  if (!normalized) {
    throw new Error("processAttendanceDay: ruleEngineRunId es obligatorio para publicar resultados.");
  }
  return normalized;
}

/**
 * Envuelve `processAttendanceDay` con la bitácora y el control de concurrencia.
 * El índice único parcial `rule_engine_runs_no_concurrent_running_key` impide
 * dos corridas simultáneas para la misma empresa y fecha; la segunda recibe
 * 23505 de Postgres y termina como `ALREADY_RUNNING` sin tocar nada.
 *
 * `supabase` debe ser el cliente admin (service_role): la tabla no tiene
 * policy de escritura para `authenticated` a propósito, y el camino del cron
 * no tiene sesión de usuario.
 */
export async function runRuleEngineForDate(
  supabase: SupabaseClient<Database>,
  date: string,
  params: {
    companyId: string;
    triggeredBy: "CRON" | "MANUAL";
    triggeredByProfile?: string | null;
    deps?: ProcessAttendanceDayDeps;
  }
): Promise<RuleEngineRunOutcome> {
  const companyId = requireCompanyId(params.companyId);
  // Una fila SUCCEEDED es evidencia autoritativa para READY_TO_CLOSE. Por
  // eso este entrypoint registrado nunca admite un subconjunto: employeeIds,
  // areaCode o incluso un arreglo vacío podrían hacer pasar por completa una
  // corrida parcial. processAttendanceDay conserva esos filtros únicamente
  // para pruebas/utilidades que no escriben el ledger autoritativo.
  if ("options" in params) {
    throw new Error("runRuleEngineForDate: una corrida registrada debe procesar el día completo.");
  }
  const { error: reclaimError } = await supabase.rpc("reclaim_stale_rule_engine_runs", {
    p_company_id: companyId,
    p_stale_after_seconds: STALE_RUNNING_SECONDS,
  });
  if (reclaimError) {
    throw new Error(`runRuleEngineForDate: fallo recuperando corridas abandonadas: ${reclaimError.message}`);
  }

  const { data: runId, error: runError } = await supabase.rpc("begin_attendance_rule_engine_run", {
    p_company_id: companyId,
    p_work_date: date,
    p_triggered_by: params.triggeredBy,
    p_triggered_by_profile: params.triggeredByProfile ?? null,
  });

  if (runError) {
    throw new Error(`runRuleEngineForDate: fallo abriendo la corrida: ${runError.message}`);
  }
  if (typeof runId !== "string") {
    return { status: "ALREADY_RUNNING", runId: null, date, result: null, errorSummary: null };
  }

  try {
    const result = await processAttendanceDay(
      supabase,
      date,
      { companyId, ruleEngineRunId: runId },
      params.deps ?? DEFAULT_DEPS
    );
    const status = result.failures.length > 0 ? "PARTIAL" : "SUCCEEDED";

    const errorSummary =
      result.failures.length > 0
        ? `${result.failures.length} trabajador(es) fallaron; primero: ${result.failures[0].message.slice(0, 200)}`
        : null;
    const { data: finishResult, error: finishError } = await supabase.rpc(
      "finish_attendance_rule_engine_run",
      {
        p_company_id: companyId,
        p_rule_engine_run_id: runId,
        p_status: status,
        p_employees_processed: result.employeesProcessed,
        p_attendance_derived: result.attendanceDerived,
        p_late_candidates: result.lateCandidates,
        p_early_departure_candidates: result.earlyDepartureCandidates,
        p_overtime_candidates: result.overtimeCandidates,
        p_without_schedule: result.withoutSchedule,
        p_failure_count: result.failures.length,
        p_error_summary: errorSummary,
      }
    );
    if (finishError) {
      throw new Error(`runRuleEngineForDate: fallo cerrando la corrida ${runId}: ${finishError.message}`);
    }
    if (finishResult === "STALE_INPUTS") {
      return {
        status: "FAILED",
        runId,
        date,
        result: null,
        errorSummary: "Los insumos cambiaron durante la corrida; es obligatorio recalcular.",
      };
    }
    if (finishResult !== "FINISHED") {
      throw new Error(
        `runRuleEngineForDate: la corrida ${runId} perdió su lease antes de cerrar; no se sobrescribió su estado.`
      );
    }

    return { status, runId, date, result, errorSummary: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    const { data: failedResult, error: failedUpdateError } = await supabase.rpc(
      "finish_attendance_rule_engine_run",
      {
        p_company_id: companyId,
        p_rule_engine_run_id: runId,
        p_status: "FAILED",
        p_employees_processed: 0,
        p_attendance_derived: 0,
        p_late_candidates: 0,
        p_early_departure_candidates: 0,
        p_overtime_candidates: 0,
        p_without_schedule: 0,
        p_failure_count: 1,
        p_error_summary: message.slice(0, 500),
      }
    );

    if (failedUpdateError) {
      throw new Error(
        `runRuleEngineForDate: la corrida ${runId} falló (${message}) y no se pudo registrar FAILED: ${failedUpdateError.message}`
      );
    }
    if (failedResult !== "FINISHED") {
      throw new Error(
        `runRuleEngineForDate: la corrida ${runId} perdió su lease (${message}); no se sobrescribió el estado vigente.`
      );
    }

    return { status: "FAILED", runId, date, result: null, errorSummary: message };
  }
}
