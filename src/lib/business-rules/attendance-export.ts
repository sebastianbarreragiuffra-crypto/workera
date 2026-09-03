import "server-only";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx-js-style";
import { unzipSync, zipSync, strToU8 } from "fflate";
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
 * Se generan 8 filas por trabajador: Asistencia, Faltas, Vacaciones, Licencia,
 * Atrasos, HH 50%, HH 100% y VIATICOS, igual que la planilla de RRHH. Como el
 * sistema no tiene una fuente de viáticos, esa fila queda disponible y vacía.
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

export interface TemplateWorker {
  label: string;
  tokens: Set<string>;
}

function normalizeTemplateToken(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * La planilla de referencia de RRHH lleva nombres reales de trabajadores, así
 * que está deliberadamente FUERA del repo (`.gitignore`). El código nunca debe
 * asumir que existe: si falta, se usa el libro generado y se deja constancia
 * en el log en vez de entregar un archivo distinto sin avisar.
 */
const TEMPLATE_PATH = path.join(process.cwd(), "public", "templates", "asistencia-mockup.xlsx");

function reportTemplateUnavailable(reason: string): null {
  console.error("[attendance-export] plantilla de referencia no disponible; se genera el libro estándar", reason);
  return null;
}

function readAttendanceTemplateWorkers(): TemplateWorker[] | null {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) return reportTemplateUnavailable("archivo ausente");
    const workbook = XLSX.readFile(TEMPLATE_PATH, { cellStyles: true, cellNF: true });
    const sheet = workbook.Sheets["NOV25"] ?? workbook.Sheets[workbook.SheetNames[0]];
    const starts = new Set((sheet["!merges"] ?? []).filter((m) => m.s.c === 0 && m.s.r >= HEADER_ROWS).map((m) => m.s.r));
    const rows: TemplateWorker[] = [];
    for (const row of [...starts].sort((a, b) => a - b)) {
      const value = sheet[XLSX.utils.encode_cell({ r: row, c: 0 })]?.v;
      if (typeof value !== "string" || !value.trim()) continue;
      const firstLine = value.split(/\r?\n/, 1)[0];
      const namePart = firstLine.split(/\s+(?=(?:LUNES|MARTES|MIERCOLES|JUEVES|VIERNES|INGRESO|HORARIO)\b)/i, 1)[0];
      const tokens = new Set(namePart.split(/\s+/).map(normalizeTemplateToken).filter(Boolean));
      if (tokens.size >= 2) rows.push({ label: value, tokens });
    }
    return rows.length ? rows : reportTemplateUnavailable("sin bloques de trabajador reconocibles");
  } catch (err) {
    return reportTemplateUnavailable(err instanceof Error ? err.message : "error leyendo la plantilla");
  }
}

