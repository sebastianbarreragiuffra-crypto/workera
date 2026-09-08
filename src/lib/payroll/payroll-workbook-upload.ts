import "server-only";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx-js-style";

export const PAYROLL_WORKBOOK_LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 250,
  maxSheets: 8,
  maxRows: 5_000,
  maxColumns: 100,
  maxCells: 200_000,
} as const;

export type PayrollWorkbookChangeKind = "VALUE" | "FORMULA" | "FORMAT";
export interface PayrollWorkbookChange {
  sheet: string;
  cell: string;
  stableKey: string | null;
  previous: string | number | boolean | null;
  next: string | number | boolean | null;
  kind: PayrollWorkbookChangeKind;
  consequence: "AJUSTE_EMPRESARIAL" | "CONSERVAR_ARCHIVO_SIN_EJECUTAR";
  employeeId?: string | null;
  employeeName?: string | null;
  workDate?: string | null;
  fieldCode?: string | null;
  conflictResolution?: "KEEP_RRHH" | "ACCEPT_WORKERA" | "THIRD_VALUE";
  conflictReason?: string;
  /** Automático confiable contra el que RR. HH. decidió el ajuste. */
  sourceValueAtComparison?: string | number | boolean | null;
}
export interface PayrollWorkbookConflictResolution {
  stableKey: string;
  choice: "KEEP_RRHH" | "ACCEPT_WORKERA" | "THIRD_VALUE";
  thirdValue?: string | number | null;
  reason: string;
}

export interface PayrollWorkbookConflictInput {
  stableKey: string;
  employeeId: string;
  employeeName: string;
  workDate: string | null;
  fieldCode: string;
  valueKind: "MINUTES" | "CLP" | "CODE";
  currentWorkeraValue: string | number;
  rrhhFinalValue: string | number;
}
export interface PayrollWorkbookIdentity {
  schema: string;
  companyId: string;
  periodType: "DIARIO" | "SEMANAL" | "QUINCENAL" | "PAGO";
  periodStart: string;
  periodEnd: string;
  payrollMonth: string;
  baseVersion: string;
}

const OFFICIAL_VISIBLE_SHEETS = ["RESUMEN_NOMINA", "CONTROL_PENDIENTES", "MATRIZ_DIARIA_SABANA"] as const;
const TECHNICAL_SHEET = "_GESTORA_TECNICA";
const BUSINESS_ADJUSTMENT_COLUMNS = [
  { column: 17, header: "Ajuste HH50 (minutos)" },
  { column: 18, header: "Motivo ajuste HH50" },
  { column: 20, header: "Ajuste HH100 (minutos)" },
  { column: 21, header: "Motivo ajuste HH100" },
  { column: 23, header: "Ajuste bono (CLP)" },
  { column: 24, header: "Motivo ajuste bono" },
] as const;
const STRUCTURAL_SHEET_FIELDS = ["!cols", "!rows", "!merges", "!autofilter"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_DAILY_CODES = new Set(["P", "F", "F-P", "F-J", "P-L", "P-M", "V", "L", "L-M", "?"]);
const UNSAFE_FORMULA_FUNCTION = /\b(?:WEBSERVICE|FILTERXML|RTD|CALL|REGISTER\.ID|EXEC|HYPERLINK|IMAGE|DDE)\s*\(/i;
const EXTERNAL_FORMULA_TARGET = /(?:https?|ftp|file):\/\/|\\\\|\[[^\]]+\](?:[^!]+)!/i;
const DDE_FORMULA_COMMAND = /\|[^!]{0,512}!/i;

function fail(message: string): never { throw new Error(`Archivo de pre-nómina inválido: ${message}`); }
function u16(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0; }

/** Lee el directorio central sin descomprimir para detener ZIP bombs antes de SheetJS. */
export function inspectXlsxContainer(bytes: Uint8Array): void {
  if (bytes.length > PAYROLL_WORKBOOK_LIMITS.maxBytes) fail("supera 15 MB.");
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) fail("la firma no corresponde a un XLSX.");
  let entries = 0; let uncompressed = 0;
  for (let offset = 0; offset + 46 <= bytes.length;) {
    if (u32(bytes, offset) !== 0x02014b50) { offset += 1; continue; }
    entries += 1;
    uncompressed += u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28); const extraLength = u16(bytes, offset + 30); const commentLength = u16(bytes, offset + 32);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) fail("contiene una ruta ZIP insegura.");
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries === 0) fail("no contiene un directorio ZIP válido.");
  if (entries > PAYROLL_WORKBOOK_LIMITS.maxEntries) fail("contiene demasiados archivos internos.");
  if (uncompressed > PAYROLL_WORKBOOK_LIMITS.maxUncompressedBytes) fail("su contenido descomprimido excede 50 MB.");
}

