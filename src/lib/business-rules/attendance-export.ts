import "server-only";
import * as XLSX from "xlsx-js-style";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../access/scope";
import { applyXlsxPresentation } from "../excel/xlsx-postprocess";
import { canonicalRosterSha256 } from "../employees/arcotex-pilot-roster";
import type { AttendanceExportPeriod } from "./attendance-export-periods";
import { loadHolidaySet } from "./holidays";
import type { AcceptedPayrollWorkbookAdjustment, PayrollAdjustmentField } from "../payroll/payroll-workbook-adjustments";

type PayrollSummaryAdjustmentField = Exclude<PayrollAdjustmentField, "Código asistencia">;

/**
 * Exportador de pre-nómina de asistencia, estándar 2026.
 *
 * Sustituye definitivamente el libro histórico de diez filas por trabajador
 * por tres tablas sin celdas combinadas en su área de datos:
 * `RESUMEN_NOMINA` (una fila por persona), `CONTROL_PENDIENTES` (excepciones
 * accionables) y `MATRIZ_DIARIA_SABANA` (una fila por persona y una columna
 * por fecha). El corte de pago es siempre 16–15.
 *
 * El libro se genera desde datos vivos dentro del padrón autorizado. Nunca
 * inventa un estado: un día exigible sin dato definitivo sale `?`, nunca P/F
 * supuesto. El cierre persiste este mismo archivo como snapshot privado e
 * inmutable; antes de cerrar sigue siendo el artefacto operativo editable.
 */

const MISSING_STATUS_CODE = "?";

/** `R` todavía no tiene un efecto de nómina aprobado; debe fallar cerrado. */
const STATUS_CODES_REQUIRING_PAYROLL_REVIEW = new Set(["R"]);
const OVERTIME_50_CODE = "OVERTIME_50";
const OVERTIME_100_CODE = "OVERTIME_100";

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
  ["?", "TARJETA NO MARCADA O CON PROBLEMAS"],
];
const KNOWN_STATUS_CODES = new Set(LEGEND.map(([code]) => code));

function statusRequiresPayrollReview(code: string): boolean {
  return code !== MISSING_STATUS_CODE &&
    (!KNOWN_STATUS_CODES.has(code) || STATUS_CODES_REQUIRING_PAYROLL_REVIEW.has(code));
}

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
  late_arrival_decisions: {
    payroll_minutes: number;
    payroll_effect: string;
    justified: boolean;
    reason: string | null;
    decided_at: string;
    is_current: boolean;
    decided_by_profile: { display_name: string } | { display_name: string }[] | null;
  }[] | null;
}

interface EarlyDepartureRow {
  employee_id: string;
  work_date: string;
  detected_minutes: number;
  early_departure_decisions:
    | {
        payroll_minutes: number;
        payroll_effect: string;
        reason_category: string;
        reason: string | null;
        decided_at: string;
        is_current: boolean;
        decided_by_profile: { display_name: string } | { display_name: string }[] | null;
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

interface OrganizationAssignmentRow {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
  organization_units:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
}

interface EmployeeGroupAssignmentRow {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  employee_groups:
    | { code: AreaCode; company_id: string }
    | { code: AreaCode; company_id: string }[]
    | null;
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
        rejected_minutes: number;
        decision_status: Database["public"]["Enums"]["overtime_decision_status"];
        reason: string | null;
        decided_at: string;
        decided_by_profile: { display_name: string } | { display_name: string }[] | null;
        is_current: boolean;
        employee_daily_bonuses:
          | { amount: number; currency: string }
          | { amount: number; currency: string }[]
          | null;
      }[]
    | null;
}

interface AttendancePunchRow {
  employee_id: string;
  work_date: string;
  actual_clock_in: string | null;
  actual_clock_out: string | null;
  attendance_corrections:
    | {
        corrected_clock_in: string | null;
        corrected_clock_out: string | null;
        is_current: boolean;
      }[]
    | null;
}

interface ScheduleAssignmentRow {
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  rrhh_confirmed_at: string | null;
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
  /** Minutos entre las marcas efectivas; no descuenta una colación inventada. */
  recordedMinutes: number;
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
  overtimeDecisionAudits?: {
    typeCode: string;
    candidateMinutes: number;
    approvedMinutes: number;
    decisionStatus: Database["public"]["Enums"]["overtime_decision_status"];
    reason: string;
    responsible: string;
    decidedAt: string;
  }[];
  missingPunchPending: boolean;
  absenceDecisionPending: boolean;
  lateDecisionAudit?: {
    decision: string;
    reason: string;
    responsible: string;
    decidedAt: string;
  };
  earlyDepartureDecisionAudit?: {
    decision: string;
    reason: string;
    responsible: string;
    decidedAt: string;
  };
}

export interface AttendanceExportWorker {
  employeeId: string;
  /** Identificador estable para conciliar con Workera sin depender del nombre. */
  employeeCode: string;
  /** Identificador legal de nómina, si el padrón autorizado lo contiene. */
  employeeRut: string | null;
  workerName: string;
  area: AreaCode;
  /**
   * Unidad organizacional primaria vigente al cierre del período. Es la
   * fuente maestra que GESTORA también expone como centro de costo; nunca se
   * rellena con el grupo operacional por semejanza de nombre.
   */
  costCenter: string | null;
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
  /** Grupo operacional que regía en cada fecha del corte. */
  areaByDate?: Map<string, AreaCode>;
  /** Una jornada distinta de término 17:00 aún no fue confirmada por RR. HH. */
  scheduleConfirmationPending?: boolean;
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
  /** Identidad técnica del tenant; se valida al reimportar el libro. */
  companyId?: string;
  /** Versión aceptada que sirvió como base de esta descarga, si existe. */
  workbookBaseVersionId?: string | null;
  /** Última decisión aceptada por trabajador/campo, reaplicada sin alterar Workera. */
  workbookAdjustments?: readonly AcceptedPayrollWorkbookAdjustment[];
  /** Cantidad exacta del padrón autorizado, cuando la empresa exige uno cerrado. */
  rosterCount?: number | null;
  /** Huella canónica de los códigos Workera del padrón autorizado. */
  rosterSha256?: string | null;
}

export interface AttendanceExportOptions {
  employeeIds?: readonly string[];
  expectedEmployeeCodeSha256?: string;
}

function emptyDay(): AttendanceExportDay {
  return {
    statusCode: MISSING_STATUS_CODE,
    recordedMinutes: 0,
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
    overtimeDecisionAudits: [],
    missingPunchPending: false,
    absenceDecisionPending: false,
  };
}

export async function buildAttendanceExportData(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  period: AttendanceExportPeriod,
  companyId: string,
  options: AttendanceExportOptions = {},
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

  const requestedEmployeeIds = options.employeeIds ? new Set(options.employeeIds) : null;
  if (requestedEmployeeIds && requestedEmployeeIds.size !== options.employeeIds!.length) {
    throw new Error("buildAttendanceExportData: el padrón solicitado contiene IDs duplicados.");
  }
  if (options.expectedEmployeeCodeSha256 && requestedEmployeeIds === null) {
    throw new Error("buildAttendanceExportData: una huella de padrón exige IDs explícitos.");
  }
  if (options.expectedEmployeeCodeSha256 && !/^[a-f0-9]{64}$/.test(options.expectedEmployeeCodeSha256)) {
    throw new Error("buildAttendanceExportData: la huella del padrón no es válida.");
  }

  const scoped = employees
    .map((row) => ({
      id: row.id,
      externalWorkeraId: row.external_workera_id,
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
        externalWorkeraId: string;
        employeeCode: string;
        employeeRut: string | null;
        displayName: string;
        hireDate: string | null;
        active: boolean;
        area: AreaCode;
      } => employee.area !== null
        && (requestedEmployeeIds !== null || employee.hireDate === null || employee.hireDate <= period.endDate)
        && (requestedEmployeeIds === null || requestedEmployeeIds.has(employee.id))
    );

  if (requestedEmployeeIds && scoped.length !== requestedEmployeeIds.size) {
    throw new Error("buildAttendanceExportData: el padrón solicitado no pertenece íntegramente a la empresa y alcance autorizados.");
  }

  let rosterSha256: string | null = null;
  if (options.expectedEmployeeCodeSha256) {
    const employeeCodes = scoped.map((employee) => employee.externalWorkeraId.trim());
    if (employeeCodes.some((code) => code === "") || new Set(employeeCodes).size !== employeeCodes.length) {
      throw new Error("buildAttendanceExportData: el padrón autorizado tiene códigos Workera vacíos o duplicados.");
    }
    rosterSha256 = canonicalRosterSha256(employeeCodes);
    if (rosterSha256 !== options.expectedEmployeeCodeSha256) {
      throw new Error("buildAttendanceExportData: los UUID configurados no corresponden al padrón autorizado de Arcotex.");
    }
  }

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
      .eq("company_id", companyId)
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
    costCenter: null,
    days: new Map(),
    hireDate: e.hireDate,
    currentlyActive: e.active,
    scheduledWeekdays: new Set<number>(),
    scheduleCoveredDates: new Set<string>(),
    scheduledDates: new Set<string>(),
    exemptDates: new Set<string>(),
    scheduleLabel: null,
    areaByDate: new Map(),
    scheduleConfirmationPending: false,
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
      companyId,
      workbookBaseVersionId: null,
      rosterCount: requestedEmployeeIds?.size ?? null,
      rosterSha256,
    };
  }

