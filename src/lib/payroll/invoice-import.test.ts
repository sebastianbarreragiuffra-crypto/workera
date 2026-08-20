import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseInvoiceExcel, generatePayrollBatch } from "./invoice-import";

function buildWorkbookBytes(headerRowIndex: number, rows: (string | number | null)[][]): Uint8Array {
  const junkRows: (string | number | null)[][] = Array.from({ length: headerRowIndex }, () => [null]);
  const sheetRows: (string | number | null)[][] = [
    ...junkRows,
    ["Nro. Interno", "Nro. Docto.", "Fecha", "Nombre Cliente", "Valor Total ($)", "VENCIMIENTO", "DIAS", "MES", "ESTADO"],
    ...rows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PROVEEDORES");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

test("parseInvoiceExcel: encabezado se encuentra aunque haya filas de título antes (formato real confirmado)", () => {
  const bytes = buildWorkbookBytes(3, [[null, "6050", null, "PROVEEDOR FICTICIO", 100000, null, null, null, null]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.deepEqual(result.valid[0], { rowNumber: 5, nroDocto: "6050", nombreCliente: "PROVEEDOR FICTICIO", valorTotal: 100000 });
});

test("parseInvoiceExcel: sin encabezado reconocible -> issue HEADER_NOT_FOUND, valid vacío", () => {
  const sheet = XLSX.utils.aoa_to_sheet([["columna random", "otra"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "HEADER_NOT_FOUND");
});

test("parseInvoiceExcel: monto no numérico -> issue INVALID_AMOUNT", () => {
  const bytes = buildWorkbookBytes(0, [[null, "6050", null, "PROVEEDOR FICTICIO", "no es un monto", null, null, null, null]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "INVALID_AMOUNT");
});

test("parseInvoiceExcel: nombre cliente vacío -> issue MISSING_FIELD", () => {
  const bytes = buildWorkbookBytes(0, [[null, "6050", null, "", 100000, null, null, null, null]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "MISSING_FIELD");
});

interface FakeSupplier {
  id: string;
  rut: string;
  name: string;
  normalized_name: string;
  payment_method: string;
  bank_code: string;
  account_number: string;
}

function mockSupabase(suppliers: FakeSupplier[]) {
  const insertedBatches: Record<string, unknown>[] = [];
  const insertedItems: Record<string, unknown>[] = [];
  return {
    from(table: string) {
      if (table === "suppliers") {
        return { select() { return this; }, eq() { return { data: suppliers, error: null }; } };
      }
      if (table === "payroll_batches") {
        return {
          insert(row: Record<string, unknown>) {
            insertedBatches.push(row);
            return this;
          },
          select() { return this; },
          single() { return { data: { id: "batch-1" }, error: null }; },
        };
      }
      if (table === "payroll_batch_items") {
        return {
          insert(rows: Record<string, unknown>[]) {
            insertedItems.push(...rows);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    _insertedBatches: insertedBatches,
    _insertedItems: insertedItems,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SAMPLE_SUPPLIER: FakeSupplier = {
  id: "sup-1",
  rut: "11111111",
  name: "Proveedor Conocido",
  normalized_name: "PROVEEDOR CONOCIDO",
  payment_method: "OTC",
  bank_code: "1",
  account_number: "999",
};

test("generatePayrollBatch: nombre con match exacto (normalizado) queda MATCHED con los datos bancarios del proveedor", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    [{ rowNumber: 5, nroDocto: "6050", nombreCliente: "proveedor   conocido", valorTotal: 100000 }],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.matchedCount, 1);
  assert.equal(result.unmatchedCount, 0);
  assert.equal(result.items[0].status, "MATCHED");
  assert.equal(result.items[0].supplier?.rut, "11111111");
});

test("generatePayrollBatch: nombre SIN match queda UNMATCHED, sin datos bancarios inventados", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    [{ rowNumber: 5, nroDocto: "6051", nombreCliente: "PROVEEDOR DESCONOCIDO", valorTotal: 50000 }],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.matchedCount, 0);
  assert.equal(result.unmatchedCount, 1);
  assert.equal(result.items[0].status, "UNMATCHED");
  assert.equal(result.items[0].supplier, null);
});

test("generatePayrollBatch: nunca hace match parcial/fuzzy -- un nombre distinto no calza aunque se parezca", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    [{ rowNumber: 5, nroDocto: "6052", nombreCliente: "Proveedor Conocido SPA", valorTotal: 10000 }],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.items[0].status, "UNMATCHED", "un nombre con texto adicional no conocido nunca debe matchear automáticamente");
});
