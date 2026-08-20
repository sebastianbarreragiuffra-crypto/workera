import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { normalizeName } from "../business-rules/name-matching";

/**
 * Importador del Excel mensual de facturas que finanzas envía por correo
 * (formato real confirmado, hoja "PROVEEDORES" de la plantilla): columnas
 * `Nro. Interno / Nro. Docto. / Fecha / Nombre Cliente / Valor Total ($) /
 * VENCIMIENTO / DIAS / MES / ESTADO`, con filas de título/fecha antes del
 * encabezado real (a diferencia del maestro de proveedores, que no las
 * tiene). Solo se usan `Nro. Docto.`, `Nombre Cliente` y `Valor Total ($)`
 * -- el resto de columnas existe en el archivo real pero no se necesita
 * para generar la nómina de pago.
 *
 * El encabezado real puede estar en cualquier fila de las primeras ~15
 * (varía según cuántas filas de título/fecha agregue finanzas ese mes) --
 * se busca por texto de columna en vez de asumir una posición fija de fila.
 */

const HEADER_TOKENS = { nroDocto: "nro. docto.", nombreCliente: "nombre cliente", valorTotal: "valor total" };

export interface ParsedInvoiceRow {
  rowNumber: number;
  nroDocto: string;
  nombreCliente: string;
  valorTotal: number;
}

export type InvoiceParseIssueReason = "MISSING_FIELD" | "INVALID_AMOUNT" | "HEADER_NOT_FOUND";

export interface InvoiceParseIssue {
  rowNumber: number;
  reason: InvoiceParseIssueReason;
}

export interface ParseInvoiceExcelResult {
  valid: ParsedInvoiceRow[];
  issues: InvoiceParseIssue[];
}

function findHeaderRow(rows: (string | number | null)[][]): { rowIndex: number; nroDoctoCol: number; nombreCol: number; valorCol: number } | null {
  const maxScan = Math.min(rows.length, 15);
  for (let i = 0; i < maxScan; i += 1) {
    const row = rows[i] ?? [];
    const normalized = row.map((cell) => (typeof cell === "string" ? cell.trim().toLowerCase() : ""));
    const nroDoctoCol = normalized.findIndex((c) => c === HEADER_TOKENS.nroDocto);
    const nombreCol = normalized.findIndex((c) => c === HEADER_TOKENS.nombreCliente);
    const valorCol = normalized.findIndex((c) => c.startsWith(HEADER_TOKENS.valorTotal));
    if (nroDoctoCol >= 0 && nombreCol >= 0 && valorCol >= 0) {
      return { rowIndex: i, nroDoctoCol, nombreCol, valorCol };
    }
  }
  return null;
}

export function parseInvoiceExcel(fileBytes: Uint8Array): ParseInvoiceExcelResult {
  const workbook = XLSX.read(fileBytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });

  const header = findHeaderRow(rows);
  if (!header) {
    return { valid: [], issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }] };
  }

  const valid: ParsedInvoiceRow[] = [];
  const issues: InvoiceParseIssue[] = [];

  for (let i = header.rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue;

    const nroDocto = String(row[header.nroDoctoCol] ?? "").trim();
    const nombreCliente = String(row[header.nombreCol] ?? "").trim();
    const valorRaw = row[header.valorCol];

    if (!nroDocto || !nombreCliente || valorRaw === null || valorRaw === undefined || valorRaw === "") {
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

    valid.push({ rowNumber: excelRowNumber, nroDocto, nombreCliente, valorTotal: Math.round(valorTotal) });
  }

  return { valid, issues };
}

export interface PayrollBatchItemResult {
  nroDocto: string;
  nombreCliente: string;
  valorTotal: number;
  status: "MATCHED" | "UNMATCHED";
  supplier: { rut: string; name: string; paymentMethod: string; bankCode: string; accountNumber: string } | null;
}

export interface GeneratePayrollBatchResult {
  batchId: string;
  items: PayrollBatchItemResult[];
  matchedCount: number;
  unmatchedCount: number;
}

/**
 * Cruza cada fila del Excel mensual contra `suppliers` por nombre EXACTO
 * normalizado (nunca ILIKE parcial, mismo criterio que
 * `import-birthdays.ts`). Un nombre sin match queda `UNMATCHED` -- se
 * persiste igual (auditoría completa del lote) pero nunca se incluye en la
 * exportación final para el banco.
 */
export async function generatePayrollBatch(
  supabase: SupabaseClient<Database>,
  rows: ParsedInvoiceRow[],
  sourceFilename: string,
  generatedBy: string
): Promise<GeneratePayrollBatchResult> {
  const { data: suppliers, error: suppliersError } = await supabase
    .from("suppliers")
    .select("id, rut, name, normalized_name, payment_method, bank_code, account_number")
    .eq("active", true);
  if (suppliersError) throw new Error(`generatePayrollBatch: fallo leyendo suppliers: ${suppliersError.message}`);

  const bySuppliersName = new Map((suppliers ?? []).map((s) => [s.normalized_name, s]));

  const items: PayrollBatchItemResult[] = rows.map((row) => {
    const supplier = bySuppliersName.get(normalizeName(row.nombreCliente)) ?? null;
    return {
      nroDocto: row.nroDocto,
      nombreCliente: row.nombreCliente,
      valorTotal: row.valorTotal,
      status: supplier ? "MATCHED" : "UNMATCHED",
      supplier: supplier
        ? { rut: supplier.rut, name: supplier.name, paymentMethod: supplier.payment_method, bankCode: supplier.bank_code, accountNumber: supplier.account_number }
        : null,
    };
  });

  const matchedCount = items.filter((i) => i.status === "MATCHED").length;
  const unmatchedCount = items.length - matchedCount;
  const totalAmount = items.filter((i) => i.status === "MATCHED").reduce((sum, i) => sum + i.valorTotal, 0);

  const { data: batch, error: batchError } = await supabase
    .from("payroll_batches")
    .insert({ source_filename: sourceFilename, generated_by: generatedBy, matched_count: matchedCount, unmatched_count: unmatchedCount, total_amount: totalAmount })
    .select("id")
    .single();
  if (batchError || !batch) throw new Error(`generatePayrollBatch: fallo creando lote: ${batchError?.message}`);

  const supplierIdByNormalizedName = new Map((suppliers ?? []).map((s) => [s.normalized_name, s.id]));
  const itemRows = rows.map((row) => ({
    batch_id: batch.id,
    nro_docto: row.nroDocto,
    nombre_cliente: row.nombreCliente,
    valor_total: row.valorTotal,
    supplier_id: supplierIdByNormalizedName.get(normalizeName(row.nombreCliente)) ?? null,
    status: supplierIdByNormalizedName.has(normalizeName(row.nombreCliente)) ? "MATCHED" : "UNMATCHED",
  }));
  const { error: itemsError } = await supabase.from("payroll_batch_items").insert(itemRows);
  if (itemsError) throw new Error(`generatePayrollBatch: fallo guardando ítems del lote: ${itemsError.message}`);

  return { batchId: batch.id, items, matchedCount, unmatchedCount };
}