  const employeeIdBatches = chunksOf(employeeIds, EMPLOYEE_ID_BATCH_SIZE);
  const [
    attendancePunchPages,
    statusPages,
    latePages,
    earlyDeparturePages,
    overtimePages,
    missingPunchPages,
    absencePages,
    employeeGroupAssignmentPages,
    organizationAssignmentPages,
  ] = await Promise.all([
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<AttendancePunchRow>("buildAttendanceExportData: fallo leyendo marcas efectivas", (from, to) =>
          supabase
            .from("attendance_records")
            .select("employee_id, work_date, actual_clock_in, actual_clock_out, attendance_corrections(corrected_clock_in, corrected_clock_out, is_current)")
            .in("employee_id", ids)
            .gte("work_date", period.startDate)
            .lte("work_date", period.endDate)
            .eq("is_current", true)
            .order("employee_id")
            .order("work_date")
            .order("id")
            .range(from, to) as unknown as PromiseLike<PageResponse<AttendancePunchRow>>
        )
      )
    ),
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
              "employee_id, work_date, detected_minutes, attendance_records!inner(is_current), late_arrival_decisions(payroll_minutes, payroll_effect, justified, reason, decided_at, is_current, decided_by_profile:profiles!late_arrival_decisions_decided_by_fkey(display_name))"
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
              "employee_id, work_date, detected_minutes, attendance_records!inner(is_current), early_departure_decisions(payroll_minutes, payroll_effect, reason_category, reason, decided_at, is_current, decided_by_profile:profiles!early_departure_decisions_decided_by_fkey(display_name))"
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
              "employee_id, work_date, candidate_minutes, attendance_records!inner(is_current), overtime_types(code), overtime_decisions(approved_minutes, rejected_minutes, decision_status, reason, decided_at, is_current, decided_by_profile:profiles!overtime_decisions_decided_by_fkey(display_name), employee_daily_bonuses(amount, currency))"
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
            .in("status", ["PENDING_CONTACT", "CONTACTED", "UNRESOLVED"])
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
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<EmployeeGroupAssignmentRow>(
          "buildAttendanceExportData: fallo leyendo grupos históricos",
          (from, to) =>
            supabase
              .from("employee_group_assignments")
              .select("employee_id, effective_from, effective_to, employee_groups!inner(code, company_id)")
              .in("employee_id", ids)
              .eq("employee_groups.company_id", companyId)
              .lte("effective_from", period.endDate)
              .order("employee_id")
              .order("effective_from")
              .order("id")
              .range(from, to) as unknown as PromiseLike<PageResponse<EmployeeGroupAssignmentRow>>
        )
      )
    ),
    Promise.all(
      employeeIdBatches.map((ids) =>
        fetchAllPages<OrganizationAssignmentRow>(
          "buildAttendanceExportData: fallo leyendo centros de costo",
          (from, to) =>
            supabase
              .from("employee_org_assignments")
              .select(
                "employee_id, effective_from, effective_to, is_primary, organization_units!employee_org_assignments_company_id_org_unit_id_fkey(code, name)"
              )
              .eq("company_id", companyId)
              .eq("is_primary", true)
              .in("employee_id", ids)
              .lte("effective_from", period.endDate)
              .order("employee_id")
              .order("effective_from", { ascending: false })
              .order("id")
              .range(from, to) as unknown as PromiseLike<PageResponse<OrganizationAssignmentRow>>
        )
      )
    ),
  ]);

  const attendancePunchRows = attendancePunchPages.flat();
  const statusRows = statusPages.flat();
  const lateRows = latePages.flat();
  const earlyDepartureRows = earlyDeparturePages.flat();
  const overtimeRows = overtimePages.flat();
  const missingPunchRows = missingPunchPages.flat();
  const absenceRows = absencePages.flat();

  // El grupo actual de la ficha no puede reinterpretar un día histórico. Se
  // materializa la vigencia por fecha y se rechazan huecos/solapamientos: los
  // topes de HE y el rótulo del período deben usar la clasificación que regía
  // al producirse cada marcación.
  for (const row of employeeGroupAssignmentPages.flat()) {
    const worker = byId.get(row.employee_id);
    const relation = unwrap(row.employee_groups);
    if (!worker || !relation || relation.company_id !== companyId) continue;
    for (const date of days) {
      if (date < row.effective_from || (row.effective_to !== null && date > row.effective_to)) continue;
      const existing = worker.areaByDate?.get(date);
      if (existing && existing !== relation.code) {
        throw new Error(`buildAttendanceExportData: grupos históricos superpuestos (${row.employee_id}, ${date}).`);
      }
      worker.areaByDate?.set(date, relation.code);
    }
  }
  for (const worker of workers) {
    for (const date of days) {
      if (beforeHire(worker, date)) continue;
      if (!worker.areaByDate?.has(date)) {
        throw new Error(`buildAttendanceExportData: falta grupo histórico (${worker.employeeId}, ${date}).`);
      }
    }
    worker.area = worker.areaByDate?.get(period.endDate) ?? worker.area;
  }

  // Las horas registradas salen de las marcas efectivas (corrección vigente
  // cuando existe; en caso contrario, el dato crudo inmutable de Workera).
  // No se inventa ni se descuenta una colación porque no existe una regla de
  // colación acordada para este artefacto.
  for (const row of attendancePunchRows) {
    const correction = (row.attendance_corrections ?? []).find((item) => item.is_current);
    const clockIn = correction?.corrected_clock_in ?? row.actual_clock_in;
    const clockOut = correction?.corrected_clock_out ?? row.actual_clock_out;
    if (!clockIn || !clockOut) continue;
    const elapsed = Math.floor((Date.parse(clockOut) - Date.parse(clockIn)) / 60_000);
    const day = cell(row.employee_id, row.work_date);
    if (day && Number.isFinite(elapsed) && elapsed >= 0) day.recordedMinutes = elapsed;
  }

  // Centro de costo al último día del corte. El grupo PRODUCTION/INSTALLATION
  // clasifica reglas de asistencia, pero no es un maestro contable y por eso
  // jamás se usa como sustituto. Si falta una asignación primaria vigente, el
  // Excel de pago queda bloqueado de forma explícita.
  for (const row of organizationAssignmentPages.flat()) {
    if (!row.is_primary || (row.effective_to !== null && row.effective_to < period.endDate)) continue;
    const worker = byId.get(row.employee_id);
    if (!worker || worker.costCenter !== null) continue;
    const unit = unwrap(row.organization_units);
    if (unit) worker.costCenter = `${unit.code} — ${unit.name}`;
  }

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
      if (!requiresReview && current) {
        const actor = unwrap(current.decided_by_profile)?.display_name;
        day.lateDecisionAudit = {
          decision: current.justified ? "JUSTIFICADO" : "DESCONTAR",
          reason: current.reason ?? "",
          responsible: actor ?? "Responsable registrado",
          decidedAt: current.decided_at,
        };
      }
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
    if (!requiresReview && current) {
      const actor = unwrap(current.decided_by_profile)?.display_name;
      day.earlyDepartureDecisionAudit = {
        decision: current.payroll_effect === "DEDUCT" ? "DESCONTAR" : "JUSTIFICADO",
        reason: current.reason ?? "",
        responsible: actor ?? "Responsable registrado",
        decidedAt: current.decided_at,
      };
    }
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

  // Horas extra: el candidato conserva siempre el tiempo real observado y la
  // decisión vigente aporta, por separado, únicamente el tiempo pagable.
  for (const row of overtimeRows) {
    const typeCode = unwrap(row.overtime_types)?.code;
    if (typeCode !== OVERTIME_50_CODE && typeCode !== OVERTIME_100_CODE) {
      throw new Error(`buildAttendanceExportData: tipo de hora extra no soportado (${typeCode ?? "sin código"}).`);
    }
    const decisions = row.overtime_decisions ?? [];
    const current = decisions.find((d) => d.is_current);

    const day = cell(row.employee_id, row.work_date);
    if (!day) continue;
    if (typeCode === OVERTIME_100_CODE) day.overtime100CandidateMinutes += row.candidate_minutes;
    else day.overtime50CandidateMinutes += row.candidate_minutes;
    if (!current) {
      if (typeCode === OVERTIME_100_CODE) {
        day.overtime100DecisionPending = true;
      } else {
        day.overtime50DecisionPending = true;
      }
      continue;
    }
    (day.overtimeDecisionAudits ??= []).push({
      typeCode,
      candidateMinutes: row.candidate_minutes,
      approvedMinutes: current.approved_minutes,
      decisionStatus: current.decision_status,
      reason: current.reason ?? "",
      responsible: unwrap(current.decided_by_profile)?.display_name ?? "Responsable no disponible",
      decidedAt: current.decided_at,
    });
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
            "employee_id, effective_from, effective_to, rrhh_confirmed_at, work_schedules(work_schedule_rules(day_of_week, scheduled_start, scheduled_end))"
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

    if (row.rrhh_confirmed_at == null && workingRules.some((rule) => rule.end.slice(0, 5) !== "17:00")) {
      worker.scheduleConfirmationPending = true;
    }

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
    .filter((worker) => requestedEmployeeIds !== null || worker.currentlyActive || worker.days.size > 0)
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

  return {
    period,
    days,
    workers: includedWorkers,
    holidays,
    reportingPeriodStatus,
    ruleEngineProblemDates,
    companyId,
    workbookBaseVersionId: null,
    rosterCount: requestedEmployeeIds?.size ?? null,
    rosterSha256,
  };
}

// ---------------------------------------------------------------------------
// Construcción del libro

/** Excel guarda una duración como fracción de día; el formato `[h]:mm:ss` la muestra como h:mm:ss. */
function minutesToExcelDuration(minutes: number): number {
  return minutes / (24 * 60);
}

/** Los totales del período pueden superar 24 horas y nunca deben volver a cero. */
const DURATION_TOTAL_FORMAT = "[h]:mm";
const MONEY_FORMAT = '"$"#,##0';
const INTEGER_FORMAT = "#,##0;[Red]-#,##0";
const MATRIX_FIRST_DAY_COL = 5;
const DATA_FIRST_ROW = 5; // índice base 0; en Excel los datos comienzan en la fila 6.

const solidFill = (rgb: string) => ({
  fill: { patternType: "solid", fgColor: { rgb }, bgColor: { rgb: "000000" } },
  font: { name: "Arial", sz: 10, color: { rgb: "1F2937" } },
});

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

