import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { normalizeName, normalizeRut } from "../business-rules/name-matching";
import { matchInvoiceHeaderConcept, describeMissingConcepts, type InvoiceHeaderConcept } from "./invoice-header-mapping";

/**
 * Importador del Excel mensual de facturas que Finanzas envía por correo.
 * REQUERIDO por fila para poder generar la nómina: número/folio de
 * documento, monto, y AL MENOS UNO de (RUT de proveedor, nombre de
 * proveedor) -- sin ninguno de los dos no hay forma de identificar a quién
 * pagarle. El nombre del proveedor es OPCIONAL si hay RUT (el nombre real
 * puede completarse desde el maestro de proveedores al hacer match); el RUT
 * es OPCIONAL si hay nombre (formato histórico del archivo, sin RUT).
 *
 * El encabezado real puede estar en cualquier fila de las primeras ~15 (filas
 * de título/fecha antes de la tabla), y el texto exacto de columna varía
 * entre plantillas de Finanzas ("N° Documento" vs "Nro. Docto." vs "Folio",
 * etc.) -- ver `invoice-header-mapping.ts` para la lista de alias
 * reconocidos. Nunca se acepta un encabezado por coincidencia parcial de
 * texto libre, solo por los alias explícitos de esa lista.
 */

export interface ParsedInvoiceRow {
  rowNumber: number;
  nroDocto: string;
  nombreCliente: string;
  rut: string | null;
  valorTotal: number;
}

export type InvoiceParseIssueReason = "MISSING_FIELD" | "INVALID_AMOUNT" | "HEADER_NOT_FOUND" | "AMBIGUOUS_SHEET";

export interface InvoiceParseIssue {
  rowNumber: number;
  reason: InvoiceParseIssueReason;
}

/** Diagnóstico seguro (nunca incluye datos de fila, solo texto de encabezado) para explicar por qué no se pudo leer el archivo. */
export interface InvoiceHeaderDiagnostics {
  sheetNames: string[];
  detectedHeaders: string[];
  missingConcepts: string[];
  candidateSheets?: string[];
}

export interface ParseInvoiceExcelResult {
  valid: ParsedInvoiceRow[];
  issues: InvoiceParseIssue[];
  diagnostics?: InvoiceHeaderDiagnostics;
}

interface InvoiceHeaderLocation {
  sheetName: string;
  rowIndex: number;
  nroDoctoCol: number;
  valorCol: number;
  nombreCol: number;
  rutCol: number;
}

interface HeaderScanResult {
  matches: InvoiceHeaderLocation[];
  bestPartial: { sheetName: string; headers: string[]; foundConcepts: InvoiceHeaderConcept[] } | null;
}

/**
 * Recorre TODAS las hojas del archivo (nunca asume que la tabla está en la
 * primera -- regresión real: el archivo de Finanzas trae varias hojas antes
 * de "PROVEEDORES"). Si más de una hoja/fila califica como encabezado
 * válido, NO se adivina cuál usar -- se reporta como ambigüedad (ver
 * `AMBIGUOUS_SHEET`).
 */
function scanWorkbookForInvoiceHeader(workbook: XLSX.WorkBook): HeaderScanResult {
  const matches: InvoiceHeaderLocation[] = [];
  let bestPartial: HeaderScanResult["bestPartial"] = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
    const maxScan = Math.min(rows.length, 15);

    for (let i = 0; i < maxScan; i += 1) {
      const row = rows[i] ?? [];
      let nroDoctoCol = -1;
      let valorCol = -1;
      let nombreCol = -1;
      let rutCol = -1;
      const foundConcepts: InvoiceHeaderConcept[] = [];
      const headerLabels: string[] = [];

      row.forEach((cell, colIndex) => {
        const concept = matchInvoiceHeaderConcept(cell);
        if (!concept) return;
        foundConcepts.push(concept);
        headerLabels.push(String(cell).trim());
        if (concept === "DOCUMENTO" && nroDoctoCol < 0) nroDoctoCol = colIndex;
        if (concept === "MONTO" && valorCol < 0) valorCol = colIndex;
        if (concept === "PROVEEDOR_NOMBRE" && nombreCol < 0) nombreCol = colIndex;
        if (concept === "PROVEEDOR_RUT" && rutCol < 0) rutCol = colIndex;
      });

      const hasSupplierIdentifier = nombreCol >= 0 || rutCol >= 0;
      if (nroDoctoCol >= 0 && valorCol >= 0 && hasSupplierIdentifier) {
        matches.push({ sheetName, rowIndex: i, nroDoctoCol, valorCol, nombreCol, rutCol });
      } else if (foundConcepts.length > 0 && (!bestPartial || foundConcepts.length > bestPartial.foundConcepts.length)) {
        bestPartial = { sheetName, headers: headerLabels, foundConcepts };
      }
    }
  }

  return { matches, bestPartial };
}