function normalizedValue(cell: XLSX.CellObject | undefined): string | number | boolean | null {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  return cell.v instanceof Date ? cell.v.toISOString() : cell.v as string | number | boolean;
}
function styleSignature(cell: XLSX.CellObject | undefined): string {
  return JSON.stringify(cell?.s ?? null);
}
function structureSignature(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function sheetVisibility(book: XLSX.WorkBook, index: number): number {
  return book.Workbook?.Sheets?.[index]?.Hidden ?? 0;
}
function validateWorkbookLayout(book: XLSX.WorkBook): void {
  const allowedSheets = new Set<string>([...OFFICIAL_VISIBLE_SHEETS, TECHNICAL_SHEET]);
  if (book.SheetNames.length !== allowedSheets.size || book.SheetNames.some((name) => !allowedSheets.has(name))) {
    fail("solo admite las tres hojas oficiales y la hoja técnica identificada.");
  }
  const technicalIndex = book.SheetNames.indexOf(TECHNICAL_SHEET);
  if (technicalIndex < 0) fail("falta la identificación técnica.");
  if (sheetVisibility(book, technicalIndex) !== 2) fail("la hoja técnica debe permanecer en estado veryHidden.");
  const visibleSheets = book.SheetNames.filter((_, index) => sheetVisibility(book, index) === 0);
  if (
    visibleSheets.length !== OFFICIAL_VISIBLE_SHEETS.length
    || !OFFICIAL_VISIBLE_SHEETS.every((sheetName) => visibleSheets.includes(sheetName))
  ) {
    fail("debe contener exactamente las tres hojas visibles oficiales.");
  }
}

function validateWorkbookFormulaSafety(book: XLSX.WorkBook): void {
  const isUnsafe = (value: string) =>
    UNSAFE_FORMULA_FUNCTION.test(value)
    || EXTERNAL_FORMULA_TARGET.test(value)
    || DDE_FORMULA_COMMAND.test(value);
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    for (const [cellReference, cell] of Object.entries(sheet)) {
      if (!/^[A-Z]+\d+$/.test(cellReference) || !cell || typeof cell !== "object") continue;
      const formula = (cell as XLSX.CellObject).f;
      if (typeof formula !== "string") continue;
      if (isUnsafe(formula)) {
        fail(`contiene una fórmula externa o potencialmente ejecutable en ${sheetName}!${cellReference}.`);
      }
    }
  }
  for (const definedName of book.Workbook?.Names ?? []) {
    if (typeof definedName.Ref === "string" && isUnsafe(definedName.Ref)) {
      fail(`contiene un nombre definido externo o potencialmente ejecutable (${definedName.Name}).`);
    }
  }
}
function readIdentity(book: XLSX.WorkBook): PayrollWorkbookIdentity {
  const sheet = book.Sheets[TECHNICAL_SHEET];
  if (!sheet) fail("falta la identificación técnica.");
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false });
  const values = new Map(rows.map((row) => [String(row[0] ?? ""), String(row[1] ?? "")]));
  const identity = { schema: values.get("Esquema") ?? "", companyId: values.get("Empresa") ?? "", periodType: values.get("Tipo de período") ?? "", periodStart: values.get("Inicio") ?? "", periodEnd: values.get("Fin") ?? "", payrollMonth: values.get("Mes de remuneración") ?? "", baseVersion: values.get("Versión base") ?? "" };
  if (identity.schema !== "GESTORA_PRENOMINA_2026_V2") fail("la versión del esquema no es compatible.");
  if (!UUID_PATTERN.test(identity.companyId)) fail("la empresa técnica no contiene un UUID válido.");
  if (!["DIARIO", "SEMANAL", "QUINCENAL", "PAGO"].includes(identity.periodType)) fail("el tipo de período técnico no es válido.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(identity.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(identity.periodEnd)) fail("el período técnico no es válido.");
  return identity as PayrollWorkbookIdentity;
}

export function parsePayrollWorkbook(bytes: Uint8Array): { book: XLSX.WorkBook; identity: PayrollWorkbookIdentity; sha256: string } {
  inspectXlsxContainer(bytes);
  const archive = unzipSync(bytes);
  const paths = Object.keys(archive);
  if (paths.some((path) =>
    /vbaProject|^xl\/(?:externalLinks|embeddings|activeX|ctrlProps|queryTables|pivotCache|model|webextensions)\/|^xl\/connections\.xml$|^(?:webextensions|customXml)\//i.test(path)
  )) {
    fail("contiene macros, conexiones, consultas, modelos, objetos incrustados, controles o vínculos externos.");
  }
  for (const path of paths.filter((candidate) => /\.rels$/i.test(candidate))) {
    const relationshipBytes = archive[path];
    // El generador oficial emite XML UTF-8. UTF-16 (con o sin BOM) inserta
    // NUL entre letras y podría evadir una inspección textual antes de que
    // Excel interprete la relación.
    if (
      relationshipBytes.includes(0)
      || (relationshipBytes[0] === 0xff && relationshipBytes[1] === 0xfe)
      || (relationshipBytes[0] === 0xfe && relationshipBytes[1] === 0xff)
    ) {
      fail("contiene una relación con codificación no permitida.");
    }
    const relationship = strFromU8(relationshipBytes);
    // En OOXML las relaciones internas omiten TargetMode. Rechazar el atributo
    // completo evita evasiones por espacios, saltos o entidades XML en su valor.
    if (/\bTargetMode\s*=/i.test(relationship)) fail("contiene una relación externa.");
  }
  const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellStyles: true, cellDates: false });
  if (book.SheetNames.length > PAYROLL_WORKBOOK_LIMITS.maxSheets) fail("contiene demasiadas hojas.");
  validateWorkbookLayout(book);
  validateWorkbookFormulaSafety(book);
  let cells = 0;
  for (const name of book.SheetNames) {
    const range = XLSX.utils.decode_range(book.Sheets[name]["!ref"] ?? "A1:A1");
    const rows = range.e.r - range.s.r + 1; const columns = range.e.c - range.s.c + 1;
    if (rows > PAYROLL_WORKBOOK_LIMITS.maxRows || columns > PAYROLL_WORKBOOK_LIMITS.maxColumns) fail(`la hoja ${name} excede los límites permitidos.`);
    cells += rows * columns;
  }
  if (cells > PAYROLL_WORKBOOK_LIMITS.maxCells) fail("contiene demasiadas celdas.");
  return { book, identity: readIdentity(book), sha256: createHash("sha256").update(bytes).digest("hex") };
}