const INPUT_STYLE = solidFill("DDEBF7");
const HEADER_STYLE = {
  ...solidFill("1F4E78"),
  font: { name: "Arial", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
};
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
    day.recordedMinutes > 0 ||
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

/**
 * Código diario seguro para la sábana. Si el dato no es definitivo, muestra
 * `?`: así las fórmulas nunca transforman una licencia en trámite o una fila
 * de una corrida fallida en un valor pagable.
 */
function dailyMatrixCode(
  worker: AttendanceExportWorker,
  date: string,
  day: AttendanceExportDay,
  data: AttendanceExportData
): string {
  if (beforeHire(worker, date)) return dayHasAttendanceFact(day) ? MISSING_STATUS_CODE : "";
  const engineUnreliable = data.ruleEngineProblemDates.has(date) &&
    (expectedWorkDate(worker, date, data.holidays) || worker.days.has(date));
  if (engineUnreliable || day.missingPunchPending || day.absenceDecisionPending) return MISSING_STATUS_CODE;
  if (day.statusCode !== MISSING_STATUS_CODE) return day.statusCode;
  return expectedWorkDate(worker, date, data.holidays) ? MISSING_STATUS_CODE : "";
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

function overtimePayableCap(worker: AttendanceExportWorker, date: string, holidays: ReadonlySet<string>): number | null {
  const effectiveArea = worker.areaByDate?.get(date) ?? worker.area;
  if (effectiveArea === "ADMINISTRATION") return 0;
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dayOfWeek === 0) return effectiveArea === "INSTALLATION" ? null : 0;
  return holidays.has(date) ? 360 : 120;
}

interface WorkerExportSummary {
  ordinaryRecordedMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtime50RealMinutes: number;
  overtime100RealMinutes: number;
  overtime50Minutes: number;
  overtime100Minutes: number;
  bonusDays: number;
  bonusAmount: number;
  bonusDates: string[];
  reviewDates: string[];
  lateWeeklyBreakdown: string;
  earlyDepartureWeeklyBreakdown: string;
  observations: string;
}

interface WeeklyMinutes {
  detected: number;
  final: number;
}

function calendarWeekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const daysFromMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysFromMonday);
  return value.toISOString().slice(0, 10);
}

