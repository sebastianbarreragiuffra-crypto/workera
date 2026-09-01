import "server-only";
import * as XLSX from "xlsx";
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
 * Se generan 7 filas por trabajador: Asistencia, Faltas, Vacaciones, Licencia,
 * Atrasos, HH 50%, HH 100%. VIATICOS queda deliberadamente fuera: el sistema
 * no tiene ninguna fuente de ese dato y una fila siempre vacía sería peor que
 * su ausencia.
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

const MONTH_SHORT = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

interface EmployeeRow {
  id: string;
  display_name: string;
  employee_groups: { code: AreaCode } | { code: AreaCode }[] | null;
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

// ---------------------------------------------------------------------------

export interface AttendanceExportDay {
  statusCode: string;
  lateMinutes: number;
  overtime50Minutes: number;
  overtime100Minutes: number;
}

export interface AttendanceExportWorker {
  employeeId: string;
  workerName: string;
  area: AreaCode;
  /** Indexado por fecha `YYYY-MM-DD`. Un día ausente equivale a "sin novedad". */
  days: Map<string, AttendanceExportDay>;
}

export interface AttendanceExportData {
  period: AttendanceExportPeriod;
  days: string[];
  workers: AttendanceExportWorker[];
  /** Feriados legales dentro del período -- su columna va en blanco, igual que un fin de semana. */
  holidays: ReadonlySet<string>;
}

function emptyDay(): AttendanceExportDay {
  return { statusCode: MISSING_STATUS_CODE, lateMinutes: 0, overtime50Minutes: 0, overtime100Minutes: 0 };
}

export async function buildAttendanceExportData(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  period: AttendanceExportPeriod
): Promise<AttendanceExportData> {
  const allowedAreas = areasVisibleToRole(callerRole);

  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("id, display_name, employee_groups!employees_company_group_fkey!inner(code)")
    .eq("active", true)
    .in("employee_groups.code", allowedAreas)
    .order("display_name");
  if (employeesError) throw new Error(`buildAttendanceExportData: fallo listando empleados: ${employeesError.message}`);

  const scoped = (employees ?? [])
    .map((row) => ({ id: row.id, displayName: row.display_name, area: areaOf(row as unknown as EmployeeRow) }))
    .filter((e): e is { id: string; displayName: string; area: AreaCode } => e.area !== null);

  const employeeIds = scoped.map((e) => e.id);
  const days = calendarDaysBetween(period.startDate, period.endDate);
  const holidays = await loadHolidaySet(supabase, period.startDate, period.endDate).catch(() => new Set<string>());

  const workers: AttendanceExportWorker[] = scoped.map((e) => ({
    employeeId: e.id,
    workerName: e.displayName,
    area: e.area,
    days: new Map(),
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

  if (employeeIds.length === 0) return { period, days, workers, holidays };

  const [statusRes, lateRes, overtimeRes] = await Promise.all([
    supabase
      .from("attendance_status_records")
      .select("employee_id, work_date, attendance_statuses(code)")
      .in("employee_id", employeeIds)
      .gte("work_date", period.startDate)
      .lte("work_date", period.endDate)
      .eq("is_current", true),
    supabase
      .from("late_arrival_records")
      .select("employee_id, work_date, detected_minutes, late_arrival_decisions(payroll_minutes, is_current)")
      .in("employee_id", employeeIds)
      .gte("work_date", period.startDate)
      .lte("work_date", period.endDate)
      .eq("is_current", true),
    supabase
      .from("overtime_records")
      .select("employee_id, work_date, overtime_types(code), overtime_decisions(approved_minutes, decision_status, is_current)")
      .in("employee_id", employeeIds)
      .gte("work_date", period.startDate)
      .lte("work_date", period.endDate)
      .eq("is_current", true),
  ]);

  for (const res of [statusRes, lateRes, overtimeRes]) {
    if (res.error) throw new Error(`buildAttendanceExportData: fallo leyendo datos del período: ${res.error.message}`);
  }

  for (const row of statusRes.data ?? []) {
    const code = unwrap(row.attendance_statuses as { code: string } | { code: string }[] | null)?.code;
    const day = cell(row.employee_id, row.work_date);
    if (day && code) day.statusCode = code;
  }

  // Atraso: si ya hay decisión vigente manda lo que efectivamente va a
  // liquidación (un atraso justificado descuenta 0); si todavía no se decide,
  // se muestran los minutos detectados -- que es justo lo que está pendiente.
  for (const row of lateRes.data ?? []) {
    const decisions = (row.late_arrival_decisions ?? []) as { payroll_minutes: number; is_current: boolean }[];
    const current = decisions.find((d) => d.is_current);
    const day = cell(row.employee_id, row.work_date);
    if (day) day.lateMinutes = current ? current.payroll_minutes : row.detected_minutes;
  }

  // Horas extra: SOLO las aprobadas. Un candidato sin decisión todavía no es
  // hora extra pagable, y esta planilla es la que se compara contra la de
  // remuneraciones -- mostrar candidatos ahí inflaría el número.
  for (const row of overtimeRes.data ?? []) {
    const typeCode = unwrap(row.overtime_types as { code: string } | { code: string }[] | null)?.code;
    const decisions = (row.overtime_decisions ?? []) as { approved_minutes: number; decision_status: string; is_current: boolean }[];
    const current = decisions.find((d) => d.is_current);
    if (!current || current.approved_minutes <= 0) continue;

    const day = cell(row.employee_id, row.work_date);
    if (!day) continue;
    if (typeCode === "OVERTIME_100") day.overtime100Minutes += current.approved_minutes;
    else day.overtime50Minutes += current.approved_minutes;
  }

  return { period, days, workers, holidays };
}

// ---------------------------------------------------------------------------
// Construcción del libro

/** Excel guarda una duración como fracción de día; el formato `[h]:mm:ss` la muestra como h:mm:ss. */
function minutesToExcelDuration(minutes: number): number {
  return minutes / (24 * 60);
}

const BLOCK_ROWS = ["Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "HH 50%", "HH 100%"] as const;
const DURATION_ROWS = new Set<string>(["Atrasos", "HH 50%", "HH 100%"]);

/** Columna donde arrancan los días: A=nombre, B=etiqueta, C=total. */
const FIRST_DAY_COL = 3;
const HEADER_ROWS = 14; // título + 11 de leyenda + fila de meses + fila de días

type Cell = string | number | null;

export function buildAttendanceExportWorkbook(data: AttendanceExportData): Uint8Array {
  const { days, workers, period, holidays } = data;
  const rows: Cell[][] = [];

  rows.push(["PLANILLA DE ASISTENCIA PERSONAL DE PRODUCCIÓN Y ADMINISTRACIÓN", null, period.label]);
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

  const merges: XLSX.Range[] = [];

  for (const worker of workers) {
    const blockStart = rows.length;

    for (const label of BLOCK_ROWS) {
      const line: Cell[] = [label === "Asistencia" ? worker.workerName : null, label, null];
      let total = 0;

      for (const date of days) {
        // Fin de semana o feriado legal en blanco: la empresa no opera. Un 0
        // ahí sugeriría una jornada de cero horas en vez de un día no laboral,
        // y si el trabajador SÍ trabajó el feriado sus horas ya salen abajo en
        // HH 100%.
        if (isWeekend(date) || holidays.has(date)) {
          line.push(null);
          continue;
        }

        const day = worker.days.get(date) ?? emptyDay();
        let value: Cell = null;

        if (label === "Asistencia") {
          value = day.statusCode;
        } else if (label === "Faltas") {
          if (FALTA_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Vacaciones") {
          if (VACACIONES_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Licencia") {
          if (LICENCIA_CODES.has(day.statusCode)) { value = 1; total += 1; }
        } else if (label === "Atrasos") {
          if (day.lateMinutes > 0) { value = minutesToExcelDuration(day.lateMinutes); total += day.lateMinutes; }
        } else if (label === "HH 50%") {
          if (day.overtime50Minutes > 0) { value = minutesToExcelDuration(day.overtime50Minutes); total += day.overtime50Minutes; }
        } else if (label === "HH 100%") {
          if (day.overtime100Minutes > 0) { value = minutesToExcelDuration(day.overtime100Minutes); total += day.overtime100Minutes; }
        }

        line.push(value);
      }

      // Asistencia: días trabajados = hábiles del período menos vacaciones y
      // licencia, misma definición que la fórmula de la planilla original.
      if (label === "Asistencia") {
        const businessDays = days.filter((d) => !isWeekend(d) && !holidays.has(d));
        const absent = businessDays.filter((d) => {
          const code = worker.days.get(d)?.statusCode ?? MISSING_STATUS_CODE;
          return VACACIONES_CODES.has(code) || LICENCIA_CODES.has(code);
        }).length;
        line[2] = businessDays.length - absent;
      } else {
        line[2] = DURATION_ROWS.has(label) ? minutesToExcelDuration(total) : total;
      }

      rows.push(line);
    }

    // Nombre combinado sobre todo el bloque, como en la planilla original.
    merges.push({ s: { r: blockStart, c: 0 }, e: { r: blockStart + BLOCK_ROWS.length - 1, c: 0 } });
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);

  // Formato de duración en las filas de tiempo (incluida su celda de total).
  for (let r = HEADER_ROWS; r < rows.length; r += 1) {
    const label = rows[r][1];
    if (typeof label !== "string" || !DURATION_ROWS.has(label)) continue;
    for (let c = 2; c < FIRST_DAY_COL + days.length; c += 1) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const target = sheet[ref];
      if (target && typeof target.v === "number") target.z = "[h]:mm:ss";
    }
  }

  sheet["!merges"] = merges;
  sheet["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 10 }, ...days.map(() => ({ wch: 5 }))];
  sheet["!freeze"] = { xSplit: 3, ySplit: HEADER_ROWS };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Asistencia");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
