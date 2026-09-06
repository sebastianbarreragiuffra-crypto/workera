import "server-only";
import * as XLSX from "xlsx-js-style";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../access/scope";
import type { AttendanceExportPeriod } from "./attendance-export-periods";
import { loadHolidaySet } from "./holidays";

/**
 * Exportador de asistencia con el formato REAL de la planilla de ARCOTEX.
 *
 * La primera versión (Fase 9) generaba una lista plana de cuatro columnas
 * (Trabajador | Área | Fecha | Estado), imposible de comparar contra la
 * planilla que RRHH usa a diario. El formato real, confirmado leyendo el libro
 * vigente y documentado en docs/EXCEL_WORKFLOW_ANALYSIS.md, es una MATRIZ:
 *
 *   - leyenda de códigos arriba (P, F, F-P, F-J, P-L, P-M, V, L, L-M, R, ?)
 *   - una COLUMNA por día calendario del período (fines de semana en blanco)
 *   - un BLOQUE de filas por trabajador, con su nombre combinado en la col. A
 *   - la columna C con el total del período de cada fila
 *
 * Se generan 10 filas por trabajador: Asistencia, Faltas, Vacaciones,
 * Licencia, Atrasos, Salida anticipada, HH 50%, HH 100%, Bono HE y VIATICOS.
 * Las dos últimas conservan importes separados de las horas: el bono viene de
 * la política automática y viáticos queda vacío hasta tener una fuente.
 *
 * El libro se construye SIEMPRE desde cero. Hubo un intento de reutilizar el
 * .xls que entrega RRHH como plantilla, y se descartó: ese camino rellena los
 * bloques que el archivo ya trae y no sabe agregar filas, así que no puede
 * representar a nadie contratado después de haberlo recibido. Además el
 * archivo lleva nombres reales, no puede versionarse, y su ausencia hacía que
 * el mismo período saliera distinto en cada ambiente. Generar es la única
 * forma de que el padrón salga completo y reproducible.
 *
 * NUNCA se inventa un estado: un día sin fila vigente en
 * `attendance_status_records` sale como "?" (TARJETA NO MARCADA O CON
 * PROBLEMAS), que es exactamente el código que el catálogo ya define para ese
 * caso -- nunca un P o un F supuesto.
 */

const MISSING_STATUS_CODE = "?";

/** Códigos que cuentan en cada fila de conteo. Cada uno vale 1.00 en su día. */
const FALTA_CODES = new Set(["F"]);
const VACACIONES_CODES = new Set(["V"]);
/** `L-M` (licencia mutual) también es licencia: ambas descuentan del total de Asistencia. */
const LICENCIA_CODES = new Set(["L", "L-M"]);
const PERMISSION_CODES = new Set(["F-P", "F-J", "P-L", "P-M"]);
/** `R` todavía no tiene un efecto de nómina aprobado; debe fallar cerrado. */
const STATUS_CODES_REQUIRING_PAYROLL_REVIEW = new Set(["R"]);
const OVERTIME_50_CODE = "OVERTIME_50";
const OVERTIME_100_CODE = "OVERTIME_100";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

/**
 * PostgREST limita cada respuesta hospedada a 1.000 filas. Una planilla de
 * 97 personas por 22 días ya supera ese límite, así que toda consulta usada
 * por remuneraciones debe paginar explícitamente y con un orden estable.
 */
const PAGE_SIZE = 1_000;
const EMPLOYEE_ID_BATCH_SIZE = 150;

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

function chunksOf<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

const LEGEND: [string, string][] = [
  ["P", "PRESENTE"],
  ["F", "FALTA"],
  ["F-P", "FALTA CON PERMISO"],
  ["F-J", "FALTA JUSTIFICADA"],
  ["P-L", 'PERMISO "LEGAL"'],
  ["P-M", "PERMISO MATERNAL"],
  ["V", "VACACIONES"],
  ["L", "LICENCIA"],
  ["L-M", "LICENCIA MUTUAL"],
  ["R", "RECUPERAN HORAS"],
  ["?", "TARJETA NO MARCADA O CON PROBLEMAS"],
];
const KNOWN_STATUS_CODES = new Set(LEGEND.map(([code]) => code));

function statusRequiresPayrollReview(code: string): boolean {
  return code !== MISSING_STATUS_CODE &&
    (!KNOWN_STATUS_CODES.has(code) || STATUS_CODES_REQUIRING_PAYROLL_REVIEW.has(code));
}

const MONTH_SHORT = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

interface EmployeeRow {
  id: string;
  external_workera_id: string;
  rut: string | null;
  display_name: string;
  hire_date: string | null;
  active: boolean;
  employee_groups: { code: AreaCode } | { code: AreaCode }[] | null;
}

interface StatusRow {
  employee_id: string;
  work_date: string;
  attendance_statuses: { code: string } | { code: string }[] | null;
}

interface LateRow {
  employee_id: string;
  work_date: string;
  detected_minutes: number;
  late_arrival_decisions: { payroll_minutes: number; payroll_effect: string; is_current: boolean }[] | null;
}

interface EarlyDepartureRow {
  employee_id: string;
  work_date: string;
  detected_minutes: number;
  early_departure_decisions:
    | {
        payroll_minutes: number;
        payroll_effect: string;
        is_current: boolean;
      }[]
    | null;
}

interface MissingPunchRow {
  employee_id: string;
  work_date: string;
  status: Database["public"]["Enums"]["missing_punch_status"];
}

interface AbsenceRow {
  employee_id: string;
  start_date: string;
  end_date: string;
  absence_decisions:
    | {
        decision_status: string;
        is_current: boolean;
      }[]
    | null;
}

interface RuleEngineRunRow {
  work_date: string;
  status: "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  started_at: string;
}

async function loadRuleEngineRuns(
  supabase: SupabaseClient<Database>,
  companyId: string,
  period: AttendanceExportPeriod
): Promise<RuleEngineRunRow[]> {
  return fetchAllPages<RuleEngineRunRow>(
    "buildAttendanceExportData: fallo leyendo corridas del motor",
    (from, to) =>
      supabase
        .from("rule_engine_runs")
        .select("work_date, status, started_at")
        .eq("company_id", companyId)
        .gte("work_date", period.startDate)
        .lte("work_date", period.endDate)
        .order("work_date")
        .order("started_at", { ascending: false })
        .range(from, to) as unknown as PromiseLike<PageResponse<RuleEngineRunRow>>
  );
}

function latestRuleEngineRunByDate(rows: RuleEngineRunRow[]): Map<string, RuleEngineRunRow> {
  const latest = new Map<string, RuleEngineRunRow>();
  for (const run of rows) {
    const current = latest.get(run.work_date);
    if (!current || run.started_at > current.started_at) latest.set(run.work_date, run);
  }
  return latest;
}

interface OvertimeRow {
  employee_id: string;
  work_date: string;
  candidate_minutes: number;
  overtime_types: { code: string } | { code: string }[] | null;
  overtime_decisions:
    | {
        approved_minutes: number;
        decision_status: Database["public"]["Enums"]["overtime_decision_status"];
        is_current: boolean;
        employee_daily_bonuses:
          | { amount: number; currency: string }
          | { amount: number; currency: string }[]
          | null;
      }[]
    | null;
}

interface ScheduleAssignmentRow {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  work_schedules:
    | {
        work_schedule_rules: {
          day_of_week: number;
          scheduled_start: string | null;
          scheduled_end: string | null;
        }[];
      }
    | {
        work_schedule_rules: {
          day_of_week: number;
          scheduled_start: string | null;
          scheduled_end: string | null;
        }[];
      }[]
    | null;
}

interface TimeControlPolicyRow {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  policy_code: string;
}

function areaOf(row: EmployeeRow): AreaCode | null {
  const rel = row.employee_groups;
  const group = Array.isArray(rel) ? rel[0] : rel;
  return group?.code ?? null;
}