function weeklyMinutesLabel(values: ReadonlyMap<string, WeeklyMinutes>): string {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([start, minutes]) => {
      const end = new Date(`${start}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      const range = `${start.slice(8, 10)}/${start.slice(5, 7)}–${end.toISOString().slice(8, 10)}/${end.toISOString().slice(5, 7)}`;
      return `${range}: original ${minutes.detected} min · descontable ${minutes.final} min`;
    })
    .join(" | ");
}

function summarizeWorker(worker: AttendanceExportWorker, data: AttendanceExportData): WorkerExportSummary {
  let ordinaryRecordedMinutes = 0;
  let lateMinutes = 0;
  let earlyDepartureMinutes = 0;
  let overtime50RealMinutes = 0;
  let overtime100RealMinutes = 0;
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
  const lateByWeek = new Map<string, WeeklyMinutes>();
  const earlyDepartureByWeek = new Map<string, WeeklyMinutes>();
  const overtimeCapAlerts: string[] = [];

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
    lateMinutes += day.lateMinutes;
    earlyDepartureMinutes += day.earlyDepartureMinutes;
    const weekStart = calendarWeekStart(date);
    if (day.lateDetectedMinutes > 0 || day.lateMinutes > 0) {
      const accumulated = lateByWeek.get(weekStart) ?? { detected: 0, final: 0 };
      accumulated.detected += day.lateDetectedMinutes;
      accumulated.final += day.lateMinutes;
      lateByWeek.set(weekStart, accumulated);
    }
    if (day.earlyDepartureDetectedMinutes > 0 || day.earlyDepartureMinutes > 0) {
      const accumulated = earlyDepartureByWeek.get(weekStart) ?? { detected: 0, final: 0 };
      accumulated.detected += day.earlyDepartureDetectedMinutes;
      accumulated.final += day.earlyDepartureMinutes;
      earlyDepartureByWeek.set(weekStart, accumulated);
    }
    overtime50RealMinutes += day.overtime50CandidateMinutes;
    overtime100RealMinutes += day.overtime100CandidateMinutes;
    ordinaryRecordedMinutes += Math.max(
      0,
      day.recordedMinutes - day.overtime50CandidateMinutes - day.overtime100CandidateMinutes
    );
    overtime50Minutes += day.overtime50Minutes;
    overtime100Minutes += day.overtime100Minutes;
    const realOvertime = day.overtime50CandidateMinutes + day.overtime100CandidateMinutes;
    const payableOvertime = day.overtime50Minutes + day.overtime100Minutes;
    const payableCap = overtimePayableCap(worker, date, data.holidays);
    if (payableCap !== null && realOvertime > payableCap && !day.overtime50DecisionPending && !day.overtime100DecisionPending) {
      overtimeCapAlerts.push(`${date}: real ${realOvertime} min · pagable ${payableOvertime} min · tope ${payableCap} min`);
    }
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
  if (worker.scheduleConfirmationPending) reviewNotes.push("Jornada distinta de 17:00 pendiente de confirmación de RR. HH.");
  if (!worker.currentlyActive) reviewNotes.push("Persona inactiva: revisar fecha de salida");
  if (missingScheduleDays > 0) reviewNotes.push(`Sin horario vigente: ${countedLabel(missingScheduleDays, "día", "días")}`);
  if (missingStatuses > 0) reviewNotes.push(`Marcación/estado pendiente: ${countedLabel(missingStatuses, "día", "días")}`);
  if (pendingMissingPunch > 0) reviewNotes.push(`Marcaciones incompletas por resolver: ${pendingMissingPunch}`);
  if (pendingAbsenceDays > 0) reviewNotes.push(`Ausencias/licencias por resolver: ${countedLabel(pendingAbsenceDays, "día", "días")}`);
  if (pendingStatusPolicyDays > 0) reviewNotes.push(`Códigos sin efecto de nómina definido: ${countedLabel(pendingStatusPolicyDays, "día", "días")}`);
  if (preHireFactDays > 0) reviewNotes.push(`Hechos anteriores al ingreso: ${countedLabel(preHireFactDays, "día", "días")}`);
  if (pendingLate > 0) reviewNotes.push(`Atrasos por decidir: ${pendingLate}`);
  if (pendingEarlyDeparture > 0) reviewNotes.push(`Salidas anticipadas por decidir: ${pendingEarlyDeparture}`);
  if (pendingOvertime > 0) reviewNotes.push(`Horas extra por decidir: ${pendingOvertime}`);
  if (overtimeCapAlerts.length > 0) informationNotes.push(`Alerta por exceso sobre tope HE: ${overtimeCapAlerts.join(" | ")}`);

  return {
    ordinaryRecordedMinutes,
    lateMinutes,
    earlyDepartureMinutes,
    overtime50RealMinutes,
    overtime100RealMinutes,
    overtime50Minutes,
    overtime100Minutes,
    bonusDays: bonusDates.size,
    bonusAmount,
    bonusDates: [...bonusDates].sort(),
    reviewDates: [...reviewDates].sort(),
    lateWeeklyBreakdown: weeklyMinutesLabel(lateByWeek),
    earlyDepartureWeeklyBreakdown: weeklyMinutesLabel(earlyDepartureByWeek),
    observations: [...informationNotes, ...reviewNotes].join(" · "),
  };
}

function exportStatusLabel(data: AttendanceExportData, pendingItems: PendingExportRow[]): string {
  const pendingWorkers = new Set(
    pendingItems
      .filter((item) => item.scope === "PERSONA")
      .map((item) => item.employeeCode || item.employeeRut || item.workerName)
  ).size;
  const pendingTotal = pendingItems.length;
  const engineProblemDates = ruleEngineProblemDatesAffectingPayroll(data);
  const engineNote = engineProblemDates.length > 0
    ? `; procesamiento incompleto en ${countedLabel(engineProblemDates.length, "fecha", "fechas")}`
    : "";
  if (data.period.type === "PAGO" && data.reportingPeriodStatus !== "CLOSED") {
    return `REVISAR — el período 16-15 no está cerrado${engineNote}${pendingWorkers > 0 ? ` y ${countedLabel(pendingWorkers, "persona", "personas")} requieren revisión` : ""}`;
  }
  if (engineProblemDates.length > 0) {
    return `REVISAR — procesamiento incompleto en ${countedLabel(engineProblemDates.length, "fecha", "fechas")}${pendingWorkers > 0 ? ` y ${countedLabel(pendingWorkers, "persona", "personas")} con pendientes propios` : ""}`;
  }
  if (pendingTotal > 0) {
    return `REVISAR — ${countedLabel(pendingTotal, "incidencia", "incidencias")}${pendingWorkers > 0 ? ` en ${countedLabel(pendingWorkers, "persona", "personas")}` : pendingTotal === 1 ? " global" : " globales"}`;
  }
  return data.period.type === "PAGO"
    ? "CONTROL — período cerrado, sin pendientes detectados"
    : "VISTA DE CONTROL — sin pendientes detectados";
}

function countedLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
  priority: "CRÍTICA" | "ALTA" | "INFORMATIVA";
  state: "PENDIENTE" | "RESUELTO";
  employeeId: string;
  employeeCode: string;
  employeeRut: string;
  workerName: string;
  area: string;
  costCenter: string;
  date: string;
  issue: string;
  quantity: number | null;
  unit: string;
  responsible: string;
  decision: string;
  reason: string;
  resolvedAt: string;
  action: string;
}

function resolvedControlRows(data: AttendanceExportData): PendingExportRow[] {
  const rows: PendingExportRow[] = [];
  for (const worker of data.workers) {
    const area = worker.area === "PRODUCTION"
      ? "Producción"
      : worker.area === "INSTALLATION"
        ? "Instalación"
        : "Administración";
    for (const date of data.days) {
      const day = worker.days.get(date);
      if (!day) continue;
      for (const incident of [
        day.lateDecisionAudit
          ? { issue: `Atraso: original ${day.lateDetectedMinutes} min · final ${day.lateMinutes} min`, quantity: day.lateMinutes, audit: day.lateDecisionAudit }
          : null,
        day.earlyDepartureDecisionAudit
          ? { issue: `Salida anticipada: original ${day.earlyDepartureDetectedMinutes} min · final ${day.earlyDepartureMinutes} min`, quantity: day.earlyDepartureMinutes, audit: day.earlyDepartureDecisionAudit }
          : null,
      ]) {
        if (!incident) continue;
        rows.push({
          scope: "PERSONA",
          priority: "INFORMATIVA",
          state: "RESUELTO",
          employeeId: worker.employeeId,
          employeeCode: worker.employeeCode,
          employeeRut: worker.employeeRut ?? "",
          workerName: worker.workerName,
          area,
          costCenter: worker.costCenter ?? "",
          date,
          issue: incident.issue,
          quantity: incident.quantity,
          unit: "min descontables",
          responsible: incident.audit.responsible,
          decision: incident.audit.decision,
          reason: incident.audit.reason,
          resolvedAt: incident.audit.decidedAt,
          action: "Sin acción pendiente; RR. HH. conserva el veredicto final.",
        });
      }
      for (const audit of day.overtimeDecisionAudits ?? []) {
        const cap = overtimePayableCap(worker, date, data.holidays);
        const rateLabel = audit.typeCode === OVERTIME_100_CODE ? "HH100" : "HH50";
        const capDetail = cap !== null && audit.candidateMinutes > cap
          ? ` · tope ${cap} min`
          : "";
        rows.push({
          scope: "PERSONA",
          priority: "INFORMATIVA",
          state: "RESUELTO",
          employeeId: worker.employeeId,
          employeeCode: worker.employeeCode,
          employeeRut: worker.employeeRut ?? "",
          workerName: worker.workerName,
          area,
          costCenter: worker.costCenter ?? "",
          date,
          issue: `${rateLabel}: real ${audit.candidateMinutes} min · aprobado ${audit.approvedMinutes} min${capDetail}`,
          quantity: audit.approvedMinutes,
          unit: "min pagables",
          responsible: audit.responsible,
          decision: audit.decisionStatus === "FULLY_APPROVED"
            ? "APROBADA"
            : audit.decisionStatus === "PARTIALLY_APPROVED"
              ? "APROBADA PARCIALMENTE"
              : "RECHAZADA",
          reason: audit.reason || "Sin motivo específico registrado.",
          resolvedAt: audit.decidedAt,
          action: cap !== null && audit.approvedMinutes > cap
            ? "Inconsistencia: RR. HH. debe corregir una aprobación superior al tope."
            : "Sin acción pendiente; se conserva la decisión competente y los minutos reales.",
        });
      }
    }
  }
  return rows;
}

function ruleEngineProblemDatesAffectingPayroll(data: AttendanceExportData): string[] {
  return [...data.ruleEngineProblemDates]
    .filter((date) => data.workers.some(
      (worker) => expectedWorkDate(worker, date, data.holidays) || worker.days.has(date)
    ))
    .sort();
}

function workbookAdjustmentMap(
  data: AttendanceExportData,
  employeeId: string
): Map<PayrollSummaryAdjustmentField, AcceptedPayrollWorkbookAdjustment> {
  return new Map(
    (data.workbookAdjustments ?? [])
      .filter((adjustment) => adjustment.employeeId === employeeId && (adjustment.workDate ?? null) === null && adjustment.field !== "Código asistencia")
      .map((adjustment) => [adjustment.field as PayrollSummaryAdjustmentField, adjustment])
  );
}

function workbookDailyAdjustment(
  data: AttendanceExportData,
  employeeId: string,
  workDate: string,
): AcceptedPayrollWorkbookAdjustment | undefined {
  return (data.workbookAdjustments ?? []).find(
    (adjustment) => adjustment.employeeId === employeeId
      && adjustment.workDate === workDate
      && adjustment.field === "Código asistencia",
  );
}

export interface PayrollWorkbookConflictPreview {
  stableKey: string;
  employeeId: string;
  employeeName: string;
  workDate: string | null;
  fieldCode: PayrollAdjustmentField;
  valueKind: "MINUTES" | "CLP" | "CODE";
  sourceAtAcceptance: string | number;
  currentWorkeraValue: string | number;
  rrhhFinalValue: string | number;
}

/** Conflictos de tres vías calculados desde la fuente vigente y la decisión aceptada. */
export function payrollWorkbookConflicts(data: AttendanceExportData): PayrollWorkbookConflictPreview[] {
  const conflicts: PayrollWorkbookConflictPreview[] = [];
  for (const worker of data.workers) {
    const summary = summarizeWorker(worker, data);
    const adjustments = workbookAdjustmentMap(data, worker.employeeId);
    for (const rule of [
      { field: "Ajuste HH50 (minutos)", current: summary.overtime50Minutes, scale: 1_440, kind: "MINUTES" },
      { field: "Ajuste HH100 (minutos)", current: summary.overtime100Minutes, scale: 1_440, kind: "MINUTES" },
      { field: "Ajuste bono (CLP)", current: summary.bonusAmount, scale: 1, kind: "CLP" },
    ] as const) {
      const entry = adjustments.get(rule.field);
      if (
        typeof entry?.value !== "number"
        || entry.value === 0
        || typeof entry.sourceValueAtAcceptance !== "number"
      ) continue;
      const sourceAtAcceptance = entry.sourceValueAtAcceptance * rule.scale;
      if (Math.abs(sourceAtAcceptance - rule.current) <= 1e-9) continue;
      conflicts.push({
        stableKey: `${worker.employeeId}|${rule.field}`,
        employeeId: worker.employeeId,
        employeeName: worker.workerName,
        workDate: null,
        fieldCode: rule.field,
        valueKind: rule.kind,
        sourceAtAcceptance,
        currentWorkeraValue: rule.current,
        rrhhFinalValue: sourceAtAcceptance + entry.value,
      });
    }
    for (const entry of (data.workbookAdjustments ?? []).filter(
      (adjustment) => adjustment.employeeId === worker.employeeId
        && adjustment.field === "Código asistencia"
        && adjustment.workDate,
    )) {
      if (typeof entry.value !== "string" || typeof entry.sourceValueAtAcceptance !== "string") continue;
      const workDate = entry.workDate!;
      const current = dailyMatrixCode(worker, workDate, worker.days.get(workDate) ?? emptyDay(), data);
      if (current === entry.sourceValueAtAcceptance || current === entry.value) continue;
      conflicts.push({
        stableKey: `${worker.employeeId}|${workDate}|Código asistencia`,
        employeeId: worker.employeeId,
        employeeName: worker.workerName,
        workDate,
        fieldCode: "Código asistencia",
        valueKind: "CODE",
        sourceAtAcceptance: entry.sourceValueAtAcceptance,
        currentWorkeraValue: current,
        rrhhFinalValue: entry.value,
      });
    }
  }
  return conflicts.sort((left, right) => left.employeeName.localeCompare(right.employeeName, "es") || left.stableKey.localeCompare(right.stableKey));
}

function numericWorkbookAdjustment(
  adjustments: Map<PayrollSummaryAdjustmentField, AcceptedPayrollWorkbookAdjustment>,
  field: PayrollSummaryAdjustmentField,
  currentAutomatic?: number,
  sourceToAdjustmentScale = 1,
): number {
  const entry = adjustments.get(field);
  const value = entry?.value;
  const sourceValueAtAcceptance = entry?.sourceValueAtAcceptance;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (
    value !== 0
    && currentAutomatic !== undefined
    && typeof sourceValueAtAcceptance === "number"
    && Number.isFinite(sourceValueAtAcceptance)
  ) {
    // RR. HH. decidió un valor final, no un delta perpetuo. Si la fuente se
    // mueve después, recalculamos el ajuste visible para conservar ese final
    // hasta que RR. HH. elija Workera u otro valor de forma explícita.
    return sourceValueAtAcceptance * sourceToAdjustmentScale + value - currentAutomatic;
  }
  return value;
}

function textWorkbookAdjustment(
  adjustments: Map<PayrollSummaryAdjustmentField, AcceptedPayrollWorkbookAdjustment>,
  field: PayrollSummaryAdjustmentField
): string {
  const value = adjustments.get(field)?.value;
  return typeof value === "string" ? value : "";
}

function buildPendingExportRows(data: AttendanceExportData): PendingExportRow[] {
  const rows: PendingExportRow[] = [];
  const global = (date: string, issue: string, action: string): void => {
    rows.push({
      scope: "GLOBAL",
      priority: "CRÍTICA",
      state: "PENDIENTE",
      employeeId: "",
      employeeCode: "",
      employeeRut: "",
      workerName: "",
      area: "Todas",
      costCenter: "",
      date,
      issue,
      quantity: null,
      unit: "",
      responsible: "RR. HH.",
      decision: "POR RESOLVER",
      reason: "",
      resolvedAt: "",
      action,
    });
  };

  // Un período abierto es el estado normal de la revisión. Solo los datos no
  // resueltos bloquean; la aprobación/cierre sigue siendo un acto expreso de
  // RR. HH. y nunca se infiere de la ausencia de pendientes.
  if (data.period.type === "PAGO") {
    for (const [label, values] of [
      ["RUT", data.workers.map((worker) => worker.employeeRut ?? "")],
      ["Código Workera", data.workers.map((worker) => worker.employeeCode.trim())],
    ] as const) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const value of values) {
        if (value === "") continue;
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
      }
      if (duplicates.size > 0) {
        global("", `${label} duplicado en ${countedLabel(duplicates.size, "valor", "valores")}`, `Corregir la unicidad de ${label.toLowerCase()} antes de liquidar.`);
      }
    }
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
      priority: /Conflicto|negativo|Sin horario|Marcación incompleta|Ausencia o licencia/i.test(issue)
        ? "CRÍTICA"
        : "ALTA",
      state: "PENDIENTE",
      employeeId: worker.employeeId,
      employeeCode: worker.employeeCode,
      employeeRut: worker.employeeRut ?? "",
      workerName: worker.workerName,
      area: worker.area === "PRODUCTION"
        ? "Producción"
        : worker.area === "INSTALLATION"
          ? "Instalación"
          : "Administración",
      costCenter: worker.costCenter ?? "",
      date,
      issue,
      quantity,
      unit,
      responsible: /Atraso|Salida anticipada|HH 50%|HH 100%|Marcación incompleta|Ausencia o licencia/i.test(issue)
        ? "Supervisor de área"
        : "RR. HH.",
      decision: "POR RESOLVER",
      reason: "",
      resolvedAt: "",
      action,
    });
  };

  for (const worker of data.workers) {
    const acceptedAdjustments = workbookAdjustmentMap(data, worker.employeeId);
    const workerSummary = summarizeWorker(worker, data);
    for (const rule of [
      { adjustment: "Ajuste HH50 (minutos)", reason: "Motivo ajuste HH50", automatic: workerSummary.overtime50Minutes, label: "HH50", sourceScale: 1 / 1_440 },
      { adjustment: "Ajuste HH100 (minutos)", reason: "Motivo ajuste HH100", automatic: workerSummary.overtime100Minutes, label: "HH100", sourceScale: 1 / 1_440 },
      { adjustment: "Ajuste bono (CLP)", reason: "Motivo ajuste bono", automatic: workerSummary.bonusAmount, label: "bono", sourceScale: 1 },
    ] as const) {
      const adjustmentEntry = acceptedAdjustments.get(rule.adjustment);
      if (!adjustmentEntry) continue;
      const adjustment = numericWorkbookAdjustment(
        acceptedAdjustments,
        rule.adjustment,
        rule.automatic,
        rule.label === "bono" ? 1 : 1_440,
      );
      const reason = textWorkbookAdjustment(acceptedAdjustments, rule.reason);
      if (adjustment !== 0 && reason.trim() === "") {
        addPerson(worker, "", `Ajuste ${rule.label} sin motivo`, adjustment, rule.label === "bono" ? "CLP" : "min", "Completar el motivo antes de liquidar.");
      }
      if (rule.automatic + adjustment < 0) {
        addPerson(worker, "", `Resultado final ${rule.label} negativo`, rule.automatic + adjustment, rule.label === "bono" ? "CLP" : "min", "Corregir el ajuste; un resultado final nunca puede ser negativo.");
      }
      const sourceAtAcceptance = adjustmentEntry.sourceValueAtAcceptance;
      const currentSource = rule.automatic * rule.sourceScale;
      if (
        adjustment !== 0
        && typeof sourceAtAcceptance === "number"
        && Math.abs(sourceAtAcceptance - currentSource) > 1e-9
      ) {
        addPerson(
          worker,
          "",
          `Conflicto Workera/RR. HH. en ${rule.label}`,
          adjustment,
          rule.label === "bono" ? "CLP" : "min",
          "Mantener provisionalmente el valor final de RR. HH. y resolver en el ajuste: conservar el total final y actualizar su motivo mantiene RR. HH.; dejar el ajuste en 0 acepta Workera; otro total registra una tercera decisión. Siempre indicar motivo."
        );
      }
    }
    for (const adjustmentEntry of (data.workbookAdjustments ?? []).filter(
      (adjustment) => adjustment.employeeId === worker.employeeId
        && adjustment.field === "Código asistencia"
        && adjustment.workDate !== null,
    )) {
      const date = adjustmentEntry.workDate!;
      const currentSource = dailyMatrixCode(worker, date, worker.days.get(date) ?? emptyDay(), data);
      const adjustedCode = typeof adjustmentEntry.value === "string" ? adjustmentEntry.value : "?";
      if (
        typeof adjustmentEntry.sourceValueAtAcceptance === "string"
        && adjustmentEntry.sourceValueAtAcceptance !== currentSource
        && adjustedCode !== currentSource
      ) {
        addPerson(
          worker,
          date,
          "Conflicto Workera/RR. HH. en código diario",
          null,
          "",
          `Se conserva provisionalmente ${adjustedCode}; Workera ahora informa ${currentSource || "vacío"}. Resolver al comparar la próxima subida: mantener RR. HH., aceptar Workera o ingresar un tercer código oficial, siempre con motivo.`,
        );
      }
    }
    if (worker.scheduleConfirmationPending) {
      addPerson(
        worker,
        "",
        "Jornada distinta de 17:00 sin confirmar",
        null,
        "",
        "RR. HH. debe confirmar expresamente el horario efectivo antes de liquidar."
      );
    }
    if (data.period.type === "PAGO" && !worker.employeeRut) {
      addPerson(worker, "", "RUT ausente", null, "", "Completar el identificador legal antes de liquidar.");
    }
    if (data.period.type === "PAGO" && worker.employeeCode.trim() === "") {
      addPerson(worker, "", "Código Workera ausente", null, "", "Completar el identificador de conciliación antes de liquidar.");
    }
    if (data.period.type === "PAGO" && worker.costCenter === null) {
      addPerson(
        worker,
        "",
        "Centro de costo ausente",
        null,
        "",
        "Asignar la unidad organizacional primaria vigente al cierre del período."
      );
    }
    if (!worker.currentlyActive) {
      addPerson(worker, "", "Persona inactiva en el padrón actual", null, "", "Confirmar fecha de salida antes de liquidar.");
    }

    for (const date of data.days) {
      const day = worker.days.get(date) ?? emptyDay();
      const acceptedDaily = workbookDailyAdjustment(data, worker.employeeId, date);
      const effectiveStatusCode = typeof acceptedDaily?.value === "string" ? acceptedDaily.value : day.statusCode;
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
        effectiveStatusCode === MISSING_STATUS_CODE &&
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
      if (statusRequiresPayrollReview(effectiveStatusCode)) {
        addPerson(
          worker,
          date,
          `Código diario ${effectiveStatusCode} sin efecto de nómina definido`,
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

export interface AttendanceExportCloseReadiness {
  ready: boolean;
  pendingCount: number;
  issues: string[];
}

/**
 * Gate puro usado inmediatamente antes del snapshot final. Un estado
 * APROBADO POR RR. HH. (READY_TO_CLOSE internamente) por sí solo no prueba que
 * Workera siga conciliado: se vuelve
 * a calcular la misma cola que verá RR. HH. en el Excel y se falla cerrado.
 */
export function getAttendanceExportCloseReadiness(
  data: AttendanceExportData
): AttendanceExportCloseReadiness {
  const pending = buildPendingExportRows(data);
  const issues = pending.slice(0, 25).map((item) =>
    [item.date, item.workerName || item.employeeCode, item.issue]
      .filter(Boolean)
      .join(" · ")
  );
  if (pending.length > issues.length) {
    issues.push(`… y ${countedLabel(pending.length - issues.length, "incidencia adicional", "incidencias adicionales")}.`);
  }
  if (data.period.type !== "PAGO") issues.unshift("El cierre final exige un período de pago 16-15.");
  if (data.reportingPeriodStatus !== "READY_TO_CLOSE") {
    issues.unshift("El período debe permanecer Aprobado por RR. HH. durante la comprobación final.");
  }
  return {
    ready: data.period.type === "PAGO" && data.reportingPeriodStatus === "READY_TO_CLOSE" && pending.length === 0,
    pendingCount: pending.length,
    issues,
  };
}

type Cell = string | number | Date | null;

/** Fecha calendario como serial de Excel, sin componente horaria ni conversión de zona. */
function calendarDateToExcelSerial(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000 + 25_569;
}

const SUMMARY_HEADERS_2026 = [
  "Estado",
  "RUT",
  "Nombre completo",
  "Área",
  "Centro de costo",
  "Jornada",
  "Días con presencia",
  "Horas ordinarias registradas",
  "HH50 pagables",
  "HH100 pagables",
  "Atrasos descontables",
  "Salidas anticipadas descontables",
  "Días con bono",
  "Bono total",
  "Pendientes",
  "Observaciones",
  "HH50 reales",
  "Ajuste HH50 (minutos)",
  "Motivo ajuste HH50",
  "HH100 reales",
  "Ajuste HH100 (minutos)",
  "Motivo ajuste HH100",
  "Bono HE automático",
  "Ajuste bono (CLP)",
  "Motivo ajuste bono",
  "Fechas de bono",
  "Fechas pendientes",
  "Código Workera",
  "Identificador técnico",
  "HH50 aprobado automático",
  "HH100 aprobado automático",
  "Atrasos por semana (original · descontable)",
  "Salidas por semana (original · descontable)",
] as const;

const PENDING_HEADERS_2026 = [
  "Alcance",
  "Prioridad",
  "Estado",
  "Código Workera",
  "RUT",
  "Nombre completo",
  "Área",
  "Centro de costo",
  "Fecha",
  "Incidencia",
  "Cantidad",
  "Unidad",
  "Responsable",
  "Decisión",
  "Motivo",
  "Fecha resolución",
  "Acción requerida",
] as const;

function styleHeaderRow(sheet: XLSX.WorkSheet, row: number, columns: number): void {
  for (let column = 0; column < columns; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if (cell) cell.s = HEADER_STYLE;
  }
}

function formulaRangeForMatrixRow(days: string[], workerCount: number, excelRow: number): string {
  const first = XLSX.utils.encode_col(MATRIX_FIRST_DAY_COL);
  const last = XLSX.utils.encode_col(MATRIX_FIRST_DAY_COL + Math.max(0, days.length - 1));
  const lastWorkerRow = 5 + workerCount;
  return `INDEX('MATRIZ_DIARIA_SABANA'!$${first}$6:$${last}$${lastWorkerRow},MATCH($AB${excelRow},'MATRIZ_DIARIA_SABANA'!$B$6:$B$${lastWorkerRow},0),0)`;
}

function pendingCountByEmployee(rows: PendingExportRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.scope !== "PERSONA") continue;
    counts.set(row.employeeId, (counts.get(row.employeeId) ?? 0) + 1);
  }
  return counts;
}

function safeSummaryStatus(
  data: AttendanceExportData,
  pendingCount: number,
  globalPendingCount: number
): "LISTO PARA REVISIÓN RR. HH." | "APROBADO POR RR. HH." | "BLOQUEADO" | "REVISAR" | "CERRADO" {
  if (data.period.type !== "PAGO") return "REVISAR";
  if (pendingCount > 0 || globalPendingCount > 0) return "BLOQUEADO";
  if (data.reportingPeriodStatus === "CLOSED") return "CERRADO";
  return data.reportingPeriodStatus === "READY_TO_CLOSE"
    ? "APROBADO POR RR. HH."
    : "LISTO PARA REVISIÓN RR. HH.";
}

/**
 * Excel de pre-nómina 2026: una fila por persona, una cola de excepciones y
 * una sábana diaria pura. Los valores automáticos permanecen separados de los
 * ajustes manuales para mantener la trazabilidad Workera → RR. HH. → pago.
 */
export function buildAttendanceExportWorkbook(data: AttendanceExportData): Uint8Array {
  const { workers, days, period } = data;
  const summaries = workers.map((worker) => summarizeWorker(worker, data));
  const pendingItems = buildPendingExportRows(data);
  const controlItems = [...pendingItems, ...resolvedControlRows(data)].sort((left, right) =>
    left.state.localeCompare(right.state) || left.date.localeCompare(right.date) || left.workerName.localeCompare(right.workerName, "es")
  );
  const pendingCountsByEmployee = pendingCountByEmployee(pendingItems);
  const globalPendingCount = pendingItems.filter((item) => item.scope === "GLOBAL").length;
  const overallStatus = exportStatusLabel(data, pendingItems);
  const matrixCodesByWorker = workers.map((worker) =>
    days.map((date) => {
      const source = dailyMatrixCode(worker, date, worker.days.get(date) ?? emptyDay(), data);
      const accepted = workbookDailyAdjustment(data, worker.employeeId, date);
      return typeof accepted?.value === "string" ? accepted.value : source;
    })
  );
  const periodScopeLabel = period.type === "PAGO"
    ? `Período de novedades: ${period.label} (corte estricto 16-15)`
    : `Ventana de control: ${period.label}`;
  const countMatrixCode = (workerIndex: number, codes: readonly string[]): number =>
    matrixCodesByWorker[workerIndex].filter((code) => codes.includes(code)).length;

  // -----------------------------------------------------------------------
  // Hoja 1: una fila por persona, preparada para pre-nómina e importación.

  const summaryRows: Cell[][] = [
    ["RESUMEN DE PRE-NÓMINA · ESTÁNDAR 2026"],
    [periodScopeLabel],
    [overallStatus],
    [
      "Las horas y bonos automáticos provienen solo de decisiones definitivas. Los días P son códigos de presencia, no días pagables. Centro_Costo corresponde a la unidad organizacional primaria vigente al día 15. En las columnas Q:Y se ven las horas reales, los ajustes de RR. HH. y sus motivos; Ajuste HH50/HH100 se ingresa en minutos enteros (+/-) y el bono en CLP. Todo ajuste exige motivo. Colación: referencia declarativa de 40 minutos; no se descuenta porque el esquema no contiene una fuente confirmada. 'Sin pendientes' no reemplaza el cierre formal ni un snapshot inmutable.",
    ],
    [...SUMMARY_HEADERS_2026],
  ];

  const pendingCounts: number[] = [];
  const cachedStatuses: ReturnType<typeof safeSummaryStatus>[] = [];
  for (let index = 0; index < workers.length; index += 1) {
    const worker = workers[index];
    const summary = summaries[index];
    const acceptedAdjustments = workbookAdjustmentMap(data, worker.employeeId);
    const adjustment50 = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste HH50 (minutos)", summary.overtime50Minutes, 1_440);
    const adjustment100 = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste HH100 (minutos)", summary.overtime100Minutes, 1_440);
    const adjustmentBonus = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste bono (CLP)", summary.bonusAmount, 1);
    const presentDays = countMatrixCode(index, ["P"]);
    const pendingCount = pendingCountsByEmployee.get(worker.employeeId) ?? 0;
    const status = safeSummaryStatus(data, pendingCount, globalPendingCount);
    pendingCounts.push(pendingCount);
    cachedStatuses.push(status);
    summaryRows.push([
      status,
      worker.employeeRut ?? "",
      worker.workerName,
      worker.area === "PRODUCTION" ? "Producción" : worker.area === "INSTALLATION" ? "Instalación" : "Administración",
      worker.costCenter ?? "",
      scheduleText(worker, data),
      presentDays,
      minutesToExcelDuration(summary.ordinaryRecordedMinutes),
      minutesToExcelDuration(summary.overtime50Minutes + adjustment50),
      minutesToExcelDuration(summary.overtime100Minutes + adjustment100),
      minutesToExcelDuration(summary.lateMinutes),
      minutesToExcelDuration(summary.earlyDepartureMinutes),
      summary.bonusDays,
      summary.bonusAmount + adjustmentBonus,
      pendingCount,
      summary.observations,
      minutesToExcelDuration(summary.overtime50RealMinutes),
      adjustment50,
      textWorkbookAdjustment(acceptedAdjustments, "Motivo ajuste HH50"),
      minutesToExcelDuration(summary.overtime100RealMinutes),
      adjustment100,
      textWorkbookAdjustment(acceptedAdjustments, "Motivo ajuste HH100"),
      summary.bonusAmount,
      adjustmentBonus,
      textWorkbookAdjustment(acceptedAdjustments, "Motivo ajuste bono"),
      shortReviewDates(summary.bonusDates),
      shortReviewDates(summary.reviewDates),
      worker.employeeCode,
      worker.employeeId,
      minutesToExcelDuration(summary.overtime50Minutes),
      minutesToExcelDuration(summary.overtime100Minutes),
      summary.lateWeeklyBreakdown,
      summary.earlyDepartureWeeklyBreakdown,
    ]);
  }

  const summaryTotalRowIndex = summaryRows.length;
  summaryRows.push(["", "", "TOTAL EMPRESA", ...Array<Cell>(SUMMARY_HEADERS_2026.length - 3).fill("")]);
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  applyWhiteCanvas(summarySheet, summaryRows.length, SUMMARY_HEADERS_2026.length);
  summarySheet["!cols"] = [
    { wch: 27 }, { wch: 15 }, { wch: 29 }, { wch: 16 }, { wch: 20 },
    { wch: 27 }, { wch: 16 }, { wch: 17 }, { wch: 15 }, { wch: 16 },
    { wch: 20 }, { wch: 25 }, { wch: 15 }, { wch: 16 }, { wch: 13 }, { wch: 42 },
    { wch: 17 }, { wch: 22 }, { wch: 34 },
    { wch: 17 }, { wch: 22 }, { wch: 34 },
    { wch: 19 }, { wch: 21 }, { wch: 34 },
    { wch: 19 }, { wch: 21 }, { wch: 20 },
    { wch: 38, hidden: true, level: 1 },
    { wch: 22, hidden: true, level: 1 },
    { wch: 22, hidden: true, level: 1 },
    { wch: 48 },
    { wch: 48 },
  ];
  summarySheet["!rows"] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 22 }, { hpt: 48 }, { hpt: 42 }];
  summarySheet["!merges"] = [0, 1, 2, 3].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: 15 } }));
  const summaryDataLastExcelRow = workers.length > 0 ? 5 + workers.length : 5;
  summarySheet["!autofilter"] = { ref: `A5:${XLSX.utils.encode_col(SUMMARY_HEADERS_2026.length - 1)}${summaryDataLastExcelRow}` };

  const summaryTitle = summarySheet.A1;
  if (summaryTitle) summaryTitle.s = { ...solidFill("FFFFFF"), font: { bold: true, sz: 16, color: { rgb: "17365D" } } };
  for (const ref of ["A2", "A4"]) {
    const cell = summarySheet[ref];
    if (cell) cell.s = { ...solidFill("FFFFFF"), font: { color: { rgb: "595959" }, italic: ref === "A4" }, alignment: { wrapText: true, vertical: "center" } };
  }
  const statusCell = summarySheet.A3;
  if (statusCell) statusCell.s = {
    ...solidFill(overallStatus.startsWith("CONTROL") ? "E2F0D9" : "FFF2CC"),
    font: { bold: true, color: { rgb: overallStatus.startsWith("CONTROL") ? "375623" : "9C5700" } },
  };
  styleHeaderRow(summarySheet, 4, SUMMARY_HEADERS_2026.length);

  const durationColumns = new Set([7, 8, 9, 10, 11, 16, 19, 29, 30]);
  const moneyColumns = new Set([13, 22, 23]);
  const integerColumns = new Set([6, 12, 14, 17, 20, 23]);
  for (let index = 0; index < workers.length; index += 1) {
    const row = DATA_FIRST_ROW + index;
    const excelRow = row + 1;
    const range = formulaRangeForMatrixRow(days, workers.length, excelRow);
    const summary = summaries[index];
    const acceptedAdjustments = workbookAdjustmentMap(data, workers[index].employeeId);
    const adjustment50 = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste HH50 (minutos)", summary.overtime50Minutes, 1_440);
    const adjustment100 = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste HH100 (minutos)", summary.overtime100Minutes, 1_440);
    const adjustmentBonus = numericWorkbookAdjustment(acceptedAdjustments, "Ajuste bono (CLP)", summary.bonusAmount, 1);
    const formulas: Array<[number, string, number | string]> = [
      [6, `COUNTIF(${range},"P")`, countMatrixCode(index, ["P"])],
      [8, `AD${excelRow}+R${excelRow}/1440`, minutesToExcelDuration(summary.overtime50Minutes + adjustment50)],
      [9, `AE${excelRow}+U${excelRow}/1440`, minutesToExcelDuration(summary.overtime100Minutes + adjustment100)],
      [13, `W${excelRow}+X${excelRow}`, summary.bonusAmount + adjustmentBonus],
    ];
    for (const [column, formula, value] of formulas) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) {
        cell.f = formula;
        cell.v = value;
        cell.t = typeof value === "number" ? "n" : "s";
      }
    }

    const readyLabel = data.reportingPeriodStatus === "CLOSED"
      ? "CERRADO"
      : data.reportingPeriodStatus === "READY_TO_CLOSE"
        ? "APROBADO POR RR. HH."
        : "LISTO PARA REVISIÓN RR. HH.";
    const statusFormula = period.type !== "PAGO"
      ? '"REVISAR"'
      : `IF(OR($O${excelRow}>0,COUNTIF('CONTROL_PENDIENTES'!$A$5:$A$${Math.max(5, 4 + pendingItems.length)},"GLOBAL")>0,COUNTIF(${range},"~?")>0,AND($R${excelRow}<>0,LEN(TRIM($S${excelRow}))=0),AND($U${excelRow}<>0,LEN(TRIM($V${excelRow}))=0),AND($X${excelRow}<>0,LEN(TRIM($Y${excelRow}))=0),$I${excelRow}<0,$J${excelRow}<0,$N${excelRow}<0),"BLOQUEADO","${readyLabel}")`;
    const semaforoCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
    if (semaforoCell) {
      semaforoCell.f = statusFormula;
      semaforoCell.v = cachedStatuses[index];
      semaforoCell.t = "str";
    }

    for (let column = 0; column < SUMMARY_HEADERS_2026.length; column += 1) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })] ??
        (summarySheet[XLSX.utils.encode_cell({ r: row, c: column })] = { v: "", t: "s" });
      const input = [17, 18, 20, 21, 23, 24].includes(column);
      cell.s = {
        ...(input ? INPUT_STYLE : solidFill(row % 2 === 0 ? "F7F9FC" : "FFFFFF")),
        alignment: { vertical: "center", horizontal: [0, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(column) ? "center" : "left", wrapText: [0, 2, 5, 15, 18, 21, 24, 25, 26, 31, 32].includes(column) },
        border: THIN_BOTTOM_BORDER,
      };
      if (durationColumns.has(column) && typeof cell.v === "number") cell.z = DURATION_TOTAL_FORMAT;
      if (moneyColumns.has(column) && typeof cell.v === "number") cell.z = MONEY_FORMAT;
      if (integerColumns.has(column) && typeof cell.v === "number") cell.z = INTEGER_FORMAT;
    }
  }

  const summaryTotalExcelRow = summaryTotalRowIndex + 1;
  const firstDataExcelRow = DATA_FIRST_ROW + 1;
  const numericTotalColumns = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 23, 29, 30];
  for (let column = 0; column < SUMMARY_HEADERS_2026.length; column += 1) {
    const ref = XLSX.utils.encode_cell({ r: summaryTotalRowIndex, c: column });
    const cell = summarySheet[ref] ?? (summarySheet[ref] = { v: "", t: "s" });
    cell.s = { ...solidFill("D9EAF7"), font: { bold: true, color: { rgb: "17365D" } }, border: THIN_BOTTOM_BORDER, alignment: { vertical: "center", horizontal: column >= 5 ? "center" : "left" } };
    if (workers.length > 0 && numericTotalColumns.includes(column)) {
      const letter = XLSX.utils.encode_col(column);
      cell.f = `SUM(${letter}${firstDataExcelRow}:${letter}${summaryDataLastExcelRow})`;
      cell.v = summaries.reduce((total, summary, workerIndex) => {
        const accepted = workbookAdjustmentMap(data, workers[workerIndex].employeeId);
        const adjustment50 = numericWorkbookAdjustment(accepted, "Ajuste HH50 (minutos)", summary.overtime50Minutes, 1_440);
        const adjustment100 = numericWorkbookAdjustment(accepted, "Ajuste HH100 (minutos)", summary.overtime100Minutes, 1_440);
        const adjustmentBonus = numericWorkbookAdjustment(accepted, "Ajuste bono (CLP)", summary.bonusAmount, 1);
        if (column === 6) return total + countMatrixCode(workerIndex, ["P"]);
        if (column === 7) return total + minutesToExcelDuration(summary.ordinaryRecordedMinutes);
        if (column === 8) return total + minutesToExcelDuration(summary.overtime50Minutes + adjustment50);
        if (column === 9) return total + minutesToExcelDuration(summary.overtime100Minutes + adjustment100);
        if (column === 16) return total + minutesToExcelDuration(summary.overtime50RealMinutes);
        if (column === 19) return total + minutesToExcelDuration(summary.overtime100RealMinutes);
        if (column === 29) return total + minutesToExcelDuration(summary.overtime50Minutes);
        if (column === 30) return total + minutesToExcelDuration(summary.overtime100Minutes);
        if (column === 10) return total + minutesToExcelDuration(summary.lateMinutes);
        if (column === 11) return total + minutesToExcelDuration(summary.earlyDepartureMinutes);
        if (column === 12) return total + summary.bonusDays;
        if (column === 13) return total + summary.bonusAmount + adjustmentBonus;
        if (column === 17) return total + adjustment50;
        if (column === 20) return total + adjustment100;
        if (column === 22) return total + summary.bonusAmount;
        if (column === 23) return total + adjustmentBonus;
        if (column === 14) return total + pendingCounts[workerIndex];
        return total;
      }, 0);
      cell.t = "n";
    }
    if (durationColumns.has(column) && typeof cell.v === "number") cell.z = DURATION_TOTAL_FORMAT;
    if (moneyColumns.has(column) && typeof cell.v === "number") cell.z = MONEY_FORMAT;
    if (integerColumns.has(column) && typeof cell.v === "number") cell.z = INTEGER_FORMAT;
  }
  const totalStatus = cachedStatuses.some((status) => status === "BLOQUEADO")
    ? "BLOQUEADO"
    : period.type === "PAGO" && workers.length > 0
      ? (data.reportingPeriodStatus === "CLOSED"
          ? "CERRADO"
          : data.reportingPeriodStatus === "READY_TO_CLOSE"
            ? "APROBADO POR RR. HH."
            : "LISTO PARA REVISIÓN RR. HH.")
      : "REVISAR";
  const totalStatusCell = summarySheet[`A${summaryTotalExcelRow}`];
  if (totalStatusCell) {
    totalStatusCell.v = totalStatus;
    totalStatusCell.t = "str";
    if (workers.length > 0) totalStatusCell.f = `IF(COUNTIF(A${firstDataExcelRow}:A${summaryDataLastExcelRow},"BLOQUEADO")>0,"BLOQUEADO","${totalStatus}")`;
  }

  // -----------------------------------------------------------------------
  // Hoja 2: excepciones que bloquean el cierre o requieren evidencia.

  const pendingRows: Cell[][] = [
    ["CONTROL DE PENDIENTES DE PRE-CIERRE"],
    [periodScopeLabel],
    [pendingItems.length > 0
      ? `${countedLabel(pendingItems.length, "incidencia pendiente", "incidencias pendientes")}. Deben resolverse en GESTORA y luego regenerar el libro. Se incluyen también ${countedLabel(controlItems.length - pendingItems.length, "incidencia resuelta", "incidencias resueltas")} como auditoría.`
      : `Sin bloqueos detectados por las reglas configuradas. ${countedLabel(controlItems.length, "incidencia resuelta", "incidencias resueltas")} ${controlItems.length === 1 ? "permanece" : "permanecen"} como auditoría. Esto no sustituye el cierre del período ni el snapshot histórico.`],
    [...PENDING_HEADERS_2026],
  ];
  if (controlItems.length === 0) {
    pendingRows.push(["", "", "", "", "", "", "", "", "", "Sin bloqueos detectados", "", "", "", "", "", "", "Confirmar cierre formal y conservar snapshot."]);
  } else {
    for (const item of controlItems) {
      pendingRows.push([
        item.scope,
        item.priority,
        item.state,
        item.employeeCode,
        item.employeeRut,
        item.workerName,
        item.area,
        item.costCenter,
        item.date ? calendarDateToExcelSerial(item.date) : "",
        item.issue,
        item.quantity,
        item.unit,
        item.responsible,
        item.decision,
        item.reason,
        item.resolvedAt,
        item.action,
      ]);
    }
  }
  const pendingSheet = XLSX.utils.aoa_to_sheet(pendingRows);
  applyWhiteCanvas(pendingSheet, pendingRows.length, PENDING_HEADERS_2026.length);
  pendingSheet["!cols"] = [
    { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 17 }, { wch: 15 },
    { wch: 30 }, { wch: 16 }, { wch: 18 }, { wch: 13 }, { wch: 38 },
    { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 28 },
    { wch: 18 }, { wch: 52 },
  ];
  pendingSheet["!rows"] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 34 }, { hpt: 34 }];
  pendingSheet["!merges"] = [0, 1, 2].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: PENDING_HEADERS_2026.length - 1 } }));
  pendingSheet["!autofilter"] = { ref: `A4:Q${Math.max(4, pendingRows.length)}` };
  if (pendingSheet.A1) pendingSheet.A1.s = { ...solidFill("FFFFFF"), font: { bold: true, sz: 16, color: { rgb: "17365D" } } };
  for (const ref of ["A2", "A3"]) {
    const cell = pendingSheet[ref];
    if (cell) cell.s = { ...solidFill(ref === "A3" && pendingItems.length > 0 ? "FFF2CC" : "FFFFFF"), font: { color: { rgb: "595959" }, italic: ref === "A3" }, alignment: { wrapText: true, vertical: "center" } };
  }
  styleHeaderRow(pendingSheet, 3, PENDING_HEADERS_2026.length);
  for (let row = 4; row < pendingRows.length; row += 1) {
    const isGlobal = pendingRows[row][0] === "GLOBAL";
    const isResolved = pendingRows[row][2] === "RESUELTO";
    for (let column = 0; column < PENDING_HEADERS_2026.length; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = pendingSheet[ref] ?? (pendingSheet[ref] = { v: "", t: "s" });
      cell.s = { ...solidFill(isResolved ? "E2F0D9" : isGlobal ? "FFF2CC" : row % 2 === 0 ? "F7F9FC" : "FFFFFF"), alignment: { vertical: "center", horizontal: column === 10 ? "right" : "left", wrapText: column === 9 || column === 14 || column === 16 }, border: THIN_BOTTOM_BORDER };
    }
    const dateCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 8 })];
    if (dateCell && typeof dateCell.v === "number") dateCell.z = "dd/mm/yyyy";
    const resolvedDateCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 15 })];
    if (resolvedDateCell && typeof resolvedDateCell.v === "number") resolvedDateCell.z = "dd/mm/yyyy";
    const quantityCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 10 })];
    if (quantityCell && typeof quantityCell.v === "number") quantityCell.z = INTEGER_FORMAT;
  }

  // -----------------------------------------------------------------------
  // Hoja 3: datos puros, una fila por persona y una columna por día 16-15.

  const matrixHeaders: Cell[] = ["RUT", "Código Workera", "Nombre completo", "Jornada", "Centro de costo"];
  for (const date of days) matrixHeaders.push(calendarDateToExcelSerial(date));
  const matrixRows: Cell[][] = [
    ["MATRIZ DIARIA DE ASISTENCIA · RESPALDO"],
    [`Período: ${period.label} · ${overallStatus}`],
    [`Códigos oficiales: ${LEGEND.map(([code, meaning]) => `${code}=${meaning}`).join(" | ")}`],
    ["Una fila por trabajador. '?' identifica un dato no definitivo y siempre bloquea el pago."],
    matrixHeaders,
  ];
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const worker = workers[workerIndex];
    const row: Cell[] = [worker.employeeRut ?? "", worker.employeeCode, worker.workerName, scheduleText(worker, data), worker.costCenter ?? ""];
    row.push(...matrixCodesByWorker[workerIndex]);
    matrixRows.push(row);
  }
  const matrixSheet = XLSX.utils.aoa_to_sheet(matrixRows);
  applyWhiteCanvas(matrixSheet, matrixRows.length, MATRIX_FIRST_DAY_COL + days.length);
  matrixSheet["!cols"] = [
    { wch: 15 }, { wch: 17 }, { wch: 30 }, { wch: 32 }, { wch: 18 },
    ...days.map(() => ({ wch: 7.5 })),
  ];
  matrixSheet["!rows"] = [{ hpt: 26 }, { hpt: 22 }, { hpt: 44 }, { hpt: 22 }, { hpt: 44 }];
  matrixSheet["!merges"] = [0, 1, 2, 3].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: MATRIX_FIRST_DAY_COL + days.length - 1 } }));
  matrixSheet["!autofilter"] = { ref: `A5:${XLSX.utils.encode_col(MATRIX_FIRST_DAY_COL + days.length - 1)}${summaryDataLastExcelRow}` };
  if (matrixSheet.A1) matrixSheet.A1.s = { ...solidFill("FFFFFF"), font: { bold: true, sz: 16, color: { rgb: "17365D" } } };
  for (const ref of ["A2", "A3", "A4"]) {
    const cell = matrixSheet[ref];
    if (cell) cell.s = { ...solidFill("FFFFFF"), font: { color: { rgb: "595959" }, italic: ref === "A4" }, alignment: { wrapText: true, vertical: "center" } };
  }
  styleHeaderRow(matrixSheet, 4, MATRIX_FIRST_DAY_COL + days.length);
  for (let column = MATRIX_FIRST_DAY_COL; column < MATRIX_FIRST_DAY_COL + days.length; column += 1) {
    const header = matrixSheet[XLSX.utils.encode_cell({ r: 4, c: column })];
    if (header) {
      header.z = "dd-mmm";
      header.s = { ...HEADER_STYLE, alignment: { horizontal: "center", vertical: "center", textRotation: 90 } };
    }
  }
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const row = DATA_FIRST_ROW + workerIndex;
    const worker = workers[workerIndex];
    for (let column = 0; column < MATRIX_FIRST_DAY_COL + days.length; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = matrixSheet[ref] ?? (matrixSheet[ref] = { v: "", t: "s" });
      let fill = row % 2 === 0 ? "F7F9FC" : "FFFFFF";
      if (column >= MATRIX_FIRST_DAY_COL) {
        const date = days[column - MATRIX_FIRST_DAY_COL];
        const code = String(cell.v ?? "");
        fill = code === MISSING_STATUS_CODE || statusRequiresPayrollReview(code)
          ? "FCE4D6"
          : beforeHire(worker, date)
            ? "E7E6E6"
            : worker.exemptDates.has(date) || (worker.scheduleCoveredDates.has(date) && !worker.scheduledDates.has(date))
              ? "F2F2F2"
              : data.holidays.has(date)
                ? "E4DFEC"
                : isWeekend(date)
                  ? "FFF2CC"
                  : !worker.scheduleCoveredDates.has(date)
                    ? "FFF2CC"
                    : fill;
      }
      cell.s = { ...solidFill(fill), alignment: { vertical: "center", horizontal: column >= MATRIX_FIRST_DAY_COL ? "center" : "left", wrapText: column === 2 || column === 3 }, border: THIN_BOTTOM_BORDER };
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summarySheet, "RESUMEN_NOMINA");
  XLSX.utils.book_append_sheet(workbook, pendingSheet, "CONTROL_PENDIENTES");
  XLSX.utils.book_append_sheet(workbook, matrixSheet, "MATRIZ_DIARIA_SABANA");
  const metadataSheet = XLSX.utils.aoa_to_sheet([
    ["Esquema", "GESTORA_PRENOMINA_2026_V2"],
    ["Empresa", data.companyId ?? ""],
    ["Tipo de período", period.type],
    ["Inicio", period.startDate],
    ["Fin", period.endDate],
    ["Mes de remuneración", period.type === "PAGO" ? period.endDate.slice(0, 7) : ""],
    ["Versión base", data.workbookBaseVersionId ?? "ORIGEN_ACTUAL"],
    ["Cantidad padrón autorizado", data.rosterCount ?? ""],
    ["Huella padrón autorizado", data.rosterSha256 ?? ""],
  ]);
  metadataSheet["!protect"] = { password: "GESTORA", selectLockedCells: true, selectUnlockedCells: true };
  XLSX.utils.book_append_sheet(workbook, metadataSheet, "_GESTORA_TECNICA");
  workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 0 }, { Hidden: 2 }] };
  workbook.Props = {
    Title: `Pre-nómina asistencia ${period.label}`,
    Subject: period.type === "PAGO"
      ? "Resumen de pre-nómina, pendientes y respaldo diario 16-15"
      : "Control de asistencia, pendientes y respaldo diario",
    Company: "GESTORA",
    Comments: "Archivo editable de control. El snapshot histórico debe persistirse al cerrar el período.",
  };

  const written = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }) as Uint8Array | ArrayBuffer;
  const raw = written instanceof Uint8Array ? written : new Uint8Array(written);
  const lastWorkerExcelRow = 5 + workers.length;
  const matrixDailyRange = `${XLSX.utils.encode_col(MATRIX_FIRST_DAY_COL)}6:${XLSX.utils.encode_col(MATRIX_FIRST_DAY_COL + days.length - 1)}${lastWorkerExcelRow}`;
  return applyXlsxPresentation(raw, [
    {
      sheetIndex: 1,
      freeze: { xSplit: 5, ySplit: 5, topLeftCell: "F6" },
      print: { orientation: "landscape", fitToWidth: 1 },
      conditionalFormats: workers.length === 0 ? [] : [
        { sqref: `R6:R${lastWorkerExcelRow}`, formula: "R6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `U6:U${lastWorkerExcelRow}`, formula: "U6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `X6:X${lastWorkerExcelRow}`, formula: "X6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `S6:S${lastWorkerExcelRow}`, formula: "AND($R6<>0,LEN(TRIM($S6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `V6:V${lastWorkerExcelRow}`, formula: "AND($U6<>0,LEN(TRIM($V6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `Y6:Y${lastWorkerExcelRow}`, formula: "AND($X6<>0,LEN(TRIM($Y6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `I6:J${lastWorkerExcelRow}`, formula: "I6<0", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `N6:N${lastWorkerExcelRow}`, formula: "N6<0", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `A6:A${lastWorkerExcelRow}`, formula: '$A6="BLOQUEADO"', fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `A6:A${lastWorkerExcelRow}`, formula: '$A6="LISTO PARA REVISIÓN RR. HH."', fillRgb: "E2F0D9", fontRgb: "375623" },
        { sqref: `A6:A${lastWorkerExcelRow}`, formula: '$A6="APROBADO POR RR. HH."', fillRgb: "D9EAD3", fontRgb: "274E13" },
        { sqref: `A6:A${lastWorkerExcelRow}`, formula: '$A6="CERRADO"', fillRgb: "D9EAF7", fontRgb: "17365D" },
      ],
    },
    { sheetIndex: 2, freeze: { xSplit: 4, ySplit: 4, topLeftCell: "E5" }, print: { orientation: "landscape", fitToWidth: 1 } },
    {
      sheetIndex: 3,
      freeze: { xSplit: 5, ySplit: 5, topLeftCell: "F6" },
      print: { orientation: "landscape", fitToWidth: 1 },
      conditionalFormats: workers.length === 0 ? [] : [
        { sqref: matrixDailyRange, formula: 'F6="?"', fillRgb: "FCE4D6", fontRgb: "9C0006" },
        { sqref: matrixDailyRange, formula: 'F6="R"', fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: matrixDailyRange, formula: 'F6="F"', fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: matrixDailyRange, formula: 'OR(F6="L",F6="L-M")', fillRgb: "E4DFEC", fontRgb: "7030A0" },
        { sqref: matrixDailyRange, formula: 'F6="V"', fillRgb: "DDEBF7", fontRgb: "1F4E78" },
        { sqref: matrixDailyRange, formula: 'OR(F6="F-P",F6="F-J",F6="P-L",F6="P-M")', fillRgb: "DDEBF7", fontRgb: "1F4E78" },
      ],
    },
  ]);
}