/** Exportada solo para pruebas: el padrón nunca debe depender de la plantilla. */
export function applyTemplateWorkerScope(
  workers: AttendanceExportWorker[],
  template: TemplateWorker[] | null,
  includeUnmatched: boolean
): AttendanceExportWorker[] {
  if (!template) return workers;
  const tokensByEmployee = new Map(
    workers.map((worker) => [worker.employeeId, new Set(worker.workerName.split(/\s+/).map(normalizeTemplateToken).filter(Boolean))])
  );
  const ordered: AttendanceExportWorker[] = [];
  const used = new Set<string>();
  for (const [index, entry] of template.entries()) {
    const match = workers.find(
      (worker) => !used.has(worker.employeeId) && [...entry.tokens].every((token) => tokensByEmployee.get(worker.employeeId)?.has(token))
    );
    if (match) {
      used.add(match.employeeId);
      ordered.push({ ...match, workerName: entry.label });
    } else if (includeUnmatched) {
      // Conserva la fila del mockup aunque Workera todavía no entregue ese
      // trabajador (por ejemplo, alguien excluido temporalmente). La fila
      // queda sin marcaciones, pero no se altera el diseño ni el padrón.
      ordered.push({
        employeeId: `template:${index}`,
        workerName: entry.label,
        area: workers[0]?.area ?? "ADMINISTRATION",
        days: new Map(),
      });
    }
  }

  // La plantilla define ORDEN y ETIQUETA, nunca el padrón. Un trabajador
  // vigente que no figure en el mockup (una contratación posterior, por
  // ejemplo) se agrega igual al final: omitirlo lo dejaría fuera de un
  // documento que alimenta remuneraciones sin ninguna señal visible.
  for (const worker of workers) {
    if (!used.has(worker.employeeId)) ordered.push(worker);
  }
  return ordered;
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
  period: AttendanceExportPeriod,
  useReferenceTemplate = false
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

  const days = calendarDaysBetween(period.startDate, period.endDate);
  const holidays = await loadHolidaySet(supabase, period.startDate, period.endDate).catch(() => new Set<string>());

  const workers: AttendanceExportWorker[] = scoped.map((e) => ({
    employeeId: e.id,
    workerName: e.displayName,
    area: e.area,
    days: new Map(),
  }));
  const scopedWorkers = useReferenceTemplate
    ? applyTemplateWorkerScope(workers, readAttendanceTemplateWorkers(), callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH")
    : workers;
  const byId = new Map(scopedWorkers.map((w) => [w.employeeId, w]));

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

  const scopedEmployeeIds = scopedWorkers.map((worker) => worker.employeeId).filter((id) => !id.startsWith("template:"));
  if (scopedEmployeeIds.length === 0) return { period, days, workers: scopedWorkers, holidays };

  const [statusRes, lateRes, overtimeRes] = await Promise.all([
    supabase
      .from("attendance_status_records")
      .select("employee_id, work_date, attendance_statuses(code)")
      .in("employee_id", scopedEmployeeIds)
      .gte("work_date", period.startDate)
      .lte("work_date", period.endDate)
      .eq("is_current", true),
    supabase
      .from("late_arrival_records")
      .select("employee_id, work_date, detected_minutes, late_arrival_decisions(payroll_minutes, is_current)")
      .in("employee_id", scopedEmployeeIds)
      .gte("work_date", period.startDate)
      .lte("work_date", period.endDate)
      .eq("is_current", true),
    supabase
      .from("overtime_records")
      .select("employee_id, work_date, overtime_types(code), overtime_decisions(approved_minutes, decision_status, is_current)")
      .in("employee_id", scopedEmployeeIds)
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

  return { period, days, workers: scopedWorkers, holidays };
}

// ---------------------------------------------------------------------------
// Construcción del libro

/** Excel guarda una duración como fracción de día; el formato `[h]:mm:ss` la muestra como h:mm:ss. */
function minutesToExcelDuration(minutes: number): number {
  return minutes / (24 * 60);
}

const BLOCK_ROWS = ["Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "HH 50%", "HH 100%", "VIATICOS"] as const;
const DURATION_ROWS = new Set<string>(["Atrasos", "HH 50%", "HH 100%"]);

/** Columna donde arrancan los días: A=nombre, B=etiqueta, C=total. */
const FIRST_DAY_COL = 3;
const HEADER_ROWS = 14; // título + 11 de leyenda + fila de meses + fila de días

const solidFill = (rgb: string) => ({ fill: { patternType: "solid", fgColor: { rgb }, bgColor: { rgb: "000000" } } });
const FILLED_CELL_STYLE = solidFill("FF9900");
const EMPTY_DAY_STYLE = solidFill("99CC00");
const HEADER_STYLE = solidFill("CCFFFF");
const UNKNOWN_LEGEND_STYLE = solidFill("00CCFF");
const VIATICOS_STYLE = solidFill("FFCC00");

type Cell = string | number | null;

export function buildAttendanceExportWorkbook(data: AttendanceExportData, useReferenceTemplate = false): Uint8Array {
  const templateWorkbook = useReferenceTemplate ? buildWorkbookFromReferenceTemplate(data) : null;
  if (templateWorkbook) return templateWorkbook;

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
      } else if (label === "VIATICOS") {
        line[2] = 0;
      } else {
        line[2] = DURATION_ROWS.has(label) ? minutesToExcelDuration(total) : total;
      }

      rows.push(line);
    }

    // Nombre combinado sobre todo el bloque, como en la planilla original.
    merges.push({ s: { r: blockStart, c: 0 }, e: { r: blockStart + BLOCK_ROWS.length - 1, c: 0 } });
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);

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

  // Fórmulas auditables en la columna de totales, siguiendo el patrón del
  // mockup: asistencia = días hábiles - faltas - licencia; el resto suma su
  // fila diaria. Se conserva también el valor calculado para que Excel y
  // lectores que no recalculan fórmulas muestren el total inmediatamente.
  const businessDays = days.filter((d) => !isWeekend(d) && !holidays.has(d)).length;
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const blockStart = HEADER_ROWS + workerIndex * BLOCK_ROWS.length;
    const assistanceTotal = XLSX.utils.encode_cell({ r: blockStart, c: 2 });
    const absencesTotal = XLSX.utils.encode_cell({ r: blockStart + 1, c: 2 });
    const licenseTotal = XLSX.utils.encode_cell({ r: blockStart + 3, c: 2 });
    const assistanceCell = sheet[assistanceTotal];
    if (assistanceCell) assistanceCell.f = `${businessDays}-${absencesTotal}-${licenseTotal}`;
    for (let offset = 1; offset < BLOCK_ROWS.length; offset += 1) {
      const totalCell = sheet[XLSX.utils.encode_cell({ r: blockStart + offset, c: 2 })];
      if (totalCell) totalCell.f = `SUM(${XLSX.utils.encode_cell({ r: blockStart + offset, c: FIRST_DAY_COL })}:${XLSX.utils.encode_cell({ r: blockStart + offset, c: FIRST_DAY_COL + days.length - 1 })})`;
    }

    for (let offset = 0; offset < BLOCK_ROWS.length; offset += 1) {
      const row = blockStart + offset;
      const label = BLOCK_ROWS[offset];
      const labelCell = sheet[XLSX.utils.encode_cell({ r: row, c: 1 })];
      if (labelCell && label === "VIATICOS") labelCell.s = VIATICOS_STYLE;
      for (let c = FIRST_DAY_COL; c < FIRST_DAY_COL + days.length; c += 1) {
        const ref = XLSX.utils.encode_cell({ r: row, c });
        const dayDate = days[c - FIRST_DAY_COL];
        // Los fines de semana/feriados se conservan como celdas realmente
        // vacías, igual que en el mockup y en los lectores que distinguen
        // null de una cadena vacía.
        if (!sheet[ref] && (isWeekend(dayDate) || holidays.has(dayDate))) continue;
        const target = sheet[ref] ?? (sheet[ref] = { v: "", t: "s" });
        target.s = target.v === "" || target.v === null || target.v === undefined ? EMPTY_DAY_STYLE : FILLED_CELL_STYLE;
      }
    }
  }

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

  // Viáticos se expresa como importe, aunque hoy no exista una fuente que lo
  // rellene automáticamente.
  for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
    const row = HEADER_ROWS + workerIndex * BLOCK_ROWS.length + BLOCK_ROWS.length - 1;
    const total = sheet[XLSX.utils.encode_cell({ r: row, c: 2 })];
    if (total) total.z = '"$"#,##0';
  }

  sheet["!merges"] = merges;
  sheet["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 10 }, ...days.map(() => ({ wch: 5 }))];
  sheet["!freeze"] = { xSplit: 3, ySplit: HEADER_ROWS };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Asistencia");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

/**
 * Actualiza directamente el libro entregado por RRHH. No reconstruye hojas ni
 * filas: preserva las siete hojas, merges, anchos, fórmulas y estilos del XLS
 * original y solo reemplaza el calendario/datos de asistencia de NOV25.
 */
function buildWorkbookFromReferenceTemplate(data: AttendanceExportData): Uint8Array | null {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) return reportTemplateUnavailable("archivo ausente");
    const workbook = XLSX.readFile(TEMPLATE_PATH, { cellStyles: true, cellNF: true, cellFormula: true });
    const sheet = workbook.Sheets["NOV25"] ?? workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return reportTemplateUnavailable("la plantilla no tiene hojas legibles");

    // SheetJS lee los estilos del XLS antiguo en forma plana; el escritor de
    // estilos necesita el mismo contenido dentro de `fill`.
    for (const currentSheet of Object.values(workbook.Sheets)) {
      for (const ref of Object.keys(currentSheet)) {
        if (ref.startsWith("!")) continue;
        const cell = currentSheet[ref];
        if (cell?.s?.patternType) {
          cell.s = { fill: { patternType: cell.s.patternType, fgColor: cell.s.fgColor, bgColor: cell.s.bgColor } };
        }
      }
    }

    const blockMerges = (sheet["!merges"] ?? []).filter((merge) => merge.s.c === 0 && merge.s.r >= HEADER_ROWS).sort((a, b) => a.s.r - b.s.r);
    const workersByLabel = new Map(data.workers.map((worker) => [worker.workerName, worker]));

    // Fail-safe: este camino RELLENA los bloques que ya trae la plantilla y
    // nunca le agrega filas. Si el período incluye a alguien sin bloque
    // propio, escribir este libro lo dejaría fuera de un documento que
    // alimenta remuneraciones. Ante esa duda se devuelve null y gana el libro
    // generado, que siempre contiene al padrón completo.
    const templateLabels = new Set(
      blockMerges
        .map((merge) => sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: 0 })]?.v)
        .filter((label): label is string => typeof label === "string")
    );
    if (data.workers.some((worker) => !templateLabels.has(worker.workerName))) {
      return reportTemplateUnavailable("hay trabajadores vigentes sin bloque en la plantilla");
    }

    const templateDays = data.days.length;
    const monthRow = 12;
    const dayRow = 13;
    const summaryRows: Array<{ name: string; rows: Record<string, number> }> = [];

    // El período descargado siempre ocupa D en adelante, igual que el
    // mockup. Las columnas restantes del libro se conservan intactas.
    let lastMonth = "";
    for (let i = 0; i < templateDays; i += 1) {
      const date = data.days[i];
      const [, month, day] = date.split("-");
      const monthLabel = MONTH_SHORT[Number(month) - 1];
      const monthCell = sheet[XLSX.utils.encode_cell({ r: monthRow, c: FIRST_DAY_COL + i })] ?? (sheet[XLSX.utils.encode_cell({ r: monthRow, c: FIRST_DAY_COL + i })] = { v: "", t: "s" });
      monthCell.v = monthLabel !== lastMonth ? monthLabel : "";
      monthCell.t = "s";
      monthCell.s = HEADER_STYLE;
      lastMonth = monthLabel;
      const dayCell = sheet[XLSX.utils.encode_cell({ r: dayRow, c: FIRST_DAY_COL + i })] ?? (sheet[XLSX.utils.encode_cell({ r: dayRow, c: FIRST_DAY_COL + i })] = { v: Number(day), t: "n" });
      dayCell.v = Number(day);
      dayCell.t = "n";
      dayCell.s = HEADER_STYLE;
    }

    for (const merge of blockMerges) {
      const nameCell = sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: 0 })];
      const templateLabel = typeof nameCell?.v === "string" ? nameCell.v : "";
      const worker = workersByLabel.get(templateLabel);
      const rowByLabel = new Map<string, number>();
      for (let row = merge.s.r; row <= merge.e.r; row += 1) {
        const label = sheet[XLSX.utils.encode_cell({ r: row, c: 1 })]?.v;
        if (typeof label === "string") rowByLabel.set(label, row);
      }
      const businessDays = data.days.filter((date) => !isWeekend(date) && !data.holidays.has(date)).length;
      const getDay = (date: string): AttendanceExportDay => worker?.days.get(date) ?? emptyDay();
      for (const [label, row] of rowByLabel) {
        const totalCell = sheet[XLSX.utils.encode_cell({ r: row, c: 2 })] ?? (sheet[XLSX.utils.encode_cell({ r: row, c: 2 })] = { v: 0, t: "n" });
        const first = XLSX.utils.encode_cell({ r: row, c: FIRST_DAY_COL });
        const last = XLSX.utils.encode_cell({ r: row, c: FIRST_DAY_COL + templateDays - 1 });
        if (label === "Asistencia") {
          totalCell.v = businessDays;
          totalCell.f = `${businessDays}-C${row + 2}-C${row + 4}`;
          totalCell.t = "n";
        } else {
          totalCell.f = `SUM(${first}:${last})`;
          totalCell.t = "n";
          totalCell.v = 0;
        }
        for (let i = 0; i < templateDays; i += 1) {
          const date = data.days[i];
          const ref = XLSX.utils.encode_cell({ r: row, c: FIRST_DAY_COL + i });
          const cell = sheet[ref] ?? (sheet[ref] = { v: "", t: "s" });
          let value: string | number = "";
          const day = getDay(date);
          if (!isWeekend(date) && !data.holidays.has(date)) {
            if (label === "Asistencia") value = day.statusCode;
            else if (label === "Faltas" && FALTA_CODES.has(day.statusCode)) value = 1;
            else if (label === "Vacaciones" && VACACIONES_CODES.has(day.statusCode)) value = 1;
            else if (label === "Licencia" && LICENCIA_CODES.has(day.statusCode)) value = 1;
            else if (label === "Atrasos" && day.lateMinutes > 0) value = minutesToExcelDuration(day.lateMinutes);
            else if (label === "HH 50%" && day.overtime50Minutes > 0) value = minutesToExcelDuration(day.overtime50Minutes);
            else if (label === "HH 100%" && day.overtime100Minutes > 0) value = minutesToExcelDuration(day.overtime100Minutes);
          }
          cell.v = value;
          cell.t = typeof value === "number" ? "n" : "s";
          cell.f = undefined;
          cell.s = value === "" ? EMPTY_DAY_STYLE : FILLED_CELL_STYLE;
          if (DURATION_ROWS.has(label) && typeof value === "number") cell.z = "[h]:mm:ss";
        }
      }
      if (worker) {
        summaryRows.push({ name: templateLabel, rows: Object.fromEntries([...rowByLabel.entries()]) });
      }
    }

    const summary: XLSX.WorkSheet = {};
    const summaryHeaders = ["Trabajador", "Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "HH 50%", "HH 100%", "Viáticos"];
    summaryHeaders.forEach((value, c) => {
      summary[XLSX.utils.encode_cell({ r: 0, c })] = { v: value, t: "s", s: HEADER_STYLE };
    });
    summaryRows.forEach((entry, i) => {
      const r = i + 1;
      summary[XLSX.utils.encode_cell({ r, c: 0 })] = { v: entry.name, t: "s" };
      const labels = ["Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "HH 50%", "HH 100%", "VIATICOS"];
      labels.forEach((label, c) => {
        const sourceRow = entry.rows[label];
        const cell: XLSX.CellObject = { v: 0, t: "n", z: c >= 4 && c <= 6 ? "[h]:mm:ss" : "#,##0" };
        if (sourceRow !== undefined) cell.f = `'NOV25'!C${sourceRow + 1}`;
        summary[XLSX.utils.encode_cell({ r, c: c + 1 })] = cell;
      });
    });
    summary["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: summaryRows.length, c: summaryHeaders.length - 1 } });
    summary["!cols"] = summaryHeaders.map((_, c) => ({ wch: c === 0 ? 38 : 14 }));
    XLSX.utils.book_append_sheet(workbook, summary, "Resumen RRHH");
    workbook.SheetNames = ["Resumen RRHH", ...workbook.SheetNames.filter((name) => name !== "Resumen RRHH")];

    const output = XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true, bookSST: true }) as Uint8Array;
    // The supplied workbook is an old BIFF .xls file with an .xlsx extension.
    // During conversion xlsx-js-style can emit outline `level` attributes that
    // Excel desktop rejects (it may remain forever on “Starting…”). Remove
    // those non-standard attributes while keeping every other XML/style node.
    const archive = unzipSync(output);
    for (const name of Object.keys(archive)) {
      if (!name.endsWith(".xml")) continue;
      const xml = Buffer.from(archive[name]).toString("utf8").replace(/ level="[^"]*"/g, "");
      archive[name] = strToU8(xml);
    }
    return zipSync(archive, { level: 6 });
  } catch (err) {
    return reportTemplateUnavailable(err instanceof Error ? err.message : "error escribiendo el libro");
  }
}
