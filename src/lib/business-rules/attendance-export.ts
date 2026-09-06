import "server-only";
import * as XLSX from "xlsx-js-style";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../access/scope";
import { applyXlsxPresentation } from "../excel/xlsx-postprocess";
import type { AttendanceExportPeriod } from "./attendance-export-periods";
import { loadHolidaySet } from "./holidays";

/**
 * Exportador de pre-nómina de asistencia, estándar 2026.
 *
 * Sustituye definitivamente el libro histórico de diez filas por trabajador
 * por tres tablas sin celdas combinadas en su área de datos:
 * `RESUMEN_NOMINA` (una fila por persona), `CONTROL_PENDIENTES` (excepciones
 * accionables) y `MATRIZ_DIARIA_SABANA` (una fila por persona y una columna
 * por fecha). El corte de pago es siempre 16–15.
 *
 * El libro se genera desde datos vivos para incluir el padrón completo. Nunca
 * inventa un estado: un día exigible sin dato definitivo sale `?`, nunca P/F
 * supuesto. El cierre inmutable debe persistirse como snapshot en una fase
 * posterior; este archivo editable es el artefacto operativo de pre-nómina.
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
  ["R", "RECUPERAN HORAS"],
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
    costCenter: null,
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
  const [
    statusPages,
    latePages,
    earlyDeparturePages,
    overtimePages,
    missingPunchPages,
    absencePages,
    organizationAssignmentPages,
  ] = await Promise.all([
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

  const statusRows = statusPages.flat();
  const lateRows = latePages.flat();
  const earlyDepartureRows = earlyDeparturePages.flat();
  const overtimeRows = overtimePages.flat();
  const missingPunchRows = missingPunchPages.flat();
  const absenceRows = absencePages.flat();

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

/** Los totales del período pueden superar 24 horas y nunca deben volver a cero. */
const DURATION_TOTAL_FORMAT = "[h]:mm";
const MONEY_FORMAT = '"$"#,##0';
const INTEGER_FORMAT = "#,##0;[Red]-#,##0";
const MATRIX_FIRST_DAY_COL = 5;
const DATA_FIRST_ROW = 5; // índice base 0; en Excel los datos comienzan en la fila 6.

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