export function parseInvoiceExcel(fileBytes: Uint8Array): ParseInvoiceExcelResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBytes, { type: "array" });
  } catch {
    // Archivo corrupto/no es un Excel real -- esto SÍ debe bloquear la generación (a diferencia de un
    // proveedor sin match), pero nunca debe propagar una excepción sin manejar hacia la Server Action.
    return {
      valid: [],
      issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }],
      diagnostics: { sheetNames: [], detectedHeaders: [], missingConcepts: describeMissingConcepts([]) },
    };
  }
  const { matches, bestPartial } = scanWorkbookForInvoiceHeader(workbook);

  if (matches.length === 0) {
    return {
      valid: [],
      issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }],
      diagnostics: {
        sheetNames: workbook.SheetNames,
        detectedHeaders: bestPartial?.headers ?? [],
        missingConcepts: describeMissingConcepts(bestPartial?.foundConcepts ?? []),
      },
    };
  }

  if (matches.length > 1) {
    return {
      valid: [],
      issues: [{ rowNumber: 0, reason: "AMBIGUOUS_SHEET" }],
      diagnostics: {
        sheetNames: workbook.SheetNames,
        detectedHeaders: [],
        missingConcepts: [],
        candidateSheets: [...new Set(matches.map((m) => m.sheetName))],
      },
    };
  }

  const header = matches[0];
  const sheet = workbook.Sheets[header.sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });

  const valid: ParsedInvoiceRow[] = [];
  const issues: InvoiceParseIssue[] = [];

  for (let i = header.rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue;

    const nroDocto = String(row[header.nroDoctoCol] ?? "").trim();
    const nombreCliente = header.nombreCol >= 0 ? String(row[header.nombreCol] ?? "").trim() : "";
    const rut = header.rutCol >= 0 ? String(row[header.rutCol] ?? "").trim() : "";
    const valorRaw = row[header.valorCol];

    if (!nroDocto || (!nombreCliente && !rut) || valorRaw === null || valorRaw === undefined || valorRaw === "") {
      issues.push({ rowNumber: excelRowNumber, reason: "MISSING_FIELD" });
      continue;
    }

    const strippedValor = typeof valorRaw === "number" ? null : String(valorRaw).replace(/[^0-9.-]/g, "");
    if (strippedValor !== null && strippedValor === "") {
      // Sin un solo dígito -- "no es un monto" se reduce a "" y Number("") es 0, no NaN; se rechaza explícitamente acá.
      issues.push({ rowNumber: excelRowNumber, reason: "INVALID_AMOUNT" });
      continue;
    }
    const valorTotal = typeof valorRaw === "number" ? valorRaw : Number(strippedValor);
    if (!Number.isFinite(valorTotal) || valorTotal < 0) {
      issues.push({ rowNumber: excelRowNumber, reason: "INVALID_AMOUNT" });
      continue;
    }

    valid.push({ rowNumber: excelRowNumber, nroDocto, nombreCliente, rut: rut || null, valorTotal: Math.round(valorTotal) });
  }

  return { valid, issues };
}

export interface PayrollBatchItemResult {
  nroDocto: string;
  nombreCliente: string;
  rut?: string | null;
  valorTotal: number;
  status: "MATCHED" | "UNMATCHED";
  supplier: { rut: string; name: string; paymentMethod: string; bankCode: string; accountNumber: string } | null;
}

export interface GeneratePayrollBatchResult {
  batchId: string;
  items: PayrollBatchItemResult[];
  matchedCount: number;
  unmatchedCount: number;
  totalAmount: number;
}