interface StableCellIdentity {
  stableKey: string;
  employeeId: string;
  employeeName: string;
  workDate: string | null;
  fieldCode: string;
}

interface LogicalCell {
  cell: string;
  identity?: StableCellIdentity;
}

interface LogicalSheetIndex {
  cells: Map<string, LogicalCell>;
  coveredCells: Set<string>;
  rowOrder: string[];
  columnOrder: string[];
}

interface SummaryEmployee {
  id: string;
  code: string;
  name: string;
  row: number;
}

interface SummaryIndex extends LogicalSheetIndex {
  employeesById: Map<string, SummaryEmployee>;
  employeesByCode: Map<string, SummaryEmployee>;
  columnsByHeader: Map<string, number>;
}

function excelDate(value: string | number | boolean | null): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value !== "number") return null;
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return null;
  return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
}

const SUMMARY_HEADER_ROW = 4;
const FIRST_WORKER_ROW = 5;
const BUSINESS_HEADERS = new Set<string>(BUSINESS_ADJUSTMENT_COLUMNS.map(({ header }) => header));
const BUSINESS_SOURCE_HEADER = new Map<string, string>([
  ["Ajuste HH50 (minutos)", "HH50 aprobado automático"],
  ["Ajuste HH100 (minutos)", "HH100 aprobado automático"],
  ["Ajuste bono (CLP)", "Bono HE automático"],
]);

function rowHasContent(sheet: XLSX.WorkSheet, row: number, lastColumn: number): boolean {
  for (let column = 0; column <= lastColumn; column += 1) {
    if (normalizedValue(sheet[XLSX.utils.encode_cell({ r: row, c: column })]) !== null) return true;
  }
  return false;
}

function uniqueHeaders(
  sheet: XLSX.WorkSheet,
  label: string,
  keyForValue: (value: string | number | boolean | null) => string | null,
): { columnsByKey: Map<string, number>; order: string[]; coveredCells: Set<string> } {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const columnsByKey = new Map<string, number>();
  const order: string[] = [];
  const coveredCells = new Set<string>();
  for (let column = 0; column <= range.e.c; column += 1) {
    const cell = XLSX.utils.encode_cell({ r: SUMMARY_HEADER_ROW, c: column });
    const key = keyForValue(normalizedValue(sheet[cell]));
    if (!key) continue;
    if (columnsByKey.has(key)) fail(`${label} contiene el encabezado duplicado ${key}.`);
    columnsByKey.set(key, column);
    order.push(key);
    coveredCells.add(cell);
  }
  return { columnsByKey, order, coveredCells };
}

function indexSummary(book: XLSX.WorkBook, label: string): SummaryIndex {
  const sheet = book.Sheets.RESUMEN_NOMINA;
  if (!sheet) fail("falta RESUMEN_NOMINA para validar trabajadores.");
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const headers = uniqueHeaders(sheet, `RESUMEN_NOMINA ${label}`, (value) =>
    typeof value === "string" && value.trim() ? value.trim() : null
  );
  const idColumn = headers.columnsByKey.get("Identificador técnico");
  const codeColumn = headers.columnsByKey.get("Código Workera");
  const nameColumn = headers.columnsByKey.get("Nombre completo");
  if (idColumn === undefined || codeColumn === undefined || nameColumn === undefined) {
    fail(`RESUMEN_NOMINA ${label} no conserva los encabezados técnicos de trabajador.`);
  }

  const employeesById = new Map<string, SummaryEmployee>();
  const employeesByCode = new Map<string, SummaryEmployee>();
  const rowOrder: string[] = [];
  for (let row = FIRST_WORKER_ROW; row <= range.e.r; row += 1) {
    if (!rowHasContent(sheet, row, range.e.c)) continue;
    const idRef = XLSX.utils.encode_cell({ r: row, c: idColumn });
    const rawId = normalizedValue(sheet[idRef]);
    const rawCode = normalizedValue(sheet[XLSX.utils.encode_cell({ r: row, c: codeColumn })]);
    const rawName = normalizedValue(sheet[XLSX.utils.encode_cell({ r: row, c: nameColumn })]);
    // La única fila no personal dentro de la tabla oficial es TOTAL EMPRESA.
    // Blanquear a la vez UUID y código en una fila de trabajador no puede
    // convertirla silenciosamente en una nota ignorada.
    const idIsBlank = rawId === null || (typeof rawId === "string" && rawId.trim() === "");
    const codeIsBlank = rawCode === null || (typeof rawCode === "string" && rawCode.trim() === "");
    if (idIsBlank && codeIsBlank && rawName === "TOTAL EMPRESA") continue;
    if (typeof rawId !== "string" || !UUID_PATTERN.test(rawId)) {
      fail(`el identificador técnico ${label} en ${idRef} falta o no es un UUID válido.`);
    }
    if (employeesById.has(rawId)) fail(`el identificador técnico ${label} ${rawId} está duplicado.`);
    if (typeof rawCode !== "string" || rawCode.trim() === "") {
      fail(`el trabajador ${rawId} no conserva su Código Workera en el archivo ${label}.`);
    }
    const code = rawCode.trim();
    if (employeesByCode.has(code)) fail(`el Código Workera ${label} ${code} está duplicado.`);
    const employee = {
      id: rawId,
      code,
      name: String(rawName ?? ""),
      row,
    };
    employeesById.set(rawId, employee);
    employeesByCode.set(code, employee);
    rowOrder.push(rawId);
  }

  const cells = new Map<string, LogicalCell>();
  const coveredCells = new Set(headers.coveredCells);
  for (const employee of employeesById.values()) {
    for (const [header, column] of headers.columnsByKey) {
      const cell = XLSX.utils.encode_cell({ r: employee.row, c: column });
      coveredCells.add(cell);
      const identity = BUSINESS_HEADERS.has(header)
        ? {
            stableKey: `${employee.id}|${header}`,
            employeeId: employee.id,
            employeeName: employee.name,
            workDate: null,
            fieldCode: header,
          }
        : undefined;
      cells.set(`${employee.id}|${header}`, { cell, identity });
    }
  }
  return {
    cells,
    coveredCells,
    rowOrder,
    columnOrder: headers.order,
    employeesById,
    employeesByCode,
    columnsByHeader: headers.columnsByKey,
  };
}