function unwrap<T>(rel: T | T[] | null): T | null {
  if (rel === null) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

/**
 * TODOS los días calendario del período, no solo los hábiles: la planilla real
 * muestra sábados y domingos como columnas en blanco, y quitarlos desalinearía
 * la comparación día a día contra el archivo que RRHH ya usa.
 */
export function calendarDaysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  for (let t = new Date(`${startDate}T12:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const WEEKDAY_NAME = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

/** `07:30:00` -> `07:30`. La planilla no escribe los segundos. */
function hhmm(value: string): string {
  return value.slice(0, 5);
}

/**
 * Texto del horario tal como lo escribe la planilla de RRHH bajo el nombre:
 * "Lunes a Jueves: 07:30 a 17:00" y, si el viernes difiere, su propia línea.
 * Los días con el mismo tramo se agrupan; los sueltos se listan.
 */
export function describeSchedule(
  rules: { dayOfWeek: number; start: string; end: string }[]
): string | null {
  if (rules.length === 0) return null;

  const byRange = new Map<string, number[]>();
  for (const rule of [...rules].sort((a, b) => a.dayOfWeek - b.dayOfWeek)) {
    const key = `${hhmm(rule.start)} a ${hhmm(rule.end)}`;
    byRange.set(key, [...(byRange.get(key) ?? []), rule.dayOfWeek]);
  }

  const lines: string[] = [];
  for (const [range, dows] of byRange) {
    const contiguous = dows.every((d, i) => i === 0 || d === dows[i - 1] + 1);
    const label =
      dows.length === 1
        ? WEEKDAY_NAME[dows[0]]
        : contiguous
          ? `${WEEKDAY_NAME[dows[0]]} a ${WEEKDAY_NAME[dows[dows.length - 1]]}`
          : dows.map((d) => WEEKDAY_NAME[d]).join(" y ");
    lines.push(`${label}: ${range}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

export interface AttendanceExportDay {
  statusCode: string;
  /** Minutos observados por el motor; nunca se usan directamente para descontar. */
  lateDetectedMinutes: number;
  lateMinutes: number;
  /** Minutos observados por el motor; nunca se usan directamente para descontar. */
  earlyDepartureDetectedMinutes: number;
  earlyDepartureMinutes: number;
  overtime50Minutes: number;
  overtime100Minutes: number;
  overtime50CandidateMinutes: number;
  overtime100CandidateMinutes: number;
  /** Monto otorgado por el motor de bonos para la decisión vigente, en CLP. */
  bonusAmount: number;
  lateDecisionPending: boolean;
  earlyDepartureDecisionPending: boolean;
  overtime50DecisionPending: boolean;
  overtime100DecisionPending: boolean;
  missingPunchPending: boolean;
  absenceDecisionPending: boolean;
}

export interface AttendanceExportWorker {
  employeeId: string;
  /** Identificador estable para conciliar con Workera sin depender del nombre. */
  employeeCode: string;
  /** Identificador legal de nómina, si el padrón autorizado lo contiene. */
  employeeRut: string | null;
  workerName: string;
  area: AreaCode;
  /** Indexado por fecha `YYYY-MM-DD`. Un día ausente equivale a "sin novedad". */
  days: Map<string, AttendanceExportDay>;
  /**
   * Día de ingreso. La planilla de RRHH pinta de verde los días anteriores:
   * una persona que entró el 17 no tiene por qué aparecer ausente el 16.
   */
  hireDate: string | null;
  /** El padrón actual puede desactivar personas que sí tuvieron datos en un período histórico. */
  currentlyActive: boolean;
  /**
   * Días de la semana que cubre su horario, en la convención de
   * `Date.getUTCDay()`: 0 domingo, 1 lunes. Vacío cuando no tiene horario
   * asignado en el período.
   */
  scheduledWeekdays: Set<number>;
  /** Fechas exactas cubiertas por alguna asignación de horario vigente. */
  scheduleCoveredDates: Set<string>;
  /** Fechas exactas en que la jornada vigente exige trabajar. */
  scheduledDates: Set<string>;
  /** Fechas en que la persona estaba exenta de marcar asistencia. */
  exemptDates: Set<string>;
  /** Texto del horario que la planilla escribe bajo el nombre. */
  scheduleLabel: string | null;
}

export interface AttendanceExportData {
  period: AttendanceExportPeriod;
  days: string[];
  workers: AttendanceExportWorker[];
  /** Feriados legales: quedan en blanco si no hubo hechos y conservan cualquier trabajo/licencia real. */
  holidays: ReadonlySet<string>;
  /** Estado administrativo del ciclo 16-15; null si no aplica o aún no está configurado. */
  reportingPeriodStatus: Database["public"]["Enums"]["reporting_period_status"] | null;
  /** Fechas cuya última corrida no terminó correctamente; no pueden presentarse como listas para pagar. */
  ruleEngineProblemDates: ReadonlySet<string>;
}

function emptyDay(): AttendanceExportDay {
  return {
    statusCode: MISSING_STATUS_CODE,
    lateDetectedMinutes: 0,
    lateMinutes: 0,
    earlyDepartureDetectedMinutes: 0,
    earlyDepartureMinutes: 0,
    overtime50Minutes: 0,
    overtime100Minutes: 0,
    overtime50CandidateMinutes: 0,
    overtime100CandidateMinutes: 0,
    bonusAmount: 0,
    lateDecisionPending: false,
    earlyDepartureDecisionPending: false,
    overtime50DecisionPending: false,
    overtime100DecisionPending: false,
    missingPunchPending: false,
    absenceDecisionPending: false,
  };
}

export async function buildAttendanceExportData(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  period: AttendanceExportPeriod,
  companyId: string
): Promise<AttendanceExportData> {
  const allowedAreas = areasVisibleToRole(callerRole);
  // El RUT es necesario para conciliación de nómina, pero no para supervisar
  // asistencia diaria. Aunque RLS permita leer la fila, no se exporta a roles
  // de supervisión por minimización de datos personales.
  const includePayrollIdentifiers = callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH";

  const employees = await fetchAllPages<EmployeeRow>(
    "buildAttendanceExportData: fallo listando empleados",
    (from, to) =>
      supabase
        .from("employees")
        .select("id, external_workera_id, rut, display_name, hire_date, active, employee_groups!employees_company_group_fkey!inner(code)")
        .eq("company_id", companyId)
        .in("employee_groups.code", allowedAreas)
        .order("id")
        .range(from, to) as unknown as PromiseLike<PageResponse<EmployeeRow>>
  );

  const scoped = employees
    .map((row) => ({
      id: row.id,
      // Algunos registros bootstrap usan `EXCEL-<RUT>` como identificador
      // temporal. Ocultar solo la columna RUT no bastaría: para supervisores
      // también se omite el código hasta que todos los padrones usen un ID
      // externo que no derive de un dato legal.
      employeeCode: includePayrollIdentifiers ? row.external_workera_id : "",
      employeeRut: includePayrollIdentifiers ? row.rut : null,
      displayName: row.display_name,
      hireDate: row.hire_date,
      active: row.active,
      area: areaOf(row),
    }))
    .filter(
      (employee): employee is {
        id: string;
        employeeCode: string;
        employeeRut: string | null;
        displayName: string;
        hireDate: string | null;
        active: boolean;
        area: AreaCode;
      } => employee.area !== null && (employee.hireDate === null || employee.hireDate <= period.endDate)
    );

  const days = calendarDaysBetween(period.startDate, period.endDate);
  // Una falla de calendario no puede convertir silenciosamente un feriado en
  // día laboral dentro de un artefacto usado para remuneraciones.
  const holidays = await loadHolidaySet(supabase, period.startDate, period.endDate);

  // Una fila P o un candidato de una corrida anterior puede seguir vigente si
  // el reproceso más reciente falló a mitad de camino. La exportación de
  // remuneraciones debe ver la última corrida por fecha y fallar cerrado: una
  // fecha RUNNING/PARTIAL/FAILED queda explícitamente en revisión.
  const initialRunsByDate = latestRuleEngineRunByDate(await loadRuleEngineRuns(supabase, companyId, period));

  let reportingPeriodStatus: AttendanceExportData["reportingPeriodStatus"] = null;
  if (period.type === "PAGO") {
    const { data: reportingPeriod, error: reportingPeriodError } = await supabase
      .from("reporting_periods")
      .select("status")
      .eq("period_start", period.startDate)
      .eq("period_end", period.endDate)
      .maybeSingle();
    if (reportingPeriodError) {
      throw new Error(`buildAttendanceExportData: fallo leyendo el estado del período: ${reportingPeriodError.message}`);
    }
    reportingPeriodStatus = reportingPeriod?.status ?? null;
  }

  const workers: AttendanceExportWorker[] = scoped.map((e) => ({
    employeeId: e.id,
    employeeCode: e.employeeCode,
    employeeRut: e.employeeRut,
    workerName: e.displayName,
    area: e.area,
    days: new Map(),
    hireDate: e.hireDate,
    currentlyActive: e.active,
    scheduledWeekdays: new Set<number>(),
    scheduleCoveredDates: new Set<string>(),
    scheduledDates: new Set<string>(),
    exemptDates: new Set<string>(),
    scheduleLabel: null,
  }));
  const byId = new Map(workers.map((w) => [w.employeeId, w]));

  const cell = (employeeId: string, date: string): AttendanceExportDay | null => {
    const worker = byId.get(employeeId);
    if (!worker) return null;
    let day = worker.days.get(date);
    if (!day) {
      day = emptyDay();
      worker.days.set(date, day);
    }
    return day;
  };

  const employeeIds = workers.map((worker) => worker.employeeId);
  if (employeeIds.length === 0) {
    return {
      period,
      days,
      workers,
      holidays,
      reportingPeriodStatus,
      ruleEngineProblemDates: new Set(days),
    };
  }

  const employeeIdBatches = chunksOf(employeeIds, EMPLOYEE_ID_BATCH_SIZE);
  const [statusPages, latePages, earlyDeparturePages, overtimePages, missingPunchPages, absencePages] = await Promise.all([
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<StatusRow>("buildAttendanceExportData: fallo leyendo estados", (from, to) =>
          supabase
            .from("attendance_status_records")
            .select("employee_id, work_date, attendance_statuses(code)")
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("is_current", true)
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<StatusRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<LateRow>("buildAttendanceExportData: fallo leyendo atrasos", (from, to) =>
          supabase
            .from("late_arrival_records")
            .select(
              "employee_id, work_date, detected_minutes, attendance_records!inner(is_current), late_arrival_decisions(payroll_minutes, payroll_effect, is_current)"
            )
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("is_current", true)
            .eq("attendance_records.is_current", true)
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<LateRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<EarlyDepartureRow>("buildAttendanceExportData: fallo leyendo salidas anticipadas", (from, to) =>
          supabase
            .from("early_departure_records")
            .select(
              "employee_id, work_date, detected_minutes, attendance_records!inner(is_current), early_departure_decisions(payroll_minutes, payroll_effect, is_current)"
            )
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("is_current", true)
            .eq("attendance_records.is_current", true)
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<EarlyDepartureRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<OvertimeRow>("buildAttendanceExportData: fallo leyendo horas extra", (from, to) =>
          supabase
            .from("overtime_records")
            .select(
              "employee_id, work_date, candidate_minutes, attendance_records!inner(is_current), overtime_types(code), overtime_decisions(approved_minutes, decision_status, is_current, employee_daily_bonuses(amount, currency))"
            )
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("is_current", true)
            .eq("attendance_records.is_current", true)
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<OvertimeRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<MissingPunchRow>("buildAttendanceExportData: fallo leyendo marcaciones incompletas", (from, to) =>
          supabase
            .from("attendance_missing_punch_flags")
            .select("employee_id, work_date, status, attendance_records!inner(is_current)")
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("attendance_records.is_current", true)
            .in("status", ["PENDING_CONTACT", "CONTACTED"])
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<MissingPunchRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<AbsenceRow>("buildAttendanceExportData: fallo leyendo ausencias", (from, to) =>
          supabase
            .from("absence_records")
            .select("employee_id, start_date, end_date, absence_decisions(decision_status, is_current)")
            .in("employee_id", ids)
            .lte("start_date", period.endDate)
            .gte("end_date", period.startDate)
            .eq("is_current", true)
            .order("employee_id")
            .order("start_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<AbsenceRow>>
        )
      )
    ),
  ]);

  const statusRows = statusPages.flat();
  const lateRows = latePages.flat();
  const earlyDepartureRows = earlyDeparturePages.flat();
  const overtimeRows = overtimePages.flat();
  const missingPunchRows = missingPunchPages.flat();
  const absenceRows = absencePages.flat();

  for (const row of statusRows) {
    const code = unwrap(row.attendance_statuses)?.code;
    const day = cell(row.employee_id, row.work_date);
    if (day && code) day.statusCode = code;
  }

  // Detectado y pagable son magnitudes distintas. Una observación sin decisión
  // o con NEEDS_REVIEW se conserva para la cola, pero aporta CERO al descuento.
  for (const row of lateRows) {
    const decisions = row.late_arrival_decisions ?? [];
    const current = decisions.find((d) => d.is_current);
    const day = cell(row.employee_id, row.work_date);
    if (day) {
      const requiresReview =
        current === undefined ||
        current.payroll_effect === "NEEDS_REVIEW" ||
        !["DEDUCT", "DO_NOT_DEDUCT"].includes(current.payroll_effect) ||
        (current.payroll_effect === "DO_NOT_DEDUCT" && current.payroll_minutes !== 0);
      day.lateDetectedMinutes = row.detected_minutes;
      day.lateDecisionPending = requiresReview;
      day.lateMinutes = !requiresReview && current?.payroll_effect === "DEDUCT" ? current.payroll_minutes : 0;
    }
  }

  // Salida anticipada sigue el mismo criterio de nómina que el atraso: con
  // decisión definitiva se usa payroll_minutes; sin ella lo detectado queda
  // solo en PENDIENTES. NEEDS_REVIEW nunca puede convertirse en descuento.
  for (const row of earlyDepartureRows) {
    const decisions = row.early_departure_decisions ?? [];
    const current = decisions.find((decision) => decision.is_current);
    const day = cell(row.employee_id, row.work_date);
    if (!day) continue;
    const requiresReview =
      current === undefined ||
      current.payroll_effect === "NEEDS_REVIEW" ||
      !["DEDUCT", "DO_NOT_DEDUCT"].includes(current.payroll_effect) ||
      (current.payroll_effect === "DO_NOT_DEDUCT" && current.payroll_minutes !== 0);
    day.earlyDepartureDetectedMinutes = row.detected_minutes;
    day.earlyDepartureDecisionPending = requiresReview;
    day.earlyDepartureMinutes = !requiresReview && current?.payroll_effect === "DEDUCT" ? current.payroll_minutes : 0;
  }

  for (const row of missingPunchRows) {
    const day = cell(row.employee_id, row.work_date);
    if (day) day.missingPunchPending = true;
  }

  // Una ausencia se refleja en el código diario cuando ya está consolidada,
  // pero su workflow de RR. HH. puede seguir abierto. Sin este control una
  // licencia PENDING_DOCUMENT o una ausencia DISPUTED podía aparecer como
  // "Sin pendientes" aunque todavía bloqueara el cierre operativo.
  for (const row of absenceRows) {
    const decisions = row.absence_decisions ?? [];
    const current = decisions.find((decision) => decision.is_current);
    const requiresReview =
      current === undefined || current.decision_status === "PENDING_DOCUMENT" || current.decision_status === "DISPUTED";
    if (!requiresReview) continue;

    const firstDate = row.start_date < period.startDate ? period.startDate : row.start_date;
    const lastDate = row.end_date > period.endDate ? period.endDate : row.end_date;
    for (const date of calendarDaysBetween(firstDate, lastDate)) {
      const day = cell(row.employee_id, date);
      if (day) day.absenceDecisionPending = true;
    }
  }

  // Horas extra: SOLO las aprobadas. Un candidato sin decisión todavía no es
  // hora extra pagable, y esta planilla es la que se compara contra la de
  // remuneraciones -- mostrar candidatos ahí inflaría el número.
  for (const row of overtimeRows) {
    const typeCode = unwrap(row.overtime_types)?.code;
    if (typeCode !== OVERTIME_50_CODE && typeCode !== OVERTIME_100_CODE) {
      throw new Error(`buildAttendanceExportData: tipo de hora extra no soportado (${typeCode ?? "sin código"}).`);
    }
    const decisions = row.overtime_decisions ?? [];
    const current = decisions.find((d) => d.is_current);

    const day = cell(row.employee_id, row.work_date);
    if (!day) continue;
    if (!current) {
      if (typeCode === OVERTIME_100_CODE) {
        day.overtime100DecisionPending = true;
        day.overtime100CandidateMinutes += row.candidate_minutes;
      } else {
        day.overtime50DecisionPending = true;
        day.overtime50CandidateMinutes += row.candidate_minutes;
      }
      continue;
    }
    if (current.approved_minutes <= 0) continue;
    if (typeCode === OVERTIME_100_CODE) day.overtime100Minutes += current.approved_minutes;
    else day.overtime50Minutes += current.approved_minutes;

    const bonuses = Array.isArray(current.employee_daily_bonuses)
      ? current.employee_daily_bonuses
      : current.employee_daily_bonuses
        ? [current.employee_daily_bonuses]
        : [];
    for (const bonus of bonuses) {
      if (bonus.currency !== "CLP") {
        throw new Error(`buildAttendanceExportData: moneda de bono no soportada (${bonus.currency}).`);
      }
      day.bonusAmount += bonus.amount;
    }
  }

  // Horario vigente de cada persona dentro del período. Da las dos cosas que
  // la planilla muestra y hoy faltaban: el texto bajo el nombre y qué días
  // cubre realmente, que es lo que decide el resaltado de quien no trabaja de
  // lunes a viernes.
  const schedulePages = await Promise.all(
    employeeIdBatches.map((ids) =>
      fetchAllPages<ScheduleAssignmentRow>("buildAttendanceExportData: fallo leyendo horarios", (from, to) =>
        supabase
          .from("schedule_assignments")
          .select(
            "employee_id, effective_from, effective_to, work_schedules(work_schedule_rules(day_of_week, scheduled_start, scheduled_end))"
          )
          .in("employee_id", ids)
          .lte("effective_from", period.endDate)
          .order("employee_id")
          .order("effective_from")
          .order("id")
          .range(from, to) as unknown as PromiseLike<PageResponse<ScheduleAssignmentRow>>
      )
    )
  );

  for (const row of schedulePages.flat()) {
    // Una asignación que terminó antes de que empezara el período no describe
    // este período.
    const endsBefore = row.effective_to !== null && row.effective_to < period.startDate;
    if (endsBefore) continue;

    const worker = byId.get(row.employee_id);
    if (!worker) continue;

    const schedule = unwrap(row.work_schedules);
    const rawRules = schedule?.work_schedule_rules ?? [];
    const workingRules = rawRules
      .filter(
        (rule): rule is { day_of_week: number; scheduled_start: string; scheduled_end: string } =>
          rule.scheduled_start !== null && rule.scheduled_end !== null
      )
      .map((rule) => ({
        dayOfWeek: rule.day_of_week,
        start: rule.scheduled_start,
        end: rule.scheduled_end,
      }));

    for (const date of days) {
      if (date < row.effective_from || (row.effective_to !== null && date > row.effective_to)) continue;
      worker.scheduleCoveredDates.add(date);
      if (workingRules.some((rule) => rule.dayOfWeek === weekdayOf(date))) {
        worker.scheduledDates.add(date);
      }
    }

    for (const rule of workingRules) worker.scheduledWeekdays.add(rule.dayOfWeek);
    const nextLabel = describeSchedule(workingRules);
    if (nextLabel && worker.scheduleLabel !== nextLabel) {
      worker.scheduleLabel = worker.scheduleLabel ? `${worker.scheduleLabel}\n${nextLabel}` : nextLabel;
    }
  }

  // La ausencia de marcación no es una incidencia cuando existe una exención
  // vigente. Se carga la vigencia exacta (no solo el estado actual) para que
  // un Excel histórico no cambie si la política termina después.
  const timeControlPolicyPages = await Promise.all(
    employeeIdBatches.map((ids) =>
      fetchAllPages<TimeControlPolicyRow>("buildAttendanceExportData: fallo leyendo exenciones", (from, to) =>
        supabase
          .from("employee_time_control_policies")
          .select("employee_id, effective_from, effective_to, policy_code")
          .in("employee_id", ids)
          .lte("effective_from", period.endDate)
          .order("employee_id")
          .order("effective_from")
          .order("id")
          .range(from, to) as unknown as PromiseLike<PageResponse<TimeControlPolicyRow>>
      )
    )
  );

  for (const row of timeControlPolicyPages.flat()) {
    if (row.policy_code !== "EXEMPT_FROM_TIME_CONTROL") continue;
    if (row.effective_to !== null && row.effective_to < period.startDate) continue;
    const worker = byId.get(row.employee_id);
    if (!worker) continue;

    for (const date of days) {
      if (date < row.effective_from || (row.effective_to !== null && date > row.effective_to)) continue;
      worker.exemptDates.add(date);
    }
  }

  // Personas hoy inactivas siguen perteneciendo al histórico cuando tienen
  // hechos dentro del período. Sin esta regla, una desvinculación posterior
  // cambia retroactivamente un Excel viejo. Si no tienen ningún dato en el
  // rango, se excluyen porque el modelo aún no guarda fecha de término.
  const includedWorkers = workers
    .filter((worker) => worker.currentlyActive || worker.days.size > 0)
    .sort((left, right) => left.workerName.localeCompare(right.workerName, "es"));

  // Segunda lectura: si una corrida empezó, cambió de estado o terminó
  // mientras se armaban las consultas, el conjunto podría mezclar versiones.
  // Se marca para revisión aunque la corrida haya terminado SUCCEEDED, porque
  // esta descarga no dispone todavía de un snapshot transaccional único.
  const finalRunsByDate = latestRuleEngineRunByDate(await loadRuleEngineRuns(supabase, companyId, period));
  const ruleEngineProblemDates = new Set<string>();
  for (const date of days) {
    const initial = initialRunsByDate.get(date);
    const final = finalRunsByDate.get(date);
    const changedDuringExport = initial?.started_at !== final?.started_at || initial?.status !== final?.status;
    if (!final || final.status !== "SUCCEEDED" || changedDuringExport) ruleEngineProblemDates.add(date);
  }

  return { period, days, workers: includedWorkers, holidays, reportingPeriodStatus, ruleEngineProblemDates };
}

// ---------------------------------------------------------------------------
// Construcción del libro

/** Excel guarda una duración como fracción de día; el formato `[h]:mm:ss` la muestra como h:mm:ss. */
function minutesToExcelDuration(minutes: number): number {
  return minutes / (24 * 60);
}

const BLOCK_ROWS = [
  "Asistencia",
  "Faltas",
  "Vacaciones",
  "Licencia",
  "Atrasos",
  "Salida anticipada",
  "HH 50%",
  "HH 100%",
  "Bono HE",
  "VIATICOS",
] as const;
const DURATION_ROWS = new Set<string>(["Atrasos", "Salida anticipada", "HH 50%", "HH 100%"]);
/** Filas que cuentan días. En la planilla de RRHH se ven como `1.00`, no como `1`. */
const COUNT_ROWS = new Set<string>(["Asistencia", "Faltas", "Vacaciones", "Licencia"]);
const MONEY_ROWS = new Set<string>(["Bono HE", "VIATICOS"]);

/**
 * Formatos copiados del libro que usa RRHH.
 *
 * El archivo original no es consistente consigo mismo: algunas celdas de
 * Atrasos quedaron con `[$-F400]h:mm:ss AM/PM`, que muestra dos minutos de
 * atraso como "12:02:00 AM". Eso es un error de la planilla, no un formato a
 * imitar, así que se toma la variante correcta, que es la mayoritaria.
 *
 * `h:mm:ss;@` en vez de `[h]:mm:ss`: son equivalentes bajo 24 horas, que es
 * todo lo que puede acumular un atraso o una hora extra diaria, y es el que
 * trae el libro real.
 */
const COUNT_FORMAT = "#,##0.00;[Red]#,##0.00";
const DURATION_DAY_FORMAT = "h:mm:ss;@";
/** Los totales del período pueden superar 24 horas y nunca deben volver a cero. */
const DURATION_TOTAL_FORMAT = "[h]:mm:ss";
const MONEY_FORMAT = '"$"#,##0';

/** Columna donde arrancan los días: A=nombre, B=etiqueta, C=total. */
const FIRST_DAY_COL = 3;
const HEADER_ROWS = 14; // título + 11 de leyenda + fila de meses + fila de días

const solidFill = (rgb: string) => ({ fill: { patternType: "solid", fgColor: { rgb }, bgColor: { rgb: "000000" } } });

/** Fondo explícito: mantiene la hoja legible también en visores con tema oscuro. */
function applyWhiteCanvas(sheet: XLSX.WorkSheet, rowCount: number, columnCount: number): void {
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[ref] ?? (sheet[ref] = { v: "", t: "s" });
      cell.s = solidFill("FFFFFF");
    }
  }
}

/**
 * Los rellenos de la planilla de RRHH, leídos del libro real.
 *
 * La versión anterior tenía la regla al revés: pintaba de naranja cualquier
 * celda con dato y de verde cualquiera sin dato, así que salía un tablero de
 * ajedrez. En el libro real un día hábil trabajado **no lleva relleno**, y el
 * color se reserva para lo que es excepción.
 */
const WEEKEND_STYLE = solidFill("FFF2CC");
const HOLIDAY_STYLE = solidFill("E4DFEC");
/** Días anteriores al ingreso de la persona: no estaba, no corresponde marcar. */
const BEFORE_HIRE_STYLE = solidFill("E7E6E6");
const DAY_OFF_STYLE = solidFill("F2F2F2");
const MISSING_SCHEDULE_STYLE = solidFill("FFF2CC");
const REVIEW_STYLE = solidFill("FCE4D6");
const HEADER_STYLE = {
  ...solidFill("1F4E78"),
  font: { bold: true, color: { rgb: "FFFFFF" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
};
const UNKNOWN_LEGEND_STYLE = solidFill("FCE4D6");
const BONUS_STYLE = solidFill("E2F0D9");
const VIATICOS_STYLE = solidFill("FFF2CC");
const THIN_BOTTOM_BORDER = { bottom: { style: "thin", color: { rgb: "B4C6E7" } } };

function beforeHire(worker: AttendanceExportWorker, date: string): boolean {
  return worker.hireDate !== null && date < worker.hireDate;
}

/**
 * Distingue un día realmente vacío de un registro que no debería existir
 * antes del ingreso. Sirve para excluirlo de la nómina sin esconder la
 * inconsistencia a RR. HH.
 */
function dayHasAttendanceFact(day: AttendanceExportDay): boolean {
  return day.statusCode !== MISSING_STATUS_CODE ||
    day.lateDetectedMinutes > 0 ||
    day.lateMinutes > 0 ||
    day.earlyDepartureDetectedMinutes > 0 ||
    day.earlyDepartureMinutes > 0 ||
    day.overtime50Minutes > 0 ||
    day.overtime100Minutes > 0 ||
    day.overtime50CandidateMinutes > 0 ||
    day.overtime100CandidateMinutes > 0 ||
    day.bonusAmount > 0 ||
    day.lateDecisionPending ||
    day.earlyDepartureDecisionPending ||
    day.overtime50DecisionPending ||
    day.overtime100DecisionPending ||
    day.missingPunchPending ||
    day.absenceDecisionPending;
}

/** Valor visible, pero deliberadamente no sumable, para un hecho pre-ingreso. */
function preHireMatrixValue(label: (typeof BLOCK_ROWS)[number], day: AttendanceExportDay): Cell {
  if (!dayHasAttendanceFact(day)) return null;
  if (label === "Asistencia") return day.statusCode === MISSING_STATUS_CODE ? "PEND." : day.statusCode;
  if (label === "Faltas" && FALTA_CODES.has(day.statusCode)) return "PEND.";
  if (label === "Vacaciones" && VACACIONES_CODES.has(day.statusCode)) return "PEND.";
  if (label === "Licencia" && LICENCIA_CODES.has(day.statusCode)) return "PEND.";
  if (label === "Atrasos" && (day.lateDetectedMinutes > 0 || day.lateMinutes > 0 || day.lateDecisionPending)) return "PEND.";
  if (
    label === "Salida anticipada" &&
    (day.earlyDepartureDetectedMinutes > 0 || day.earlyDepartureMinutes > 0 || day.earlyDepartureDecisionPending)
  ) return "PEND.";
  if (
    label === "HH 50%" &&
    (day.overtime50CandidateMinutes > 0 || day.overtime50Minutes > 0 || day.overtime50DecisionPending)
  ) return "PEND.";
  if (
    label === "HH 100%" &&
    (day.overtime100CandidateMinutes > 0 || day.overtime100Minutes > 0 || day.overtime100DecisionPending)
  ) return "PEND.";
  if (label === "Bono HE" && day.bonusAmount > 0) return "PEND.";
  return null;
}

/**
 * Si existe asignación para la fecha, manda la jornada real. Si falta la
 * asignación, se usa lunes-viernes solo para hacer visible el hueco como dato
 * pendiente; nunca se interpreta como una jornada confirmada.
 */
function scheduledWorkDate(
  worker: AttendanceExportWorker,
  date: string,
  holidays: ReadonlySet<string>
): boolean {
  if (beforeHire(worker, date) || holidays.has(date)) return false;
  if (worker.scheduleCoveredDates.has(date)) return worker.scheduledDates.has(date);
  return !isWeekend(date);
}

/** Una fecha puede ser parte de la jornada pagada y, a la vez, no exigir marcación. */
function expectedWorkDate(
  worker: AttendanceExportWorker,
  date: string,
  holidays: ReadonlySet<string>
): boolean {
  return !worker.exemptDates.has(date) && scheduledWorkDate(worker, date, holidays);
}

function payrollBaseDays(worker: AttendanceExportWorker, data: AttendanceExportData): number | null {
  if (!worker.currentlyActive) return null;
  if (data.period.type === "PAGO") {
    // El libro real usa una base mensual de 30 días. Para un ingreso dentro
    // del ciclo, solo se consideran los días calendario desde el alta.
    if (worker.hireDate !== null && worker.hireDate > data.period.startDate) {
      return Math.min(30, calendarDaysBetween(worker.hireDate, data.period.endDate).length);
    }
    return 30;
  }
  return data.days.filter((date) => scheduledWorkDate(worker, date, data.holidays)).length;
}

interface WorkerExportSummary {
  baseDays: number | null;
  payableDays: number | null;
  absences: number;
  vacations: number;
  licenses: number;
  permissions: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtime50Minutes: number;
  overtime100Minutes: number;
  deductionMinutes: number;
  bonusDays: number;
  bonusAmount: number;
  bonusDates: string[];
  reviewDates: string[];
  status: "SIN PENDIENTES" | "REVISAR";
  observations: string;
}

function summarizeWorker(worker: AttendanceExportWorker, data: AttendanceExportData): WorkerExportSummary {
  let absences = 0;
  let vacations = 0;
  let licenses = 0;
  let permissions = 0;
  let lateMinutes = 0;
  let earlyDepartureMinutes = 0;
  let overtime50Minutes = 0;
  let overtime100Minutes = 0;
  let bonusAmount = 0;
  let missingStatuses = 0;
  let pendingLate = 0;
  let pendingEarlyDeparture = 0;
  let pendingOvertime = 0;
  let pendingMissingPunch = 0;
  let pendingAbsenceDays = 0;
  let pendingStatusPolicyDays = 0;
  let missingScheduleDays = 0;
  let preHireFactDays = 0;
  const reviewDates = new Set<string>();
  const bonusDates = new Set<string>();

  for (const date of data.days) {
    const day = worker.days.get(date) ?? emptyDay();
    if (beforeHire(worker, date)) {
      if (dayHasAttendanceFact(day)) {
        preHireFactDays += 1;
        reviewDates.add(date);
      }
      // Ningún hecho anterior al alta puede pagar, descontar ni otorgar bono.
      continue;
    }
    // Una ausencia todavía disputada o a la espera de respaldo se informa,
    // pero no modifica días pagables hasta que el workflow quede definitivo.
    if (!day.absenceDecisionPending) {
      if (FALTA_CODES.has(day.statusCode)) absences += 1;
      if (VACACIONES_CODES.has(day.statusCode)) vacations += 1;
      if (LICENCIA_CODES.has(day.statusCode)) licenses += 1;
      if (PERMISSION_CODES.has(day.statusCode)) permissions += 1;
    }
    lateMinutes += day.lateMinutes;
    earlyDepartureMinutes += day.earlyDepartureMinutes;
    overtime50Minutes += day.overtime50Minutes;
    overtime100Minutes += day.overtime100Minutes;
    bonusAmount += day.bonusAmount;
    if (day.bonusAmount > 0) bonusDates.add(date);
    if (statusRequiresPayrollReview(day.statusCode)) {
      pendingStatusPolicyDays += 1;
      reviewDates.add(date);
    }

    if (
      expectedWorkDate(worker, date, data.holidays) &&
      worker.scheduleCoveredDates.has(date) &&
      day.statusCode === MISSING_STATUS_CODE &&
      !day.missingPunchPending
    ) {
      missingStatuses += 1;
      reviewDates.add(date);
    }
    if (
      !beforeHire(worker, date) &&
      !data.holidays.has(date) &&
      !isWeekend(date) &&
      !worker.exemptDates.has(date) &&
      !worker.scheduleCoveredDates.has(date)
    ) {
      missingScheduleDays += 1;
      reviewDates.add(date);
    }
    if (day.lateDecisionPending) {
      pendingLate += 1;
      reviewDates.add(date);
    }
    if (day.earlyDepartureDecisionPending) {
      pendingEarlyDeparture += 1;
      reviewDates.add(date);
    }
    if (day.overtime50DecisionPending || day.overtime100DecisionPending) {
      pendingOvertime += 1;
      reviewDates.add(date);
    }
    if (day.missingPunchPending) {
      pendingMissingPunch += 1;
      reviewDates.add(date);
    }
    if (day.absenceDecisionPending) {
      pendingAbsenceDays += 1;
      reviewDates.add(date);
    }
  }

  const informationNotes: string[] = [];
  const reviewNotes: string[] = [];
  if (worker.exemptDates.size > 0) informationNotes.push("Exento de marcación durante el período indicado");
  if (!worker.currentlyActive) reviewNotes.push("Persona inactiva: revisar fecha de salida");
  if (missingScheduleDays > 0) reviewNotes.push(`Sin horario vigente: ${missingScheduleDays} día(s)`);
  if (missingStatuses > 0) reviewNotes.push(`Marcación/estado pendiente: ${missingStatuses} día(s)`);
  if (pendingMissingPunch > 0) reviewNotes.push(`Marcaciones incompletas por resolver: ${pendingMissingPunch}`);
  if (pendingAbsenceDays > 0) reviewNotes.push(`Ausencias/licencias por resolver: ${pendingAbsenceDays} día(s)`);
  if (pendingStatusPolicyDays > 0) reviewNotes.push(`Códigos sin efecto de nómina definido: ${pendingStatusPolicyDays} día(s)`);
  if (preHireFactDays > 0) reviewNotes.push(`Hechos anteriores al ingreso: ${preHireFactDays} día(s)`);
  if (pendingLate > 0) reviewNotes.push(`Atrasos por decidir: ${pendingLate}`);
  if (pendingEarlyDeparture > 0) reviewNotes.push(`Salidas anticipadas por decidir: ${pendingEarlyDeparture}`);
  if (pendingOvertime > 0) reviewNotes.push(`Horas extra por decidir: ${pendingOvertime}`);

  const baseDays = payrollBaseDays(worker, data);
  return {
    baseDays,
    payableDays: baseDays === null ? null : Math.max(0, baseDays - absences - licenses),
    absences,
    vacations,
    licenses,
    permissions,
    lateMinutes,
    earlyDepartureMinutes,
    overtime50Minutes,
    overtime100Minutes,
    deductionMinutes: lateMinutes + earlyDepartureMinutes,
    bonusDays: bonusDates.size,
    bonusAmount,
    bonusDates: [...bonusDates].sort(),
    reviewDates: [...reviewDates].sort(),
    status: reviewNotes.length === 0 ? "SIN PENDIENTES" : "REVISAR",
    observations: [...informationNotes, ...reviewNotes].join(" · "),
  };
}

function exportStatusLabel(data: AttendanceExportData, summaries: WorkerExportSummary[]): string {
  const pendingWorkers = summaries.filter((summary) => summary.status === "REVISAR").length;
  const engineProblemDates = ruleEngineProblemDatesAffectingPayroll(data);
  const engineNote = engineProblemDates.length > 0
    ? `; procesamiento incompleto en ${engineProblemDates.length} fecha(s)`
    : "";
  if (data.period.type === "PAGO" && data.reportingPeriodStatus !== "CLOSED") {
    return `BORRADOR — el período 16-15 no está cerrado${engineNote}${pendingWorkers > 0 ? ` y ${pendingWorkers} persona(s) requieren revisión` : ""}`;
  }
  if (engineProblemDates.length > 0) {
    return `REVISAR — procesamiento incompleto en ${engineProblemDates.length} fecha(s)${pendingWorkers > 0 ? ` y ${pendingWorkers} persona(s) con pendientes propios` : ""}`;
  }
  if (pendingWorkers > 0) return `REVISAR — ${pendingWorkers} persona(s) tienen datos pendientes`;
  return data.period.type === "PAGO"
    ? "CONTROL — período cerrado, sin pendientes detectados"
    : "VISTA DE CONTROL — sin pendientes detectados";
}

function scheduleText(worker: AttendanceExportWorker, data: AttendanceExportData): string {
  const payableWorkDates = data.days.filter((date) => scheduledWorkDate(worker, date, data.holidays));
  if (payableWorkDates.length > 0 && payableWorkDates.every((date) => worker.exemptDates.has(date))) {
    return "Exento de marcación";
  }
  return worker.scheduleLabel ?? "Sin horario asignado";
}

function shortReviewDates(dates: string[]): string {
  if (dates.length === 0) return "";
  // El período 16-15 cruza dos meses: mostrar solo "20, 12" obliga a RR. HH.
  // a adivinar cuál corresponde a julio y cuál a agosto.
  const visible = dates.slice(0, 6).map((date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`).join(", ");
  return dates.length > 6 ? `${visible} (+${dates.length - 6})` : visible;
}

interface PendingExportRow {
  scope: "GLOBAL" | "PERSONA";
  employeeCode: string;
  employeeRut: string;
  workerName: string;
  area: string;
  date: string;
  issue: string;
  quantity: number | null;
  unit: string;
  action: string;
}

function ruleEngineProblemDatesAffectingPayroll(data: AttendanceExportData): string[] {
  return [...data.ruleEngineProblemDates]
    .filter((date) => data.workers.some(
      (worker) => expectedWorkDate(worker, date, data.holidays) || worker.days.has(date)
    ))
    .sort();
}

function buildPendingExportRows(data: AttendanceExportData): PendingExportRow[] {
  const rows: PendingExportRow[] = [];
  const global = (date: string, issue: string, action: string): void => {
    rows.push({
      scope: "GLOBAL",
      employeeCode: "",
      employeeRut: "",
      workerName: "",
      area: "",
      date,
      issue,
      quantity: null,
      unit: "",
      action,
    });
  };

  if (data.period.type === "PAGO" && data.reportingPeriodStatus !== "CLOSED") {
    global("", "Período de pago abierto", "Cerrar el período cuando los demás pendientes estén resueltos.");
  }

  for (const date of ruleEngineProblemDatesAffectingPayroll(data)) {
    global(date, "Procesamiento de asistencia incompleto", "Volver a procesar la fecha en Motor de reglas.");
  }

  const addPerson = (
    worker: AttendanceExportWorker,
    date: string,
    issue: string,
    quantity: number | null,
    unit: string,
    action: string
  ): void => {
    rows.push({
      scope: "PERSONA",
      employeeCode: worker.employeeCode,
      employeeRut: worker.employeeRut ?? "",
      workerName: worker.workerName,
      area: AREA_LABEL[worker.area],
      date,
      issue,
      quantity,
      unit,
      action,
    });
  };

  for (const worker of data.workers) {
    if (!worker.currentlyActive) {
      addPerson(worker, "", "Persona inactiva en el padrón actual", null, "", "Confirmar fecha de salida antes de liquidar.");
    }

    for (const date of data.days) {
      const day = worker.days.get(date) ?? emptyDay();
      if (beforeHire(worker, date)) {
        if (dayHasAttendanceFact(day)) {
          addPerson(
            worker,
            date,
            "Hecho de asistencia anterior al ingreso",
            null,
            "",
            "Corregir la fecha de ingreso o el registro antes de liquidar."
          );
        }
        continue;
      }
      const missingSchedule =
        !data.holidays.has(date) &&
        !isWeekend(date) &&
        !worker.exemptDates.has(date) &&
        !worker.scheduleCoveredDates.has(date);

      if (missingSchedule) {
        addPerson(worker, date, "Sin horario vigente", null, "", "Asignar horario y volver a procesar la fecha.");
      } else if (
        expectedWorkDate(worker, date, data.holidays) &&
        day.statusCode === MISSING_STATUS_CODE &&
        !day.missingPunchPending
      ) {
        addPerson(worker, date, "Estado de asistencia sin resolver", null, "", "Revisar la jornada y volver a procesarla.");
      }

      if (day.missingPunchPending) {
        addPerson(worker, date, "Marcación incompleta", null, "", "Corregir o confirmar la entrada/salida en Pendientes.");
      }
      if (day.absenceDecisionPending) {
        addPerson(worker, date, "Ausencia o licencia pendiente", null, "", "Resolver la ausencia y adjuntar respaldo si corresponde.");
      }
      if (statusRequiresPayrollReview(day.statusCode)) {
        addPerson(
          worker,
          date,
          `Código diario ${day.statusCode} sin efecto de nómina definido`,
          null,
          "",
          "Definir su efecto remuneracional y volver a generar el archivo."
        );
      }
      if (day.lateDecisionPending) {
        addPerson(worker, date, "Atraso por resolver", day.lateDetectedMinutes, "min", "Justificar o confirmar el descuento.");
      }
      if (day.earlyDepartureDecisionPending) {
        addPerson(
          worker,
          date,
          "Salida anticipada por resolver",
          day.earlyDepartureDetectedMinutes,
          "min",
          "Justificar o confirmar el descuento."
        );
      }
      if (day.overtime50DecisionPending) {
        addPerson(worker, date, "HH 50% sin decisión", day.overtime50CandidateMinutes, "min", "Aprobar o rechazar las horas extra.");
      }
      if (day.overtime100DecisionPending) {
        addPerson(worker, date, "HH 100% sin decisión", day.overtime100CandidateMinutes, "min", "Aprobar o rechazar las horas extra.");
      }
    }
  }

  return rows.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === "GLOBAL" ? -1 : 1;
    return (
      left.date.localeCompare(right.date) ||
      left.workerName.localeCompare(right.workerName, "es") ||
      left.issue.localeCompare(right.issue, "es")
    );
  });
}

type Cell = string | number | Date | null;

/** Fecha calendario como serial de Excel, sin componente horaria ni conversión de zona. */
function calendarDateToExcelSerial(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000 + 25_569;
}

export function buildAttendanceExportWorkbook(data: AttendanceExportData): Uint8Array {
  const { days, workers, period, holidays } = data;
  const summaries = workers.map((worker) => summarizeWorker(worker, data));
  const overallStatus = exportStatusLabel(data, summaries);

  // -----------------------------------------------------------------------
  // Hoja 1: valores que RR. HH. necesita para liquidar remuneraciones.

  const SUMMARY_COLUMNS = 22;

  const summaryRows: Cell[][] = [
    ["NÓMINA DE ASISTENCIA PARA REMUNERACIONES"],
    [`Período: ${period.label}`],
    [overallStatus],
    [
      "Días a pagar descuenta faltas y licencias. Atrasos, salidas y HH 50%/100% incluyen solo decisiones definitivas. Bono HE lee el monto automático de la política vigente. No edites este libro para corregir: resuelve en GESTORA y vuelve a generarlo. El archivo refleja los datos actuales y todavía no es una copia inmutable del cierre.",
    ],
    [
      "Código Workera",
      "RUT",
      "Trabajador",
      "Área",
      "Días base",
      "Faltas",
      "Licencias",
      "Días a pagar",
      "Vacaciones",
      "Permisos / justificadas",
      "Atrasos a descontar",
      "Salidas a descontar",
      "Total tiempo a descontar",
      "HH 50% aprobadas",
      "HH 100% aprobadas",
      "Días con bono HE",
      "Bono HE (CLP)",
      "Fechas con bono",
      "Estado",
      "Días por revisar",
      "Observaciones",
      "Horario",
    ],
  ];

  for (let index = 0; index < workers.length; index += 1) {
    const worker = workers[index];
    const summary = summaries[index];
    summaryRows.push([
      worker.employeeCode,
      worker.employeeRut,
      worker.workerName,
      AREA_LABEL[worker.area],
      summary.baseDays,
      summary.absences,
      summary.licenses,
      summary.payableDays,
      summary.vacations,
      summary.permissions,
      minutesToExcelDuration(summary.lateMinutes),
      minutesToExcelDuration(summary.earlyDepartureMinutes),
      minutesToExcelDuration(summary.deductionMinutes),
      minutesToExcelDuration(summary.overtime50Minutes),
      minutesToExcelDuration(summary.overtime100Minutes),
      summary.bonusDays,
      summary.bonusAmount,
      shortReviewDates(summary.bonusDates),
      summary.status === "REVISAR" ? "Revisar" : "Sin pendientes",
      shortReviewDates(summary.reviewDates),
      summary.observations,
      scheduleText(worker, data),
    ]);
  }

  const total = summaries.reduce(
    (acc, summary) => ({
      baseDays: acc.baseDays + (summary.baseDays ?? 0),
      absences: acc.absences + summary.absences,
      licenses: acc.licenses + summary.licenses,
      payableDays: acc.payableDays + (summary.payableDays ?? 0),
      vacations: acc.vacations + summary.vacations,
      permissions: acc.permissions + summary.permissions,
      lateMinutes: acc.lateMinutes + summary.lateMinutes,
      earlyDepartureMinutes: acc.earlyDepartureMinutes + summary.earlyDepartureMinutes,
      deductionMinutes: acc.deductionMinutes + summary.deductionMinutes,
      overtime50Minutes: acc.overtime50Minutes + summary.overtime50Minutes,
      overtime100Minutes: acc.overtime100Minutes + summary.overtime100Minutes,
      bonusDays: acc.bonusDays + summary.bonusDays,
      bonusAmount: acc.bonusAmount + summary.bonusAmount,
    }),
    {
      baseDays: 0,
      absences: 0,
      licenses: 0,
      payableDays: 0,
      vacations: 0,
      permissions: 0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      deductionMinutes: 0,
      overtime50Minutes: 0,
      overtime100Minutes: 0,
      bonusDays: 0,
      bonusAmount: 0,
    }
  );
  summaryRows.push([
    null,
    null,
    "TOTAL EMPRESA",
    null,
    total.baseDays,
    total.absences,
    total.licenses,
    total.payableDays,
    total.vacations,
    total.permissions,
    minutesToExcelDuration(total.lateMinutes),
    minutesToExcelDuration(total.earlyDepartureMinutes),
    minutesToExcelDuration(total.deductionMinutes),
    minutesToExcelDuration(total.overtime50Minutes),
    minutesToExcelDuration(total.overtime100Minutes),
    total.bonusDays,
    total.bonusAmount,
    null,
    null,
    null,
    null,
    null,
  ]);

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  applyWhiteCanvas(summarySheet, summaryRows.length, SUMMARY_COLUMNS);
  const summaryDataLastRow = 5 + workers.length;
  const summaryTotalRow = summaryRows.length - 1;
  summarySheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: SUMMARY_COLUMNS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: SUMMARY_COLUMNS - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: SUMMARY_COLUMNS - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: SUMMARY_COLUMNS - 1 } },
  ];
  summarySheet["!cols"] = [
    { wch: 16 },
    { wch: 15 },
    { wch: 29 },
    { wch: 16 },
    { wch: 10 },
    { wch: 9 },
    { wch: 10 },
    { wch: 12 },
    { wch: 11 },
    { wch: 18 },
    { wch: 18 },
    { wch: 19 },
    { wch: 21 },
    { wch: 18 },
    { wch: 19 },
    { wch: 16 },
    { wch: 16 },
    { wch: 18 },
    { wch: 16 },
    { wch: 18 },
    { wch: 46 },
    { wch: 34 },
  ];
  summarySheet["!rows"] = [{ hpt: 24 }, { hpt: 20 }, { hpt: 22 }, { hpt: 38 }, { hpt: 34 }];
  summarySheet["!autofilter"] = { ref: `A5:V${Math.max(5, summaryDataLastRow)}` };
  summarySheet["!freeze"] = { xSplit: 3, ySplit: 5 };

  const summaryTitle = summarySheet.A1;
  if (summaryTitle) {
    summaryTitle.s = {
      ...solidFill("FFFFFF"),
      font: { bold: true, sz: 15, color: { rgb: "1F1F1F" } },
      alignment: { vertical: "center" },
    };
  }
  for (const ref of ["A2", "A4"]) {
    const cell = summarySheet[ref];
    if (cell) {
      cell.s = {
        ...solidFill("FFFFFF"),
        font: { color: { rgb: "595959" }, italic: ref === "A4" },
        alignment: { wrapText: true, vertical: "center" },
      };
    }
  }
  const statusCell = summarySheet.A3;
  if (statusCell) {
    statusCell.s = {
      ...solidFill(overallStatus.startsWith("BORRADOR") || overallStatus.startsWith("REVISAR") ? "FFF2CC" : "E2F0D9"),
      font: { bold: true, color: { rgb: "1F1F1F" } },
      alignment: { vertical: "center" },
    };
  }
  for (let column = 0; column < SUMMARY_COLUMNS; column += 1) {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: 4, c: column })];
    if (cell) cell.s = HEADER_STYLE;
  }
  for (let row = 5; row < summaryTotalRow; row += 1) {
    const summary = summaries[row - 5];
    const fill = row % 2 === 0 ? "F7F9FC" : "FFFFFF";
    for (let column = 0; column < SUMMARY_COLUMNS; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = summarySheet[ref] ?? (summarySheet[ref] = { v: "", t: "s" });
      cell.s = {
        ...solidFill(fill),
        alignment: {
          vertical: "center",
          horizontal: column >= 4 && column <= 19 ? "center" : "left",
          wrapText: column === 20 || column === 21,
        },
        border: THIN_BOTTOM_BORDER,
      };
    }
    for (const column of [10, 11, 12, 13, 14]) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.z = DURATION_TOTAL_FORMAT;
    }
    for (const column of [4, 5, 6, 7, 8, 9]) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && typeof cell.v === "number") cell.z = COUNT_FORMAT;
    }
    const bonusDaysCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 15 })];
    if (bonusDaysCell && typeof bonusDaysCell.v === "number") bonusDaysCell.z = "#,##0";
    const excelRow = row + 1;
    const payableCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 7 })];
    if (payableCell && summary.payableDays !== null) payableCell.f = `MAX(0,E${excelRow}-F${excelRow}-G${excelRow})`;
    const deductionCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 12 })];
    if (deductionCell) deductionCell.f = `K${excelRow}+L${excelRow}`;
    const bonusCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 16 })];
    if (bonusCell) bonusCell.z = MONEY_FORMAT;
    const state = summarySheet[XLSX.utils.encode_cell({ r: row, c: 18 })];
    if (state) {
      state.s = {
        ...solidFill(summary.status === "REVISAR" ? "FFF2CC" : "E2F0D9"),
        font: { bold: true, color: { rgb: summary.status === "REVISAR" ? "9C5700" : "375623" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: THIN_BOTTOM_BORDER,
      };
    }
  }

  if (workers.length > 0) {
    const firstExcelRow = 6;
    const lastExcelRow = 5 + workers.length;
    for (const column of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      const totalCell = summarySheet[XLSX.utils.encode_cell({ r: summaryTotalRow, c: column })];
      if (!totalCell) continue;
      const letter = XLSX.utils.encode_col(column);
      totalCell.f = `SUM(${letter}${firstExcelRow}:${letter}${lastExcelRow})`;
    }
  }
  for (let column = 0; column < SUMMARY_COLUMNS; column += 1) {
    const ref = XLSX.utils.encode_cell({ r: summaryTotalRow, c: column });
    const cell = summarySheet[ref] ?? (summarySheet[ref] = { v: "", t: "s" });
    cell.s = {
      ...solidFill("D9EAF7"),
      font: { bold: true, color: { rgb: "1F1F1F" } },
      alignment: { horizontal: column >= 4 && column <= 19 ? "center" : "left", vertical: "center" },
      border: THIN_BOTTOM_BORDER,
    };
  }
  for (const column of [4, 5, 6, 7, 8, 9]) {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: summaryTotalRow, c: column })];
    if (cell) cell.z = COUNT_FORMAT;
  }
  for (const column of [10, 11, 12, 13, 14]) {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: summaryTotalRow, c: column })];
    if (cell) cell.z = DURATION_TOTAL_FORMAT;
  }
  const totalBonusDaysCell = summarySheet[XLSX.utils.encode_cell({ r: summaryTotalRow, c: 15 })];
  if (totalBonusDaysCell) totalBonusDaysCell.z = "#,##0";
  const totalBonusCell = summarySheet[XLSX.utils.encode_cell({ r: summaryTotalRow, c: 16 })];
  if (totalBonusCell) totalBonusCell.z = MONEY_FORMAT;

  // -----------------------------------------------------------------------
  // Hoja 2: lista corta de lo que debe resolverse antes de pagar.

  const pendingItems = buildPendingExportRows(data);
  const pendingRows: Cell[][] = [
    ["PENDIENTES ANTES DE LIQUIDAR"],
    [`Período: ${period.label}`],
    [
      pendingItems.length > 0
        ? `${pendingItems.length} pendiente(s). Filtra por fecha, persona o incidencia y resuélvelos en GESTORA antes de usar la nómina.`
        : "No hay pendientes operativos detectados.",
    ],
    ["Alcance", "Código Workera", "RUT", "Trabajador", "Área", "Fecha", "Incidencia", "Cantidad", "Unidad", "Acción requerida"],
  ];
  if (pendingItems.length === 0) {
    pendingRows.push([null, null, null, null, null, null, "No hay pendientes operativos detectados.", null, null, null]);
  } else {
    for (const item of pendingItems) {
      pendingRows.push([
        item.scope === "GLOBAL" ? "Global" : "Persona",
        item.employeeCode,
        item.employeeRut,
        item.workerName,
        item.area,
        item.date ? calendarDateToExcelSerial(item.date) : null,
        item.issue,
        item.quantity,
        item.unit,
        item.action,
      ]);
    }
  }

  const pendingSheet = XLSX.utils.aoa_to_sheet(pendingRows, { cellDates: true });
  applyWhiteCanvas(pendingSheet, pendingRows.length, 10);
  pendingSheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } },
  ];
  pendingSheet["!cols"] = [
    { wch: 11 },
    { wch: 16 },
    { wch: 15 },
    { wch: 28 },
    { wch: 16 },
    { wch: 13 },
    { wch: 34 },
    { wch: 12 },
    { wch: 10 },
    { wch: 48 },
  ];
  pendingSheet["!rows"] = [{ hpt: 24 }, { hpt: 20 }, { hpt: 28 }, { hpt: 30 }];
  pendingSheet["!freeze"] = { xSplit: 4, ySplit: 4 };
  if (pendingItems.length > 0) pendingSheet["!autofilter"] = { ref: `A4:J${4 + pendingItems.length}` };
  const pendingTitle = pendingSheet.A1;
  if (pendingTitle) {
    pendingTitle.s = { ...solidFill("FFFFFF"), font: { bold: true, sz: 15, color: { rgb: "1F1F1F" } } };
  }
  for (const ref of ["A2", "A3"]) {
    const cell = pendingSheet[ref];
    if (cell) {
      cell.s = {
        ...solidFill(ref === "A3" && pendingItems.length > 0 ? "FFF2CC" : "FFFFFF"),
        font: { color: { rgb: "595959" }, italic: ref === "A3" },
        alignment: { wrapText: true, vertical: "center" },
      };
    }
  }
  for (let column = 0; column < 10; column += 1) {
    const cell = pendingSheet[XLSX.utils.encode_cell({ r: 3, c: column })];
    if (cell) cell.s = HEADER_STYLE;
  }
  for (let row = 4; row < pendingRows.length; row += 1) {
    const isGlobal = pendingRows[row][0] === "Global";
    for (let column = 0; column < 10; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = pendingSheet[ref] ?? (pendingSheet[ref] = { v: "", t: "s" });
      cell.s = {
        ...solidFill(isGlobal ? "FFF2CC" : row % 2 === 0 ? "F7F9FC" : "FFFFFF"),
        alignment: { vertical: "center", horizontal: column === 7 ? "right" : "left", wrapText: column === 6 || column === 9 },
        border: THIN_BOTTOM_BORDER,
      };
    }
    const dateCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 5 })];
    if (dateCell && typeof dateCell.v === "number") dateCell.z = "dd/mm/yyyy";
    const quantityCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 7 })];
    if (quantityCell && typeof quantityCell.v === "number") quantityCell.z = "#,##0";
  }

  // -----------------------------------------------------------------------
  // Hoja 3: matriz diaria familiar para RR. HH.

  const rows: Cell[][] = [];

  rows.push(["PLANILLA DE ASISTENCIA DEL PERSONAL", null, `${period.label} · ${overallStatus}`]);
  for (const [code, meaning] of LEGEND) rows.push([code, meaning]);

  // Fila de meses: la etiqueta se escribe solo donde cambia el mes, igual que
  // en la planilla original.
  const monthRow: Cell[] = [null, null, null];
  const dayRow: Cell[] = [null, null, null];
  let lastMonth = "";
  for (const date of days) {
    const [, m, d] = date.split("-");
    const label = MONTH_SHORT[Number(m) - 1];
    monthRow.push(label !== lastMonth ? label : null);
    lastMonth = label;
    dayRow.push(Number(d));
  }
  rows.push(monthRow);
  rows.push(dayRow);

  const merges: XLSX.Range[] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 0, c: FIRST_DAY_COL + days.length - 1 } },
  ];

  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const worker = workers[workerIndex];
    const summary = summaries[workerIndex];
    const blockStart = rows.length;

    for (const label of BLOCK_ROWS) {
      // La planilla de RRHH pone el horario bajo el nombre, en la misma celda
      // combinada. Sin eso no se puede saber, mirando la fila, si un día en
      // blanco es una marcación que falta o un día que esa persona no trabaja.
      const workerDetails = [
        worker.employeeRut ?? worker.employeeCode,
        AREA_LABEL[worker.area],
        scheduleText(worker, data),
      ].filter((part) => part.length > 0).join(" · ");
      const nameCell = `${worker.workerName}\n${workerDetails}`;
      const line: Cell[] = [label === "Asistencia" ? nameCell : null, label, null];
      let total = 0;

      for (const date of days) {
        const day = worker.days.get(date) ?? emptyDay();
        let value: Cell = null;

        if (beforeHire(worker, date)) {
          // Se muestra como inconsistencia, pero al ser texto `PEND.` nunca
          // entra en SUM ni en los totales de remuneraciones.
          value = preHireMatrixValue(label, day);
        } else if (label === "Asistencia") {
          // Un fin de semana, feriado, día libre o fecha anterior al ingreso
          // queda en blanco SOLO si no existe un hecho. Si sí hubo trabajo,
          // licencia u otra novedad, se conserva el código.
          value = day.statusCode !== MISSING_STATUS_CODE
            ? day.statusCode
            : expectedWorkDate(worker, date, holidays)
              ? MISSING_STATUS_CODE
              : null;
        } else if (label === "Faltas") {
          if (day.absenceDecisionPending && FALTA_CODES.has(day.statusCode)) value = "PEND.";
          else if (FALTA_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Vacaciones") {
          if (day.absenceDecisionPending && VACACIONES_CODES.has(day.statusCode)) value = "PEND.";
          else if (VACACIONES_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Licencia") {
          if (day.absenceDecisionPending && LICENCIA_CODES.has(day.statusCode)) value = "PEND.";
          else if (LICENCIA_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Atrasos") {
          if (day.lateDecisionPending && day.lateDetectedMinutes > 0) value = "PEND.";
          else if (day.lateMinutes > 0) { value = minutesToExcelDuration(day.lateMinutes); total += day.lateMinutes; }
        } else if (label === "Salida anticipada") {
          if (day.earlyDepartureDecisionPending && day.earlyDepartureDetectedMinutes > 0) value = "PEND.";
          else if (day.earlyDepartureMinutes > 0) {
            value = minutesToExcelDuration(day.earlyDepartureMinutes);
            total += day.earlyDepartureMinutes;
          }
        } else if (label === "HH 50%") {
          if (day.overtime50DecisionPending && day.overtime50CandidateMinutes > 0) value = "PEND.";
          else if (day.overtime50Minutes > 0) { value = minutesToExcelDuration(day.overtime50Minutes); total += day.overtime50Minutes; }
        } else if (label === "HH 100%") {
          if (day.overtime100DecisionPending && day.overtime100CandidateMinutes > 0) value = "PEND.";
          else if (day.overtime100Minutes > 0) { value = minutesToExcelDuration(day.overtime100Minutes); total += day.overtime100Minutes; }
        } else if (label === "Bono HE") {
          if (day.bonusAmount > 0) { value = day.bonusAmount; total += day.bonusAmount; }
        }

        line.push(value);
      }

      // Asistencia: base del período menos faltas y licencia. Vacaciones se
      // informan aparte, tal como lo hace la fórmula vigente de RR. HH.
      if (label === "Asistencia") {
        line[2] = summary.baseDays === null ? null : Math.max(0, summary.baseDays - summary.absences - summary.licenses);
      } else if (label === "VIATICOS") {
        // Cero sería un dato inventado. La fila se mantiene porque RR. HH. la
        // reconoce, pero queda vacía hasta integrar una fuente autorizada.
        line[2] = null;
      } else {
        line[2] = DURATION_ROWS.has(label) ? minutesToExcelDuration(total) : total;
      }

      rows.push(line);
    }

    // Nombre combinado sobre todo el bloque, como en la planilla original.
    merges.push({ s: { r: blockStart, c: 0 }, e: { r: blockStart + BLOCK_ROWS.length - 1, c: 0 } });
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  applyWhiteCanvas(sheet, rows.length, FIRST_DAY_COL + days.length);

  // La planilla original deja las celdas sin dato en verde y resalta en
  // naranja cualquier marcación/valor que sí deba revisar RRHH. Viáticos usa
  // el amarillo de su encabezado de sección.
  // A12 es la última fila de la leyenda ("?"). Se resuelve por su posición
  // real para que agregar o quitar un código no rompa la exportación.
  const unknownLegendCell = sheet[XLSX.utils.encode_cell({ r: LEGEND.length, c: 0 })];
  if (unknownLegendCell) unknownLegendCell.s = UNKNOWN_LEGEND_STYLE;
  for (let c = FIRST_DAY_COL; c < FIRST_DAY_COL + days.length; c += 1) {
    const monthRef = XLSX.utils.encode_cell({ r: 12, c });
    const dayRef = XLSX.utils.encode_cell({ r: 13, c });
    if (sheet[monthRef]) sheet[monthRef].s = HEADER_STYLE;
    if (sheet[dayRef]) sheet[dayRef].s = HEADER_STYLE;
  }

  const titleCell = sheet.A1;
  if (titleCell) {
    titleCell.s = {
      ...solidFill("FFFFFF"),
      font: { bold: true, sz: 13, color: { rgb: "1F1F1F" } },
    };
  }
  const periodCell = sheet.C1;
  if (periodCell) {
    periodCell.s = {
      ...solidFill(overallStatus.startsWith("BORRADOR") || overallStatus.startsWith("REVISAR") ? "FFF2CC" : "E2F0D9"),
      font: { bold: true },
      alignment: { wrapText: true },
    };
  }

  // Fórmulas auditables en la columna de totales, siguiendo el patrón del
  // mockup: asistencia = días base - faltas - licencia; el resto suma su
  // fila diaria. Se conserva también el valor calculado para que Excel y
  // lectores que no recalculan fórmulas muestren el total inmediatamente.
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const blockStart = HEADER_ROWS + workerIndex * BLOCK_ROWS.length;
    const assistanceTotal = XLSX.utils.encode_cell({ r: blockStart, c: 2 });
    const absencesTotal = XLSX.utils.encode_cell({ r: blockStart + 1, c: 2 });
    const licenseTotal = XLSX.utils.encode_cell({ r: blockStart + 3, c: 2 });
    const assistanceCell = sheet[assistanceTotal];
    const baseDays = summaries[workerIndex].baseDays;
    if (assistanceCell && baseDays !== null) assistanceCell.f = `MAX(0,${baseDays}-${absencesTotal}-${licenseTotal})`;
    for (let offset = 1; offset < BLOCK_ROWS.length; offset += 1) {
      const totalCell = sheet[XLSX.utils.encode_cell({ r: blockStart + offset, c: 2 })];
      if (totalCell && BLOCK_ROWS[offset] !== "VIATICOS") {
        totalCell.f = `SUM(${XLSX.utils.encode_cell({ r: blockStart + offset, c: FIRST_DAY_COL })}:${XLSX.utils.encode_cell({ r: blockStart + offset, c: FIRST_DAY_COL + days.length - 1 })})`;
      }
    }

    for (let offset = 0; offset < BLOCK_ROWS.length; offset += 1) {
      const row = blockStart + offset;
      const label = BLOCK_ROWS[offset];
      const labelCell = sheet[XLSX.utils.encode_cell({ r: row, c: 1 })];
      if (labelCell && label === "VIATICOS") labelCell.s = VIATICOS_STYLE;
      if (labelCell && label === "Bono HE") labelCell.s = BONUS_STYLE;
      const worker = workers[workerIndex];

      for (let c = FIRST_DAY_COL; c < FIRST_DAY_COL + days.length; c += 1) {
        const ref = XLSX.utils.encode_cell({ r: row, c });
        const dayDate = days[c - FIRST_DAY_COL];
        const day = worker.days.get(dayDate) ?? emptyDay();
        const preHireValue = beforeHire(worker, dayDate) ? preHireMatrixValue(label, day) : null;
        const pendingForRow =
          preHireValue !== null ||
          (label === "Atrasos" && day.lateDecisionPending) ||
          (label === "Salida anticipada" && day.earlyDepartureDecisionPending) ||
          (label === "HH 50%" && day.overtime50DecisionPending) ||
          (label === "HH 100%" && day.overtime100DecisionPending) ||
          (label === "Asistencia" && day.absenceDecisionPending) ||
          (label === "Faltas" && day.absenceDecisionPending && FALTA_CODES.has(day.statusCode)) ||
          (label === "Vacaciones" && day.absenceDecisionPending && VACACIONES_CODES.has(day.statusCode)) ||
          (label === "Licencia" && day.absenceDecisionPending && LICENCIA_CODES.has(day.statusCode)) ||
          (label === "Asistencia" && day.missingPunchPending) ||
          (label === "Asistencia" && statusRequiresPayrollReview(day.statusCode)) ||
          (label === "Asistencia" && data.ruleEngineProblemDates.has(dayDate) &&
            (expectedWorkDate(worker, dayDate, holidays) || worker.days.has(dayDate))) ||
          (label === "Asistencia" && expectedWorkDate(worker, dayDate, holidays) && day.statusCode === MISSING_STATUS_CODE);

        // Una incidencia pendiente siempre gana visualmente. Los colores de
        // calendario son suaves y documentados; no se reutilizan los siete
        // colores históricos cuyo significado nunca fue confirmado.
        const style = pendingForRow
          ? REVIEW_STYLE
          : beforeHire(worker, dayDate)
            ? BEFORE_HIRE_STYLE
            : worker.exemptDates.has(dayDate)
              ? DAY_OFF_STYLE
              : holidays.has(dayDate)
                ? HOLIDAY_STYLE
                : worker.scheduleCoveredDates.has(dayDate) && !worker.scheduledDates.has(dayDate)
                  ? DAY_OFF_STYLE
                  : !worker.scheduleCoveredDates.has(dayDate) && !isWeekend(dayDate)
                    ? MISSING_SCHEDULE_STYLE
                    : isWeekend(dayDate)
                      ? WEEKEND_STYLE
                      : null;

        // Un día hábil trabajado no lleva relleno. Si además no tiene valor,
        // no se crea la celda: en el libro real esa celda no existe.
        if (style === null) continue;
        const target = sheet[ref] ?? (sheet[ref] = { v: "", t: "s" });
        target.s = style;
      }

      if (labelCell) {
        labelCell.s = {
          ...(label === "VIATICOS" ? VIATICOS_STYLE : label === "Bono HE" ? BONUS_STYLE : solidFill("FFFFFF")),
          font: { bold: label === "Asistencia" },
          alignment: { vertical: "center" },
        };
      }
    }

    const nameCell = sheet[XLSX.utils.encode_cell({ r: blockStart, c: 0 })];
    if (nameCell) {
      nameCell.s = {
        ...solidFill("FFFFFF"),
        font: { bold: true, color: { rgb: "1F1F1F" } },
        alignment: { vertical: "center", wrapText: true },
        border: THIN_BOTTOM_BORDER,
      };
    }
    const lastRow = blockStart + BLOCK_ROWS.length - 1;
    for (let column = 1; column < FIRST_DAY_COL + days.length; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: lastRow, c: column });
      const cell = sheet[ref] ?? (sheet[ref] = { v: "", t: "s" });
      cell.s = { ...(cell.s ?? {}), border: THIN_BOTTOM_BORDER };
    }
  }

  // Formato numérico de cada fila, incluida su celda de total. Las filas de
  // conteo van con dos decimales y las de tiempo como duración, igual que el
  // libro de RRHH: un total que sale "20" donde la planilla dice "20.00" es la
  // diferencia que hace que las dos no se puedan comparar de un vistazo.
  for (let r = HEADER_ROWS; r < rows.length; r += 1) {
    const label = rows[r][1];
    if (typeof label !== "string") continue;
    const format = DURATION_ROWS.has(label)
      ? DURATION_DAY_FORMAT
      : COUNT_ROWS.has(label)
        ? COUNT_FORMAT
        : MONEY_ROWS.has(label)
          ? MONEY_FORMAT
          : null;
    if (!format) continue;
    for (let c = 2; c < FIRST_DAY_COL + days.length; c += 1) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const target = sheet[ref];
      // Las celdas diarias de Asistencia llevan el código de estado, que es
      // texto: aplicarles un formato numérico no cambia nada y sería ruido.
      if (target && typeof target.v === "number") target.z = format;
    }

    if (DURATION_ROWS.has(label)) {
      const total = sheet[XLSX.utils.encode_cell({ r, c: 2 })];
      if (total && typeof total.v === "number") total.z = DURATION_TOTAL_FORMAT;
    }
  }

  // Las filas monetarias se expresan en CLP. Viáticos permanece vacío hasta
  // integrar una fuente autorizada; Bono HE sí viene del motor de políticas.
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    for (const label of MONEY_ROWS) {
      const offset = BLOCK_ROWS.indexOf(label as (typeof BLOCK_ROWS)[number]);
      if (offset < 0) continue;
      const row = HEADER_ROWS + workerIndex * BLOCK_ROWS.length + offset;
      const total = sheet[XLSX.utils.encode_cell({ r: row, c: 2 })];
      if (total) total.z = MONEY_FORMAT;
    }
  }

  sheet["!merges"] = merges;
  // La matriz mantiene la forma conocida, pero deja visibles el nombre, área
  // y horario para que RR. HH. no dependa de abrir cada celda.
  sheet["!cols"] = [
    { wch: 34 },
    { wch: 18 },
    { wch: 10.33 },
    ...days.map(() => ({ wch: 7.33 })),
  ];
  sheet["!freeze"] = { xSplit: 3, ySplit: HEADER_ROWS };
  sheet["!rows"] = [{ hpt: 24 }, ...Array.from({ length: HEADER_ROWS - 1 }, () => ({ hpt: 18 }))];

  // El libro de RRHH nombra cada hoja por su mes, "NOV25". Se deriva del cierre
  // del período, que es el mes al que se imputa la planilla.
  const [endYear, endMonth] = period.endDate.split("-");
  const sheetName = `${MONTH_SHORT[Number(endMonth) - 1]}${endYear.slice(2)}`;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summarySheet, "RESUMEN");
  XLSX.utils.book_append_sheet(workbook, pendingSheet, "PENDIENTES");
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  workbook.Props = {
    Title: `Asistencia ${period.label}`,
    Subject: "Nómina de asistencia, pendientes y respaldo diario para remuneraciones",
    Company: "GESTORA",
  };
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }) as Uint8Array;
}
