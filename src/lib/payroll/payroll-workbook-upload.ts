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
}
export interface PayrollWorkbookIdentity {
  schema: string;
  periodStart: string;
  periodEnd: string;
  payrollMonth: string;
  baseVersion: string;
}

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
function readIdentity(book: XLSX.WorkBook): PayrollWorkbookIdentity {
  const sheet = book.Sheets._GESTORA_TECNICA;
  if (!sheet) fail("falta la identificación técnica.");
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false });
  const values = new Map(rows.map((row) => [String(row[0] ?? ""), String(row[1] ?? "")]));
  const identity = { schema: values.get("Esquema") ?? "", periodStart: values.get("Inicio") ?? "", periodEnd: values.get("Fin") ?? "", payrollMonth: values.get("Mes de remuneración") ?? "", baseVersion: values.get("Versión base") ?? "" };
  if (identity.schema !== "GESTORA_PRENOMINA_2026_V2") fail("la versión del esquema no es compatible.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(identity.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(identity.periodEnd)) fail("el período técnico no es válido.");
  return identity;
}

export function parsePayrollWorkbook(bytes: Uint8Array): { book: XLSX.WorkBook; identity: PayrollWorkbookIdentity; sha256: string } {
  inspectXlsxContainer(bytes);
  const archive = unzipSync(bytes);
  const paths = Object.keys(archive);
  if (paths.some((path) => /vbaProject|xl\/externalLinks\//i.test(path))) fail("contiene macros o vínculos externos.");
  const relationships = paths.filter((path) => path.endsWith(".rels")).map((path) => strFromU8(archive[path])).join("\n");
  if (/TargetMode=["']External["']/i.test(relationships)) fail("contiene una relación externa.");
  const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellStyles: true, cellDates: false });
  if (book.SheetNames.length > PAYROLL_WORKBOOK_LIMITS.maxSheets) fail("contiene demasiadas hojas.");
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

function stableKeys(book: XLSX.WorkBook): Map<string, string> {
  const keys = new Map<string, string>();
  const summary = book.Sheets.RESUMEN_NOMINA;
  if (!summary) return keys;
  const range = XLSX.utils.decode_range(summary["!ref"] ?? "A1:A1");
  for (let row = 5; row <= range.e.r; row += 1) {
    const employeeId = normalizedValue(summary[XLSX.utils.encode_cell({ r: row, c: 28 })]);
    if (!employeeId) continue;
    for (let column = 0; column <= range.e.c; column += 1) keys.set(`RESUMEN_NOMINA!${XLSX.utils.encode_cell({ r: row, c: column })}`, `${employeeId}|${String(normalizedValue(summary[XLSX.utils.encode_cell({ r: 4, c: column })]) ?? column)}`);
  }
  return keys;
}

export function comparePayrollWorkbooks(baseBytes: Uint8Array, uploadedBytes: Uint8Array): { identity: PayrollWorkbookIdentity; sha256: string; changes: PayrollWorkbookChange[] } {
  const base = parsePayrollWorkbook(baseBytes); const uploaded = parsePayrollWorkbook(uploadedBytes);
  if (JSON.stringify(base.identity) !== JSON.stringify(uploaded.identity)) fail("empresa, período o versión base no coincide con la descarga original.");
  const keys = stableKeys(uploaded.book); const changes: PayrollWorkbookChange[] = [];
  for (const sheetName of new Set([...base.book.SheetNames, ...uploaded.book.SheetNames])) {
    const before = base.book.Sheets[sheetName]; const after = uploaded.book.Sheets[sheetName];
    if (!before || !after) { changes.push({ sheet: sheetName, cell: "*", stableKey: null, previous: before ? "presente" : null, next: after ? "presente" : null, kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" }); continue; }
    const refs = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => /^[A-Z]+\d+$/.test(key)));
    for (const cell of refs) {
      const a = before[cell]; const b = after[cell]; const key = `${sheetName}!${cell}`;
      if ((a?.f ?? null) !== (b?.f ?? null)) changes.push({ sheet: sheetName, cell, stableKey: keys.get(key) ?? null, previous: a?.f ?? null, next: b?.f ?? null, kind: "FORMULA", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" });
      else if (normalizedValue(a) !== normalizedValue(b)) changes.push({ sheet: sheetName, cell, stableKey: keys.get(key) ?? null, previous: normalizedValue(a), next: normalizedValue(b), kind: "VALUE", consequence: keys.has(key) ? "AJUSTE_EMPRESARIAL" : "CONSERVAR_ARCHIVO_SIN_EJECUTAR" });
      else if (styleSignature(a) !== styleSignature(b)) changes.push({ sheet: sheetName, cell, stableKey: keys.get(key) ?? null, previous: styleSignature(a), next: styleSignature(b), kind: "FORMAT", consequence: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" });
    }
  }
  return { identity: uploaded.identity, sha256: uploaded.sha256, changes };
}