function matrixHeaderKey(value: string | number | boolean | null): string | null {
  const date = excelDate(value);
  if (date) return `Fecha:${date}`;
  if (typeof value === "string" && value.trim()) return `Campo:${value.trim()}`;
  return null;
}

function indexMatrix(book: XLSX.WorkBook, summary: SummaryIndex, label: string): LogicalSheetIndex {
  const sheet = book.Sheets.MATRIZ_DIARIA_SABANA;
  if (!sheet) fail("falta MATRIZ_DIARIA_SABANA para validar la asistencia diaria.");
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  let detectedCodeColumn: number | undefined;
  for (let column = 0; column <= range.e.c; column += 1) {
    const value = normalizedValue(sheet[XLSX.utils.encode_cell({ r: SUMMARY_HEADER_ROW, c: column })]);
    if (value === "Código Workera") {
      detectedCodeColumn = column;
      break;
    }
  }
  // Libros sintéticos antiguos usados para probar límites no tienen la tabla
  // diaria oficial. Se comparan por coordenada y nunca producen ajustes
  // diarios ejecutables; la ruta normal sí entra al índice estable.
  if (detectedCodeColumn === undefined) {
    return { cells: new Map(), coveredCells: new Set(), rowOrder: [], columnOrder: [] };
  }
  const headers = uniqueHeaders(sheet, `MATRIZ_DIARIA_SABANA ${label}`, matrixHeaderKey);
  const codeColumn = headers.columnsByKey.get("Campo:Código Workera") ?? detectedCodeColumn;
  const cells = new Map<string, LogicalCell>();
  const coveredCells = new Set(headers.coveredCells);
  const rowOrder: string[] = [];
  const seenCodes = new Set<string>();
  for (let row = FIRST_WORKER_ROW; row <= range.e.r; row += 1) {
    if (!rowHasContent(sheet, row, range.e.c)) continue;
    const rawCode = normalizedValue(sheet[XLSX.utils.encode_cell({ r: row, c: codeColumn })]);
    if (typeof rawCode !== "string" || rawCode.trim() === "") {
      fail(`MATRIZ_DIARIA_SABANA ${label} contiene una fila sin Código Workera.`);
    }
    const code = rawCode.trim();
    if (seenCodes.has(code)) fail(`MATRIZ_DIARIA_SABANA ${label} contiene el Código Workera duplicado ${code}.`);
    seenCodes.add(code);
    rowOrder.push(code);
    const employee = summary.employeesByCode.get(code);
    if (!employee) {
      fail(`MATRIZ_DIARIA_SABANA ${label} contiene el Código Workera ${code}, que no coincide con ningún UUID del resumen.`);
    }
    for (const [headerKey, column] of headers.columnsByKey) {
      const cell = XLSX.utils.encode_cell({ r: row, c: column });
      coveredCells.add(cell);
      const date = headerKey.startsWith("Fecha:") ? headerKey.slice("Fecha:".length) : null;
      const identity = date && employee
        ? {
            stableKey: `${employee.id}|${date}|Código asistencia`,
            employeeId: employee.id,
            employeeName: employee.name,
            workDate: date,
            fieldCode: "Código asistencia",
          }
        : undefined;
      cells.set(`${code}|${headerKey}`, { cell, identity });
    }
  }
  return { cells, coveredCells, rowOrder, columnOrder: headers.order };
}

/** Acepta un orden distinto, pero nunca trabajadores faltantes, agregados o UUID alterados. */
function validateStableRowIdentity(base: SummaryIndex, uploaded: SummaryIndex): void {
  const beforeIds = new Set(base.employeesById.keys());
  const afterIds = new Set(uploaded.employeesById.keys());
  const missing = [...beforeIds].filter((id) => !afterIds.has(id));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  if (missing.length > 0 || added.length > 0) {
    fail(`la identidad de trabajadores cambió (faltan: ${missing.join(", ") || "ninguno"}; no reconocidos: ${added.join(", ") || "ninguno"}).`);
  }
  for (const employeeId of beforeIds) {
    const originalCode = base.employeesById.get(employeeId)?.code;
    const uploadedCode = uploaded.employeesById.get(employeeId)?.code;
    if (originalCode !== uploadedCode) {
      fail(`el Código Workera del trabajador ${employeeId} cambió respecto de la descarga original.`);
    }
  }
}

function validateStableMatrixIdentity(base: LogicalSheetIndex, uploaded: LogicalSheetIndex): void {
  const beforeCodes = new Set(base.rowOrder);
  const afterCodes = new Set(uploaded.rowOrder);
  const missing = [...beforeCodes].filter((code) => !afterCodes.has(code));
  const added = [...afterCodes].filter((code) => !beforeCodes.has(code));
  if (missing.length > 0 || added.length > 0) {
    fail(`la identidad de la sábana diaria cambió (faltan: ${missing.join(", ") || "ninguno"}; no reconocidos: ${added.join(", ") || "ninguno"}).`);
  }
}