const INPUT_STYLE = solidFill("DDEBF7");
const HEADER_STYLE = {
  ...solidFill("1F4E78"),
  font: { bold: true, color: { rgb: "FFFFFF" } },
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

interface WorkerExportSummary {
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtime50Minutes: number;
  overtime100Minutes: number;
  bonusDays: number;
  bonusAmount: number;
  bonusDates: string[];
  reviewDates: string[];
  observations: string;
}

function summarizeWorker(worker: AttendanceExportWorker, data: AttendanceExportData): WorkerExportSummary {
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

  return {
    lateMinutes,
    earlyDepartureMinutes,
    overtime50Minutes,
    overtime100Minutes,
    bonusDays: bonusDates.size,
    bonusAmount,
    bonusDates: [...bonusDates].sort(),
    reviewDates: [...reviewDates].sort(),
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
    ? `; procesamiento incompleto en ${engineProblemDates.length} fecha(s)`
    : "";
  if (data.period.type === "PAGO" && data.reportingPeriodStatus !== "CLOSED") {
    return `BORRADOR — el período 16-15 no está cerrado${engineNote}${pendingWorkers > 0 ? ` y ${pendingWorkers} persona(s) requieren revisión` : ""}`;
  }
  if (engineProblemDates.length > 0) {
    return `REVISAR — procesamiento incompleto en ${engineProblemDates.length} fecha(s)${pendingWorkers > 0 ? ` y ${pendingWorkers} persona(s) con pendientes propios` : ""}`;
  }
  if (pendingTotal > 0) {
    return `REVISAR — ${pendingTotal} incidencia(s)${pendingWorkers > 0 ? ` en ${pendingWorkers} persona(s)` : " global(es)"}`;
  }
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
  employeeId: string;
  employeeCode: string;
  employeeRut: string;
  workerName: string;
  costCenter: string;
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
      employeeId: "",
      employeeCode: "",
      employeeRut: "",
      workerName: "",
      costCenter: "",
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
        global("", `${label} duplicado en ${duplicates.size} valor(es)`, `Corregir la unicidad de ${label.toLowerCase()} antes de liquidar.`);
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
      employeeId: worker.employeeId,
      employeeCode: worker.employeeCode,
      employeeRut: worker.employeeRut ?? "",
      workerName: worker.workerName,
      costCenter: worker.costCenter ?? "",
      date,
      issue,
      quantity,
      unit,
      action,
    });
  };

  for (const worker of data.workers) {
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

const SUMMARY_HEADERS_2026 = [
  "RUT",
  "Nombre_Completo",
  "Horario_Jornada",
  "Centro_Costo",
  "Codigo_Workera",
  "Dias_Codigo_P_No_Pagables",
  "Dias_Falta_F",
  "Dias_Licencia_Comun_L",
  "Dias_Licencia_Mutual_LM",
  "Dias_Vacaciones_V",
  "Total_HH_50",
  "Ajuste_50_Minutos",
  "HH50_Final",
  "Motivo_Ajuste_50",
  "Total_HH_100",
  "Ajuste_100_Minutos",
  "HH100_Final",
  "Motivo_Ajuste_100",
  "Total_Atrasos",
  "Total_Salidas_Anticipadas",
  "Total_Viaticos_Bonos",
  "Ajuste_Bonos_CLP",
  "Bonos_Final",
  "Motivo_Ajuste_Bonos",
  "Dias_Con_Bono",
  "Fechas_Bono",
  "Pendientes_Workera",
  "Fechas_Pendientes",
  "Semaforo_Cierre",
  "Observaciones",
] as const;

const PENDING_HEADERS_2026 = [
  "Alcance",
  "Codigo_Workera",
  "RUT",
  "Nombre_Completo",
  "Centro_Costo",
  "Fecha",
  "Incidencia",
  "Cantidad",
  "Unidad",
  "Accion_Requerida",
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
  return `INDEX('MATRIZ_DIARIA_SABANA'!$${first}$6:$${last}$${lastWorkerRow},MATCH($E${excelRow},'MATRIZ_DIARIA_SABANA'!$B$6:$B$${lastWorkerRow},0),0)`;
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
): "APROBADO PARA PAGO" | "BLOQUEADO POR PENDIENTES" | "SOLO CONTROL - NO PAGO" {
  if (data.period.type !== "PAGO") return "SOLO CONTROL - NO PAGO";
  return pendingCount > 0 || globalPendingCount > 0
    ? "BLOQUEADO POR PENDIENTES"
    : "APROBADO PARA PAGO";
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
  const pendingCountsByEmployee = pendingCountByEmployee(pendingItems);
  const globalPendingCount = pendingItems.filter((item) => item.scope === "GLOBAL").length;
  const overallStatus = exportStatusLabel(data, pendingItems);
  const matrixCodesByWorker = workers.map((worker) =>
    days.map((date) => dailyMatrixCode(worker, date, worker.days.get(date) ?? emptyDay(), data))
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
      "Las horas y bonos automáticos provienen solo de decisiones definitivas. Los días P son códigos de presencia, no días pagables. Centro_Costo corresponde a la unidad organizacional primaria vigente al día 15. Ajuste_50/100 se ingresa en minutos enteros (+/-); bonos se ajustan en CLP. Todo ajuste exige motivo. 'Sin pendientes' no reemplaza el cierre formal ni un snapshot inmutable.",
    ],
    [...SUMMARY_HEADERS_2026],
  ];

  const pendingCounts: number[] = [];
  const cachedStatuses: ReturnType<typeof safeSummaryStatus>[] = [];
  for (let index = 0; index < workers.length; index += 1) {
    const worker = workers[index];
    const summary = summaries[index];
    const presentDays = countMatrixCode(index, ["P"]);
    const pendingCount = pendingCountsByEmployee.get(worker.employeeId) ?? 0;
    const status = safeSummaryStatus(data, pendingCount, globalPendingCount);
    pendingCounts.push(pendingCount);
    cachedStatuses.push(status);
    summaryRows.push([
      worker.employeeRut ?? "",
      worker.workerName,
      scheduleText(worker, data),
      worker.costCenter ?? "",
      worker.employeeCode,
      presentDays, // valor cacheado; la fórmula auditable se asigna abajo.
      countMatrixCode(index, ["F"]),
      countMatrixCode(index, ["L"]),
      countMatrixCode(index, ["L-M"]),
      countMatrixCode(index, ["V"]),
      minutesToExcelDuration(summary.overtime50Minutes),
      0,
      minutesToExcelDuration(summary.overtime50Minutes),
      "",
      minutesToExcelDuration(summary.overtime100Minutes),
      0,
      minutesToExcelDuration(summary.overtime100Minutes),
      "",
      minutesToExcelDuration(summary.lateMinutes),
      minutesToExcelDuration(summary.earlyDepartureMinutes),
      summary.bonusAmount,
      0,
      summary.bonusAmount,
      "",
      summary.bonusDays,
      shortReviewDates(summary.bonusDates),
      pendingCount,
      shortReviewDates(summary.reviewDates),
      status,
      summary.observations,
    ]);
  }

  const summaryTotalRowIndex = summaryRows.length;
  summaryRows.push(["", "TOTAL EMPRESA", "", "", "", ...Array<Cell>(25).fill("")]);
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  applyWhiteCanvas(summarySheet, summaryRows.length, SUMMARY_HEADERS_2026.length);
  summarySheet["!cols"] = [
    { wch: 15 }, { wch: 30 }, { wch: 32 }, { wch: 18 }, { wch: 17 },
    { wch: 18 }, { wch: 15 }, { wch: 17 }, { wch: 19 }, { wch: 24 },
    { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 31 }, { wch: 16 },
    { wch: 21 }, { wch: 16 }, { wch: 32 }, { wch: 17 }, { wch: 26 },
    { wch: 23 }, { wch: 20 }, { wch: 17 }, { wch: 32 }, { wch: 15 },
    { wch: 23 }, { wch: 20 }, { wch: 22 }, { wch: 29 }, { wch: 52 },
  ];
  summarySheet["!rows"] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 22 }, { hpt: 48 }, { hpt: 42 }];
  summarySheet["!merges"] = [0, 1, 2, 3].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: SUMMARY_HEADERS_2026.length - 1 } }));
  const summaryDataLastExcelRow = workers.length > 0 ? 5 + workers.length : 5;
  summarySheet["!autofilter"] = { ref: `A5:AD${summaryDataLastExcelRow}` };

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

  const durationColumns = new Set([10, 12, 14, 16, 18, 19]);
  const moneyColumns = new Set([20, 21, 22]);
  const integerColumns = new Set([5, 6, 7, 8, 9, 11, 15, 24, 26]);
  for (let index = 0; index < workers.length; index += 1) {
    const row = DATA_FIRST_ROW + index;
    const excelRow = row + 1;
    const range = formulaRangeForMatrixRow(days, workers.length, excelRow);
    const summary = summaries[index];
    const formulas: Array<[number, string, number | string]> = [
      [5, `COUNTIF(${range},"P")`, countMatrixCode(index, ["P"])],
      [6, `COUNTIF(${range},"F")`, countMatrixCode(index, ["F"])],
      [7, `COUNTIF(${range},"L")`, countMatrixCode(index, ["L"])],
      [8, `COUNTIF(${range},"L-M")`, countMatrixCode(index, ["L-M"])],
      [9, `COUNTIF(${range},"V")`, countMatrixCode(index, ["V"])],
      [12, `K${excelRow}+L${excelRow}/1440`, minutesToExcelDuration(summary.overtime50Minutes)],
      [16, `O${excelRow}+P${excelRow}/1440`, minutesToExcelDuration(summary.overtime100Minutes)],
      [22, `U${excelRow}+V${excelRow}`, summary.bonusAmount],
    ];
    for (const [column, formula, value] of formulas) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) {
        cell.f = formula;
        cell.v = value;
        cell.t = typeof value === "number" ? "n" : "s";
      }
    }

    const statusFormula = period.type !== "PAGO"
      ? '"SOLO CONTROL - NO PAGO"'
      : `IF(OR($AA${excelRow}>0,COUNTIF('CONTROL_PENDIENTES'!$A$5:$A$${Math.max(5, 4 + pendingItems.length)},"GLOBAL")>0,COUNTIF(${range},"~?")>0,AND($L${excelRow}<>0,LEN(TRIM($N${excelRow}))=0),AND($P${excelRow}<>0,LEN(TRIM($R${excelRow}))=0),AND($V${excelRow}<>0,LEN(TRIM($X${excelRow}))=0),$M${excelRow}<0,$Q${excelRow}<0,$W${excelRow}<0),"BLOQUEADO POR PENDIENTES","APROBADO PARA PAGO")`;
    const semaforoCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 28 })];
    if (semaforoCell) {
      semaforoCell.f = statusFormula;
      semaforoCell.v = cachedStatuses[index];
      semaforoCell.t = "str";
    }

    for (let column = 0; column < SUMMARY_HEADERS_2026.length; column += 1) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })] ??
        (summarySheet[XLSX.utils.encode_cell({ r: row, c: column })] = { v: "", t: "s" });
      const input = column === 11 || column === 13 || column === 15 || column === 17 || column === 21 || column === 23;
      cell.s = {
        ...(input ? INPUT_STYLE : solidFill(row % 2 === 0 ? "F7F9FC" : "FFFFFF")),
        alignment: { vertical: "center", horizontal: column >= 5 && column <= 28 ? "center" : "left", wrapText: [2, 13, 17, 23, 25, 27, 28, 29].includes(column) },
        border: THIN_BOTTOM_BORDER,
      };
      if (durationColumns.has(column) && typeof cell.v === "number") cell.z = DURATION_TOTAL_FORMAT;
      if (moneyColumns.has(column) && typeof cell.v === "number") cell.z = MONEY_FORMAT;
      if (integerColumns.has(column) && typeof cell.v === "number") cell.z = INTEGER_FORMAT;
    }
  }

  const summaryTotalExcelRow = summaryTotalRowIndex + 1;
  const firstDataExcelRow = DATA_FIRST_ROW + 1;
  const numericTotalColumns = [5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 19, 20, 21, 22, 24, 26];
  for (let column = 0; column < SUMMARY_HEADERS_2026.length; column += 1) {
    const ref = XLSX.utils.encode_cell({ r: summaryTotalRowIndex, c: column });
    const cell = summarySheet[ref] ?? (summarySheet[ref] = { v: "", t: "s" });
    cell.s = { ...solidFill("D9EAF7"), font: { bold: true, color: { rgb: "17365D" } }, border: THIN_BOTTOM_BORDER, alignment: { vertical: "center", horizontal: column >= 5 ? "center" : "left" } };
    if (workers.length > 0 && numericTotalColumns.includes(column)) {
      const letter = XLSX.utils.encode_col(column);
      cell.f = `SUM(${letter}${firstDataExcelRow}:${letter}${summaryDataLastExcelRow})`;
      cell.v = summaries.reduce((total, summary, workerIndex) => {
        if (column === 5) return total + countMatrixCode(workerIndex, ["P"]);
        if (column === 6) return total + countMatrixCode(workerIndex, ["F"]);
        if (column === 7) return total + countMatrixCode(workerIndex, ["L"]);
        if (column === 8) return total + countMatrixCode(workerIndex, ["L-M"]);
        if (column === 9) return total + countMatrixCode(workerIndex, ["V"]);
        if ([10, 12].includes(column)) return total + minutesToExcelDuration(summary.overtime50Minutes);
        if ([14, 16].includes(column)) return total + minutesToExcelDuration(summary.overtime100Minutes);
        if (column === 18) return total + minutesToExcelDuration(summary.lateMinutes);
        if (column === 19) return total + minutesToExcelDuration(summary.earlyDepartureMinutes);
        if ([20, 22].includes(column)) return total + summary.bonusAmount;
        if (column === 24) return total + summary.bonusDays;
        if (column === 26) return total + pendingCounts[workerIndex];
        return total;
      }, 0);
      cell.t = "n";
    }
    if (durationColumns.has(column) && typeof cell.v === "number") cell.z = DURATION_TOTAL_FORMAT;
    if (moneyColumns.has(column) && typeof cell.v === "number") cell.z = MONEY_FORMAT;
    if (integerColumns.has(column) && typeof cell.v === "number") cell.z = INTEGER_FORMAT;
  }
  const totalStatus = cachedStatuses.some((status) => status === "BLOQUEADO POR PENDIENTES")
    ? "BLOQUEADO POR PENDIENTES"
    : period.type === "PAGO" && workers.length > 0
      ? "APROBADO PARA PAGO"
      : "SOLO CONTROL - NO PAGO";
  const totalStatusCell = summarySheet[`AC${summaryTotalExcelRow}`];
  if (totalStatusCell) {
    totalStatusCell.v = totalStatus;
    totalStatusCell.t = "str";
    if (workers.length > 0) totalStatusCell.f = `IF(COUNTIF(AC${firstDataExcelRow}:AC${summaryDataLastExcelRow},"BLOQUEADO*")>0,"BLOQUEADO POR PENDIENTES",IF(COUNTIF(AC${firstDataExcelRow}:AC${summaryDataLastExcelRow},"APROBADO PARA PAGO")=${workers.length},"APROBADO PARA PAGO","SOLO CONTROL - NO PAGO"))`;
  }

  // -----------------------------------------------------------------------
  // Hoja 2: excepciones que bloquean el cierre o requieren evidencia.

  const pendingRows: Cell[][] = [
    ["CONTROL DE PENDIENTES DE PRE-CIERRE"],
    [periodScopeLabel],
    [pendingItems.length > 0
      ? `${pendingItems.length} incidencia(s) detectada(s). Deben resolverse en GESTORA y luego regenerar el libro.`
      : "Sin bloqueos detectados por las reglas configuradas. Esto no sustituye el cierre del período ni el snapshot histórico."],
    [...PENDING_HEADERS_2026],
  ];
  if (pendingItems.length === 0) {
    pendingRows.push(["", "", "", "", "", "", "Sin bloqueos detectados", "", "", "Confirmar cierre formal y conservar snapshot."]);
  } else {
    for (const item of pendingItems) {
      pendingRows.push([
        item.scope,
        item.employeeCode,
        item.employeeRut,
        item.workerName,
        item.costCenter,
        item.date ? calendarDateToExcelSerial(item.date) : "",
        item.issue,
        item.quantity,
        item.unit,
        item.action,
      ]);
    }
  }
  const pendingSheet = XLSX.utils.aoa_to_sheet(pendingRows);
  applyWhiteCanvas(pendingSheet, pendingRows.length, PENDING_HEADERS_2026.length);
  pendingSheet["!cols"] = [
    { wch: 12 }, { wch: 17 }, { wch: 15 }, { wch: 30 }, { wch: 18 },
    { wch: 13 }, { wch: 38 }, { wch: 12 }, { wch: 10 }, { wch: 52 },
  ];
  pendingSheet["!rows"] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 34 }, { hpt: 34 }];
  pendingSheet["!merges"] = [0, 1, 2].map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: PENDING_HEADERS_2026.length - 1 } }));
  pendingSheet["!autofilter"] = { ref: `A4:J${Math.max(4, pendingRows.length)}` };
  if (pendingSheet.A1) pendingSheet.A1.s = { ...solidFill("FFFFFF"), font: { bold: true, sz: 16, color: { rgb: "17365D" } } };
  for (const ref of ["A2", "A3"]) {
    const cell = pendingSheet[ref];
    if (cell) cell.s = { ...solidFill(ref === "A3" && pendingItems.length > 0 ? "FFF2CC" : "FFFFFF"), font: { color: { rgb: "595959" }, italic: ref === "A3" }, alignment: { wrapText: true, vertical: "center" } };
  }
  styleHeaderRow(pendingSheet, 3, PENDING_HEADERS_2026.length);
  for (let row = 4; row < pendingRows.length; row += 1) {
    const isGlobal = pendingRows[row][0] === "GLOBAL";
    for (let column = 0; column < PENDING_HEADERS_2026.length; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = pendingSheet[ref] ?? (pendingSheet[ref] = { v: "", t: "s" });
      cell.s = { ...solidFill(isGlobal ? "FFF2CC" : row % 2 === 0 ? "F7F9FC" : "FFFFFF"), alignment: { vertical: "center", horizontal: column === 7 ? "right" : "left", wrapText: column === 6 || column === 9 }, border: THIN_BOTTOM_BORDER };
    }
    const dateCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 5 })];
    if (dateCell && typeof dateCell.v === "number") dateCell.z = "dd/mm/yyyy";
    const quantityCell = pendingSheet[XLSX.utils.encode_cell({ r: row, c: 7 })];
    if (quantityCell && typeof quantityCell.v === "number") quantityCell.z = INTEGER_FORMAT;
  }

  // -----------------------------------------------------------------------
  // Hoja 3: datos puros, una fila por persona y una columna por día 16-15.

  const matrixHeaders: Cell[] = ["RUT", "Codigo_Workera", "Nombre_Completo", "Horario_Jornada", "Centro_Costo"];
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
      conditionalFormats: workers.length === 0 ? [] : [
        { sqref: `L6:L${lastWorkerExcelRow}`, formula: "L6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `P6:P${lastWorkerExcelRow}`, formula: "P6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `V6:V${lastWorkerExcelRow}`, formula: "V6<>0", fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: `N6:N${lastWorkerExcelRow}`, formula: "AND($L6<>0,LEN(TRIM($N6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `R6:R${lastWorkerExcelRow}`, formula: "AND($P6<>0,LEN(TRIM($R6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `X6:X${lastWorkerExcelRow}`, formula: "AND($V6<>0,LEN(TRIM($X6))=0)", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `M6:M${lastWorkerExcelRow}`, formula: "M6<0", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `Q6:Q${lastWorkerExcelRow}`, formula: "Q6<0", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `W6:W${lastWorkerExcelRow}`, formula: "W6<0", fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `AC6:AC${lastWorkerExcelRow}`, formula: '$AC6="BLOQUEADO POR PENDIENTES"', fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: `AC6:AC${lastWorkerExcelRow}`, formula: '$AC6="APROBADO PARA PAGO"', fillRgb: "E2F0D9", fontRgb: "375623" },
      ],
    },
    { sheetIndex: 2, freeze: { xSplit: 4, ySplit: 4, topLeftCell: "E5" } },
    {
      sheetIndex: 3,
      freeze: { xSplit: 5, ySplit: 5, topLeftCell: "F6" },
      conditionalFormats: workers.length === 0 ? [] : [
        { sqref: matrixDailyRange, formula: 'F6="?"', fillRgb: "FCE4D6", fontRgb: "9C0006" },
        { sqref: matrixDailyRange, formula: 'F6="R"', fillRgb: "FFF2CC", fontRgb: "9C5700" },
        { sqref: matrixDailyRange, formula: 'F6="F"', fillRgb: "F4CCCC", fontRgb: "9C0006" },
        { sqref: matrixDailyRange, formula: 'OR(F6="L",F6="L-M")', fillRgb: "E4DFEC", fontRgb: "7030A0" },
        { sqref: matrixDailyRange, formula: 'F6="V"', fillRgb: "DDEBF7", fontRgb: "1F4E78" },
        { sqref: matrixDailyRange, formula: 'OR(F6="F-P",F6="F-J",F6="P-L",F6="P-M")', fillRgb: "DDEBF7", fontRgb: "1F4E78" },
      ],
    },
  ]);
}