interface SupplierRow {
  id: string;
  rut: string;
  name: string;
  normalized_name: string;
  normalized_rut: string;
  payment_method: string;
  bank_code: string;
  account_number: string;
}

/**
 * Identificador canónico preferido: RUT normalizado si la factura lo trae
 * (match EXACTO, nunca fuzzy); si no hay RUT o no matchea ningún proveedor
 * activo, se intenta por nombre EXACTO normalizado (formato histórico del
 * archivo, sin RUT -- el modelo de negocio ya permite este criterio
 * explícitamente). Nunca se adivina que dos nombres parecidos son el mismo
 * proveedor.
 */
function findSupplier(row: ParsedInvoiceRow, bySuppliersRut: Map<string, SupplierRow>, bySuppliersName: Map<string, SupplierRow>): SupplierRow | null {
  if (row.rut) {
    const byRut = bySuppliersRut.get(normalizeRut(row.rut));
    if (byRut) return byRut;
  }
  if (row.nombreCliente) {
    return bySuppliersName.get(normalizeName(row.nombreCliente)) ?? null;
  }
  return null;
}

/**
 * Un proveedor sin match NUNCA detiene la generación de la nómina ni vacía
 * el total -- la factura se conserva íntegra (documento, monto, nombre/rut
 * tal cual venían) con los campos del maestro en blanco y queda marcada
 * UNMATCHED para revisión manual. El monto total del lote es la suma de
 * TODAS las facturas válidas, con o sin match (nunca solo las matcheadas).
 */
export async function generatePayrollBatch(
  supabase: SupabaseClient<Database>,
  rows: ParsedInvoiceRow[],
  sourceFilename: string,
  generatedBy: string
): Promise<GeneratePayrollBatchResult> {
  const { data: suppliers, error: suppliersError } = await supabase
    .from("suppliers")
    .select("id, rut, name, normalized_name, normalized_rut, payment_method, bank_code, account_number")
    .eq("active", true);
  if (suppliersError) throw new Error(`generatePayrollBatch: fallo leyendo suppliers: ${suppliersError.message}`);

  const bySuppliersRut = new Map((suppliers ?? []).map((s) => [s.normalized_rut, s]));
  const bySuppliersName = new Map((suppliers ?? []).map((s) => [s.normalized_name, s]));

  const resolved = rows.map((row) => ({ row, supplier: findSupplier(row, bySuppliersRut, bySuppliersName) }));

  const items: PayrollBatchItemResult[] = resolved.map(({ row, supplier }) => ({
    nroDocto: row.nroDocto,
    nombreCliente: row.nombreCliente,
    rut: row.rut,
    valorTotal: row.valorTotal,
    status: supplier ? "MATCHED" : "UNMATCHED",
    supplier: supplier
      ? { rut: supplier.rut, name: supplier.name, paymentMethod: supplier.payment_method, bankCode: supplier.bank_code, accountNumber: supplier.account_number }
      : null,
  }));

  const matchedCount = items.filter((i) => i.status === "MATCHED").length;
  const unmatchedCount = items.length - matchedCount;
  const totalAmount = items.reduce((sum, i) => sum + i.valorTotal, 0);

  const { data: batch, error: batchError } = await supabase
    .from("payroll_batches")
    .insert({ source_filename: sourceFilename, generated_by: generatedBy, matched_count: matchedCount, unmatched_count: unmatchedCount, total_amount: totalAmount })
    .select("id")
    .single();
  if (batchError || !batch) throw new Error(`generatePayrollBatch: fallo creando lote: ${batchError?.message}`);

  const itemRows = resolved.map(({ row, supplier }) => ({
    batch_id: batch.id,
    nro_docto: row.nroDocto,
    nombre_cliente: row.nombreCliente,
    valor_total: row.valorTotal,
    supplier_id: supplier?.id ?? null,
    status: supplier ? "MATCHED" : "UNMATCHED",
  }));
  const { error: itemsError } = await supabase.from("payroll_batch_items").insert(itemRows);
  if (itemsError) throw new Error(`generatePayrollBatch: fallo guardando ítems del lote: ${itemsError.message}`);

  return { batchId: batch.id, items, matchedCount, unmatchedCount, totalAmount };
}