function stableCells(book: XLSX.WorkBook): Map<string, StableCellIdentity> {
  const summary = indexSummary(book, "base");
  const matrix = indexMatrix(book, summary, "base");
  const keys = new Map<string, StableCellIdentity>();
  for (const [sheetName, index] of [
    ["RESUMEN_NOMINA", summary],
    ["MATRIZ_DIARIA_SABANA", matrix],
  ] as const) {
    for (const logicalCell of index.cells.values()) {
      if (logicalCell.identity) keys.set(`${sheetName}!${logicalCell.cell}`, logicalCell.identity);
    }
  }
  return keys;
}

function relativeFormulaSignature(formula: string | null, originCell: string): string | null {
  if (formula === null) return null;
  const origin = XLSX.utils.decode_cell(originCell);
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (_match, columnMarker: string, letters: string, rowMarker: string, digits: string) => {
    const target = XLSX.utils.decode_cell(`${letters}${digits}`);
    const row = rowMarker ? `R$${target.r + 1}` : `R[${target.r - origin.r}]`;
    const column = columnMarker ? `C$${target.c + 1}` : `C[${target.c - origin.c}]`;
    return `${row}${column}`;
  });
}

function addCellDifference(
  changes: PayrollWorkbookChange[],
  sheetName: string,
  baseSheet: XLSX.WorkSheet,
  uploadedSheet: XLSX.WorkSheet,
  before: LogicalCell | undefined,
  after: LogicalCell | undefined,
  identity: StableCellIdentity | undefined,
  baseSummary?: SummaryIndex,
): void {
  const cell = before?.cell ?? after?.cell;
  if (!cell) return;
  const a = before ? baseSheet[before.cell] : undefined;
  const b = after ? uploadedSheet[after.cell] : undefined;
  const sameFormula = relativeFormulaSignature(a?.f ?? null, before?.cell ?? cell)
    === relativeFormulaSignature(b?.f ?? null, after?.cell ?? cell);
  const executableIdentity = before && after && identity ? identity : undefined;
  if (!sameFormula) {
    changes.push({ sheet: sheetName, cell, stableKey: executableIdentity?.stableKey ?? null, previous: a?.f ?? null, next: b?.f ?? null, kind: "FORMULA", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR", employeeId: executableIdentity?.employeeId, employeeName: executableIdentity?.employeeName, workDate: executableIdentity?.workDate, fieldCode: executableIdentity?.fieldCode });
  } else if (!a?.f && !b?.f && normalizedValue(a) !== normalizedValue(b)) {
    const sourceHeader = executableIdentity ? BUSINESS_SOURCE_HEADER.get(executableIdentity.fieldCode) : undefined;
    const sourceColumn = sourceHeader ? baseSummary?.columnsByHeader.get(sourceHeader) : undefined;
    const sourceRow = executableIdentity ? baseSummary?.employeesById.get(executableIdentity.employeeId)?.row : undefined;
    const sourceValueAtComparison = sheetName === "MATRIZ_DIARIA_SABANA"
      ? normalizedValue(a)
      : sourceColumn !== undefined && sourceRow !== undefined
        ? normalizedValue(baseSheet[XLSX.utils.encode_cell({ r: sourceRow, c: sourceColumn })])
        : null;
    changes.push({ sheet: sheetName, cell, stableKey: executableIdentity?.stableKey ?? null, previous: normalizedValue(a), next: normalizedValue(b), kind: "VALUE", consequence: executableIdentity ? "AJUSTE_EMPRESARIAL" : "CONSERVAR_ARCHIVO_SIN_EJECUTAR", sourceValueAtComparison, employeeId: executableIdentity?.employeeId, employeeName: executableIdentity?.employeeName, workDate: executableIdentity?.workDate, fieldCode: executableIdentity?.fieldCode });
  } else if (styleSignature(a) !== styleSignature(b)) {
    changes.push({ sheet: sheetName, cell, stableKey: executableIdentity?.stableKey ?? null, previous: styleSignature(a), next: styleSignature(b), kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR", employeeId: executableIdentity?.employeeId, employeeName: executableIdentity?.employeeName, workDate: executableIdentity?.workDate, fieldCode: executableIdentity?.fieldCode });
  }
}

function addOrderDifference(changes: PayrollWorkbookChange[], sheet: string, cell: "!rowOrder" | "!columnOrder", previous: string[], next: string[]): void {
  if (structureSignature(previous) === structureSignature(next)) return;
  changes.push({ sheet, cell, stableKey: null, previous: structureSignature(previous), next: structureSignature(next), kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" });
}

export function comparePayrollWorkbooks(baseBytes: Uint8Array, uploadedBytes: Uint8Array): { identity: PayrollWorkbookIdentity; sha256: string; changes: PayrollWorkbookChange[] } {
  const base = parsePayrollWorkbook(baseBytes); const uploaded = parsePayrollWorkbook(uploadedBytes);
  if (JSON.stringify(base.identity) !== JSON.stringify(uploaded.identity)) fail("empresa, período o versión base no coincide con la descarga original.");
  const baseSummary = indexSummary(base.book, "original");
  const uploadedSummary = indexSummary(uploaded.book, "subido");
  validateStableRowIdentity(baseSummary, uploadedSummary);
  const baseMatrix = indexMatrix(base.book, baseSummary, "original");
  const uploadedMatrix = indexMatrix(uploaded.book, uploadedSummary, "subido");
  validateStableMatrixIdentity(baseMatrix, uploadedMatrix);
  const logicalIndexes = new Map<string, [LogicalSheetIndex, LogicalSheetIndex]>([
    ["RESUMEN_NOMINA", [baseSummary, uploadedSummary]],
    ["MATRIZ_DIARIA_SABANA", [baseMatrix, uploadedMatrix]],
  ]);
  const changes: PayrollWorkbookChange[] = [];
  for (const [sheetName, [beforeIndex, afterIndex]] of logicalIndexes) {
    addOrderDifference(changes, sheetName, "!rowOrder", beforeIndex.rowOrder, afterIndex.rowOrder);
    addOrderDifference(changes, sheetName, "!columnOrder", beforeIndex.columnOrder, afterIndex.columnOrder);
    const beforeSheet = base.book.Sheets[sheetName];
    const afterSheet = uploaded.book.Sheets[sheetName];
    for (const logicalKey of new Set([...beforeIndex.cells.keys(), ...afterIndex.cells.keys()])) {
      const beforeCell = beforeIndex.cells.get(logicalKey);
      const afterCell = afterIndex.cells.get(logicalKey);
      const identity = beforeCell?.identity && afterCell?.identity
        && beforeCell.identity.stableKey === afterCell.identity.stableKey
        ? beforeCell.identity
        : undefined;
      addCellDifference(changes, sheetName, beforeSheet, afterSheet, beforeCell, afterCell, identity, baseSummary);
    }
  }
  if (structureSignature(base.book.SheetNames) !== structureSignature(uploaded.book.SheetNames)) {
    changes.push({
      sheet: "*",
      cell: "!sheetOrder",
      stableKey: null,
      previous: structureSignature(base.book.SheetNames),
      next: structureSignature(uploaded.book.SheetNames),
      kind: "FORMAT",
      consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR",
    });
  }
  for (const sheetName of new Set([...base.book.SheetNames, ...uploaded.book.SheetNames])) {
    const before = base.book.Sheets[sheetName]; const after = uploaded.book.Sheets[sheetName];
    if (!before || !after) { changes.push({ sheet: sheetName, cell: "*", stableKey: null, previous: before ? "presente" : null, next: after ? "presente" : null, kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" }); continue; }
    for (const field of STRUCTURAL_SHEET_FIELDS) {
      const previous = structureSignature(before[field]);
      const next = structureSignature(after[field]);
      if (previous !== next) changes.push({ sheet: sheetName, cell: field, stableKey: null, previous, next, kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" });
    }
    const refs = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => /^[A-Z]+\d+$/.test(key)));
    for (const cell of refs) {
      const logical = logicalIndexes.get(sheetName);
      if (logical && (logical[0].coveredCells.has(cell) || logical[1].coveredCells.has(cell))) continue;
      addCellDifference(changes, sheetName, before, after, before[cell] ? { cell } : undefined, after[cell] ? { cell } : undefined, undefined);
    }
  }
  return { identity: uploaded.identity, sha256: uploaded.sha256, changes };
}

/**
 * Convierte una elección explícita de conflicto en cambios normalizados. Esto
 * también cubre KEEP_RRHH, donde el valor visible puede no cambiar y por tanto
 * una comparación de celdas por sí sola no produciría ningún diff.
 */
export function applyPayrollWorkbookConflictResolutions(
  baseBytes: Uint8Array,
  changes: readonly PayrollWorkbookChange[],
  conflicts: readonly PayrollWorkbookConflictInput[],
  resolutions: readonly PayrollWorkbookConflictResolution[],
): PayrollWorkbookChange[] {
  const { book } = parsePayrollWorkbook(baseBytes);
  const byStableKey = new Map<string, { sheet: string; cell: string; identity: StableCellIdentity }>();
  for (const [qualifiedCell, identity] of stableCells(book)) {
    const separator = qualifiedCell.indexOf("!");
    byStableKey.set(identity.stableKey, {
      sheet: qualifiedCell.slice(0, separator),
      cell: qualifiedCell.slice(separator + 1),
      identity,
    });
  }
  const conflictByKey = new Map(conflicts.map((conflict) => [conflict.stableKey, conflict]));
  const resolutionByKey = new Map<string, PayrollWorkbookConflictResolution>();
  for (const resolution of resolutions) {
    if (resolutionByKey.has(resolution.stableKey)) fail(`la resolución ${resolution.stableKey} está duplicada.`);
    if (!conflictByKey.has(resolution.stableKey)) fail(`la resolución ${resolution.stableKey} no corresponde a un conflicto vigente.`);
    if (!resolution.reason || resolution.reason.trim().length > 500) fail(`la resolución ${resolution.stableKey} exige un motivo de hasta 500 caracteres.`);
    resolutionByKey.set(resolution.stableKey, { ...resolution, reason: resolution.reason.trim() });
  }
  if (resolutionByKey.size !== conflictByKey.size) fail("todos los conflictos vigentes deben resolverse antes de confirmar.");

  const result = new Map(changes.map((change) => [`${change.sheet}!${change.cell}!${change.kind}`, { ...change }]));
  for (const conflict of conflicts) {
    const resolution = resolutionByKey.get(conflict.stableKey)!;
    const target = byStableKey.get(conflict.stableKey);
    if (!target) fail(`no se encontró la celda estable de ${conflict.stableKey}.`);
    let resolvedBusinessValue: string | number = conflict.rrhhFinalValue;
    if (resolution.choice === "ACCEPT_WORKERA") resolvedBusinessValue = conflict.currentWorkeraValue;
    if (resolution.choice === "THIRD_VALUE") {
      if (conflict.valueKind === "CODE") {
        if (typeof resolution.thirdValue !== "string" || !ALLOWED_DAILY_CODES.has(resolution.thirdValue)) {
          fail(`el tercer valor de ${conflict.stableKey} debe ser un código diario oficial.`);
        }
      } else if (
        typeof resolution.thirdValue !== "number"
        || !Number.isSafeInteger(resolution.thirdValue)
        || resolution.thirdValue < 0
        || resolution.thirdValue > 10_000_000
      ) {
        fail(`el tercer valor de ${conflict.stableKey} debe ser un entero no negativo.`);
      }
      resolvedBusinessValue = resolution.thirdValue;
    }

    const previous = normalizedValue(book.Sheets[target.sheet]?.[target.cell]);
    const next = conflict.valueKind === "CODE"
      ? resolvedBusinessValue
      : Number(resolvedBusinessValue) - Number(conflict.currentWorkeraValue);
    const sourceValueAtComparison = conflict.valueKind === "MINUTES"
      ? Number(conflict.currentWorkeraValue) / 1_440
      : conflict.currentWorkeraValue;
    result.set(`${target.sheet}!${target.cell}!VALUE`, {
      sheet: target.sheet,
      cell: target.cell,
      stableKey: conflict.stableKey,
      previous,
      next,
      kind: "VALUE",
      consequence: "AJUSTE_EMPRESARIAL",
      sourceValueAtComparison,
      employeeId: conflict.employeeId,
      employeeName: conflict.employeeName,
      workDate: conflict.workDate,
      fieldCode: conflict.fieldCode,
      conflictResolution: resolution.choice,
      conflictReason: resolution.reason,
    });

    if (conflict.valueKind !== "CODE") {
      const decoded = XLSX.utils.decode_cell(target.cell);
      const reasonColumn = decoded.c === 17 ? 18 : decoded.c === 20 ? 21 : 24;
      const reasonHeader = decoded.c === 17 ? "Motivo ajuste HH50" : decoded.c === 20 ? "Motivo ajuste HH100" : "Motivo ajuste bono";
      const reasonCell = XLSX.utils.encode_cell({ r: decoded.r, c: reasonColumn });
      result.set(`${target.sheet}!${reasonCell}!VALUE`, {
        sheet: target.sheet,
        cell: reasonCell,
        stableKey: `${conflict.employeeId}|${reasonHeader}`,
        previous: normalizedValue(book.Sheets[target.sheet]?.[reasonCell]),
        next: resolution.reason,
        kind: "VALUE",
        consequence: "AJUSTE_EMPRESARIAL",
        sourceValueAtComparison: null,
        employeeId: conflict.employeeId,
        employeeName: conflict.employeeName,
        workDate: null,
        fieldCode: reasonHeader,
      });
    }
  }
  return [...result.values()];
}

/**
 * Al mantener el mismo ajuste frente a un cambio posterior de Workera no hay
 * diferencia numérica que SheetJS pueda detectar. RR. HH. expresa esa opción
 * actualizando el motivo; este paso agrega la decisión numérica equivalente
 * (mismo valor, nueva fuente confiable) para que el siguiente libro no vuelva
 * a presentar indefinidamente el mismo conflicto de tres vías.
 */
export function expandPayrollWorkbookBusinessChanges(
  baseBytes: Uint8Array,
  changes: readonly PayrollWorkbookChange[]
): PayrollWorkbookChange[] {
  const { book } = parsePayrollWorkbook(baseBytes);
  const summary = book.Sheets.RESUMEN_NOMINA;
  if (!summary) return [...changes];
  const expanded = [...changes];
  const existing = new Set(changes.map((change) => `${change.sheet}!${change.cell}!${change.kind}`));
  const reasonToAdjustment = new Map<number, { adjustmentColumn: number; automaticColumn: number; header: string }>([
    [18, { adjustmentColumn: 17, automaticColumn: 29, header: "Ajuste HH50 (minutos)" }],
    [21, { adjustmentColumn: 20, automaticColumn: 30, header: "Ajuste HH100 (minutos)" }],
    [24, { adjustmentColumn: 23, automaticColumn: 22, header: "Ajuste bono (CLP)" }],
  ]);
  const adjustmentToReason = new Map<number, { reasonColumn: number; header: string }>([
    [17, { reasonColumn: 18, header: "Motivo ajuste HH50" }],
    [20, { reasonColumn: 21, header: "Motivo ajuste HH100" }],
    [23, { reasonColumn: 24, header: "Motivo ajuste bono" }],
  ]);
  for (const change of changes) {
    if (change.sheet !== "RESUMEN_NOMINA" || change.kind !== "VALUE") continue;
    const decoded = XLSX.utils.decode_cell(change.cell);
    const mapping = reasonToAdjustment.get(decoded.c);
    if (!mapping) continue;
    const adjustmentRef = XLSX.utils.encode_cell({ r: decoded.r, c: mapping.adjustmentColumn });
    if (existing.has(`RESUMEN_NOMINA!${adjustmentRef}!VALUE`)) continue;
    const employeeId = normalizedValue(summary[XLSX.utils.encode_cell({ r: decoded.r, c: 28 })]);
    if (typeof employeeId !== "string" || employeeId.length === 0) continue;
    const adjustment = normalizedValue(summary[adjustmentRef]);
    const source = normalizedValue(summary[XLSX.utils.encode_cell({ r: decoded.r, c: mapping.automaticColumn })]);
    expanded.push({
      sheet: "RESUMEN_NOMINA",
      cell: adjustmentRef,
      stableKey: `${employeeId}|${mapping.header}`,
      previous: adjustment,
      next: adjustment,
      kind: "VALUE",
      consequence: "AJUSTE_EMPRESARIAL",
      sourceValueAtComparison: source,
      employeeId,
      employeeName: String(normalizedValue(summary[XLSX.utils.encode_cell({ r: decoded.r, c: 2 })]) ?? ""),
      workDate: null,
      fieldCode: mapping.header,
    });
    existing.add(`RESUMEN_NOMINA!${adjustmentRef}!VALUE`);
  }
  for (const change of [...expanded]) {
    if (change.sheet !== "RESUMEN_NOMINA" || change.kind !== "VALUE") continue;
    const decoded = XLSX.utils.decode_cell(change.cell);
    const mapping = adjustmentToReason.get(decoded.c);
    if (!mapping) continue;
    const reasonRef = XLSX.utils.encode_cell({ r: decoded.r, c: mapping.reasonColumn });
    if (existing.has(`RESUMEN_NOMINA!${reasonRef}!VALUE`)) continue;
    const employeeId = normalizedValue(summary[XLSX.utils.encode_cell({ r: decoded.r, c: 28 })]);
    if (typeof employeeId !== "string" || employeeId.length === 0) continue;
    const reason = normalizedValue(summary[reasonRef]);
    expanded.push({
      sheet: "RESUMEN_NOMINA",
      cell: reasonRef,
      stableKey: `${employeeId}|${mapping.header}`,
      previous: reason,
      next: reason,
      kind: "VALUE",
      consequence: "AJUSTE_EMPRESARIAL",
      sourceValueAtComparison: null,
      employeeId,
      employeeName: String(normalizedValue(summary[XLSX.utils.encode_cell({ r: decoded.r, c: 2 })]) ?? ""),
      workDate: null,
      fieldCode: mapping.header,
    });
    existing.add(`RESUMEN_NOMINA!${reasonRef}!VALUE`);
  }
  return expanded;
}

/**
 * Valida únicamente los campos empresariales que el servidor reconoce. Las
 * fórmulas del archivo no se ejecutan: el valor final se recalcula desde los
 * automáticos confiables del libro base y los ajustes enteros propuestos.
 */
export function validatePayrollWorkbookBusinessChanges(
  baseBytes: Uint8Array,
  changes: readonly PayrollWorkbookChange[]
): string[] {
  const { book } = parsePayrollWorkbook(baseBytes);
  const sheet = book.Sheets.RESUMEN_NOMINA;
  if (!sheet) return ["Falta RESUMEN_NOMINA."];
  const byCell = new Map(
    changes
      .filter((change) => change.sheet === "RESUMEN_NOMINA" && change.kind === "VALUE")
      .map((change) => [change.cell, change])
  );
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const issues: string[] = [];
  for (const change of changes) {
    if (change.sheet !== "MATRIZ_DIARIA_SABANA" || change.kind !== "VALUE" || change.consequence !== "AJUSTE_EMPRESARIAL") continue;
    if (typeof change.next !== "string" || !ALLOWED_DAILY_CODES.has(change.next)) {
      issues.push(`${change.cell}: el código diario debe ser uno oficial y R no puede asignarse nuevamente.`);
    }
    if (!change.employeeId || !change.workDate || change.fieldCode !== "Código asistencia") {
      issues.push(`${change.cell}: falta la identidad estable trabajador/fecha/campo.`);
    }
  }
  const rules = [
    { adjustmentColumn: 17, reasonColumn: 18, automaticColumn: 29, label: "HH50", scale: 1_440 },
    { adjustmentColumn: 20, reasonColumn: 21, automaticColumn: 30, label: "HH100", scale: 1_440 },
    { adjustmentColumn: 23, reasonColumn: 24, automaticColumn: 22, label: "bono", scale: 1 },
  ] as const;

  for (let row = 5; row <= range.e.r; row += 1) {
    for (const rule of rules) {
      const adjustmentRef = XLSX.utils.encode_cell({ r: row, c: rule.adjustmentColumn });
      const reasonRef = XLSX.utils.encode_cell({ r: row, c: rule.reasonColumn });
      const adjustmentChange = byCell.get(adjustmentRef);
      const reasonChange = byCell.get(reasonRef);
      if (!adjustmentChange && !reasonChange) continue;
      const adjustmentValue = adjustmentChange?.next ?? normalizedValue(sheet[adjustmentRef]);
      const reasonValue = reasonChange?.next ?? normalizedValue(sheet[reasonRef]);
      if (typeof adjustmentValue !== "number" || !Number.isFinite(adjustmentValue) || !Number.isInteger(adjustmentValue)) {
        issues.push(`${adjustmentRef}: el ajuste ${rule.label} debe ser un entero.`);
        continue;
      }
      if (adjustmentValue !== 0 && (typeof reasonValue !== "string" || reasonValue.trim() === "")) {
        issues.push(`${reasonRef}: el motivo del ajuste ${rule.label} es obligatorio.`);
      }
      const automatic = normalizedValue(sheet[XLSX.utils.encode_cell({ r: row, c: rule.automaticColumn })]);
      const automaticValue = typeof automatic === "number" && Number.isFinite(automatic)
        ? automatic * rule.scale
        : 0;
      if (automaticValue + adjustmentValue < 0) {
        issues.push(`${adjustmentRef}: el resultado final de ${rule.label} no puede ser negativo.`);
      }
    }
  }
  return issues;
}
