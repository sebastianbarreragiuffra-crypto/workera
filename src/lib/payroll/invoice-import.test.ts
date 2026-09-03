import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseInvoiceExcel, generatePayrollBatch, type ParsedInvoiceRow } from "./invoice-import";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

function buildWorkbookBytes(headerRow: (string | number | null)[], headerRowIndex: number, rows: (string | number | null)[][]): Uint8Array {
  const junkRows: (string | number | null)[][] = Array.from({ length: headerRowIndex }, () => [null]);
  const sheetRows: (string | number | null)[][] = [...junkRows, headerRow, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PROVEEDORES");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

const LEGACY_HEADER = ["Nro. Interno", "Nro. Docto.", "Fecha", "Nombre Cliente", "Valor Total ($)", "VENCIMIENTO", "DIAS", "MES", "ESTADO"];

function legacyRow(row: (string | number | null)[]): (string | number | null)[] {
  return row;
}

// ---------------------------------------------------------------------------
// Encabezado: formato histórico exacto (regresión -- nunca debe dejar de funcionar)
test("parseInvoiceExcel: encabezado se encuentra aunque haya filas de título antes (formato real confirmado)", () => {
  const bytes = buildWorkbookBytes(LEGACY_HEADER, 3, [legacyRow([null, "6050", null, "PROVEEDOR FICTICIO", 100000, null, null, null, null])]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.deepEqual(result.valid[0], { rowNumber: 5, nroDocto: "6050", nombreCliente: "PROVEEDOR FICTICIO", rut: null, valorTotal: 100000 });
});

test("parseInvoiceExcel: encabezado se encuentra aunque no esté en la primera hoja (regresión real -- 'Libro1 (1).xlsx' trae 'Gastos mensuales' y 'CUENTAS X COBRAR' antes de 'PROVEEDORES')", () => {
  const gastosSheet = XLSX.utils.aoa_to_sheet([["GASTOS MENSUALES", null], ["Artículo", "Importe"], ["BIOHYDRO", 79420946]]);
  const cuentasSheet = XLSX.utils.aoa_to_sheet([["FACT.", "CLIENTE", "MONTO"], [6050, "OBRAS SUBTERRANEAS S.A", 853825]]);
  const proveedoresSheet = XLSX.utils.aoa_to_sheet([
    ["FACTURAS DE COMPRAS"],
    [null, null, null, null, null, "FECHA DE HOY"],
    [null, null, null, null, null, null, "ATRASO"],
    LEGACY_HEADER,
    [650133, "60488", 46178, "SIGN SHOP", 1565087, 46223, -11, -0.36, "por vencer"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, gastosSheet, "Gastos mensuales");
  XLSX.utils.book_append_sheet(workbook, cuentasSheet, "CUENTAS X COBRAR");
  XLSX.utils.book_append_sheet(workbook, proveedoresSheet, "PROVEEDORES");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].nroDocto, "60488");
  assert.equal(result.valid[0].nombreCliente, "SIGN SHOP");
});

// ---------------------------------------------------------------------------
// Variantes reales de encabezado que Finanzas usa en distintas plantillas
test("parseInvoiceExcel: reconoce 'N° Documento' / 'RUT Proveedor' / 'Monto Total' (variante real distinta a la plantilla histórica)", () => {
  const header = ["N° Documento", "RUT Proveedor", "Nombre Proveedor", "Monto Total"];
  const bytes = buildWorkbookBytes(header, 0, [["F-100", "76.123.456-7", "Constructora ABC", 500000]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.deepEqual(result.valid[0], { rowNumber: 2, nroDocto: "F-100", nombreCliente: "Constructora ABC", rut: "76.123.456-7", valorTotal: 500000 });
});

test("parseInvoiceExcel: reconoce 'Nº Documento' (con Nº en vez de N°/Nro.)", () => {
  const header = ["Nº Documento", "Proveedor", "Total"];
  const bytes = buildWorkbookBytes(header, 0, [["123", "Proveedor X", 1000]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].nroDocto, "123");
});

test("parseInvoiceExcel: reconoce 'Numero Documento' sin tilde ni símbolo", () => {
  const header = ["Numero Documento", "Razón Social", "Valor Documento"];
  const bytes = buildWorkbookBytes(header, 0, [["456", "Otro Proveedor SpA", 2000]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
});

test("parseInvoiceExcel: reconoce encabezados en MAYÚSCULAS y con espacios extra", () => {
  const header = ["  FOLIO  ", "PROVEEDOR", "MONTO"];
  const bytes = buildWorkbookBytes(header, 0, [["789", "Proveedor Y", 3000]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
});

test("parseInvoiceExcel: sin nombre de proveedor -- válido si hay RUT (nombre es opcional cuando hay RUT)", () => {
  const header = ["Documento", "RUT", "Total"];
  const bytes = buildWorkbookBytes(header, 0, [["1", "11.111.111-1", 100]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].nombreCliente, "");
  assert.equal(result.valid[0].rut, "11.111.111-1");
});

test("parseInvoiceExcel: fila con blanco antes del encabezado (no solo filas de título con texto)", () => {
  const bytes = buildWorkbookBytes(LEGACY_HEADER, 2, [legacyRow([null, "1", null, "Proveedor Z", 500, null, null, null, null])]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 1);
});

// ---------------------------------------------------------------------------
// Casos que deben bloquear (a diferencia de un proveedor sin match, que nunca bloquea)
test("parseInvoiceExcel: sin encabezado reconocible -> issue HEADER_NOT_FOUND, valid vacío", () => {
  const sheet = XLSX.utils.aoa_to_sheet([["columna random", "otra"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "HEADER_NOT_FOUND");
});

test("parseInvoiceExcel: HEADER_NOT_FOUND incluye diagnóstico seguro (columnas detectadas + qué falta, sin datos de fila)", () => {
  const header = ["Nombre Proveedor", "Fecha"]; // tiene proveedor, pero le falta documento y monto
  const bytes = buildWorkbookBytes(header, 0, [["Proveedor Cualquiera", "2026-01-01"]]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.issues[0].reason, "HEADER_NOT_FOUND");
  assert.ok(result.diagnostics);
  assert.deepEqual(result.diagnostics!.detectedHeaders, ["Nombre Proveedor"]);
  assert.deepEqual(result.diagnostics!.missingConcepts, ["Número/Folio de documento", "Monto total"]);
});

test("parseInvoiceExcel: dos hojas con encabezado igualmente válido -> AMBIGUOUS_SHEET, nunca adivina cuál usar", () => {
  const sheetA = XLSX.utils.aoa_to_sheet([["Documento", "Proveedor", "Total"], ["1", "A", 100]]);
  const sheetB = XLSX.utils.aoa_to_sheet([["Folio", "Razón Social", "Monto"], ["2", "B", 200]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheetA, "Hoja1");
  XLSX.utils.book_append_sheet(workbook, sheetB, "Hoja2");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "AMBIGUOUS_SHEET");
  assert.deepEqual(result.diagnostics?.candidateSheets, ["Hoja1", "Hoja2"]);
});

test("parseInvoiceExcel: archivo corrupto/no es un Excel real -> se maneja sin lanzar excepción", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "HEADER_NOT_FOUND");
});

test("parseInvoiceExcel: monto no numérico -> issue INVALID_AMOUNT", () => {
  const bytes = buildWorkbookBytes(LEGACY_HEADER, 0, [legacyRow([null, "6050", null, "PROVEEDOR FICTICIO", "no es un monto", null, null, null, null])]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "INVALID_AMOUNT");
});

test("parseInvoiceExcel: sin nombre de proveedor NI rut -> issue MISSING_FIELD (no hay forma de identificar a quién pagarle)", () => {
  const bytes = buildWorkbookBytes(LEGACY_HEADER, 0, [legacyRow([null, "6050", null, "", 100000, null, null, null, null])]);
  const result = parseInvoiceExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "MISSING_FIELD");
});

// ---------------------------------------------------------------------------
// Cruce contra el maestro de proveedores
interface FakeSupplier {
  id: string;
  rut: string;
  name: string;
  normalized_name: string;
  normalized_rut: string;
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
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve: (value: unknown) => void) { resolve({ data: suppliers, error: null }); },
        };
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
  normalized_rut: "111111111",
  payment_method: "OTC",
  bank_code: "1",
  account_number: "999",
};

function row(overrides: Partial<ParsedInvoiceRow>): ParsedInvoiceRow {
  return { rowNumber: 5, nroDocto: "6050", nombreCliente: "", rut: null, valorTotal: 100000, ...overrides };
}

test("generatePayrollBatch: nombre con match exacto (normalizado) queda MATCHED con los datos bancarios del proveedor", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nombreCliente: "proveedor   conocido" })], "facturas.xlsx", "admin-1");
  assert.equal(result.matchedCount, 1);
  assert.equal(result.unmatchedCount, 0);
  assert.equal(result.items[0].status, "MATCHED");
  assert.equal(result.items[0].supplier?.rut, "11111111");
});

test("generatePayrollBatch: RUT con match exacto queda MATCHED aunque el nombre en la factura sea distinto al del maestro", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ rut: "11.111.111-1", nombreCliente: "Nombre Distinto En La Factura" })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].status, "MATCHED");
  assert.equal(result.items[0].supplier?.rut, "11111111");
});

test("generatePayrollBatch: RUT se prefiere sobre nombre -- un RUT que matchea gana aunque el nombre de la fila no matchee", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ rut: "11.111.111-1", nombreCliente: "PROVEEDOR TOTALMENTE DISTINTO" })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].status, "MATCHED", "el RUT es el identificador canónico preferido");
});

test("generatePayrollBatch: RUT sin match cae a nombre como respaldo (formato histórico ya permitido por el negocio)", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ rut: "99.999.999-9", nombreCliente: "Proveedor Conocido" })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].status, "MATCHED");
});

test("generatePayrollBatch: proveedor SIN match -> la factura se conserva en la nómina (nunca se descarta)", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nroDocto: "6051", nombreCliente: "PROVEEDOR DESCONOCIDO", valorTotal: 50000 })], "facturas.xlsx", "admin-1");
  assert.equal(result.items.length, 1);
  assert.equal(result.matchedCount, 0);
  assert.equal(result.unmatchedCount, 1);
  assert.equal(result.items[0].status, "UNMATCHED");
});

test("generatePayrollBatch: proveedor SIN match -> los campos bancarios quedan en blanco, nunca inventados", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nombreCliente: "PROVEEDOR DESCONOCIDO" })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].supplier, null);
});

test("generatePayrollBatch: proveedor SIN match -> el monto y el número de documento de la factura se conservan íntegros", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nroDocto: "F-999", nombreCliente: "Desconocido", valorTotal: 1250000 })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].nroDocto, "F-999");
  assert.equal(result.items[0].valorTotal, 1250000);
});

test("generatePayrollBatch: el monto total del lote se calcula sobre TODAS las facturas válidas, no solo las MATCHED (regresión real -- antes daba $0 si nada matcheaba)", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    COMPANY_ID,
    [row({ nroDocto: "1", nombreCliente: "Proveedor Conocido", valorTotal: 100000 }), row({ nroDocto: "2", nombreCliente: "Desconocido", valorTotal: 50000 })],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.totalAmount, 150000, "100000 (matched) + 50000 (unmatched) -- el monto de una factura sin match no se pierde");
});

test("generatePayrollBatch: monto total se preserva íntegro cuando NINGÚN proveedor matchea (nunca debe dar $0 solo por eso)", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    COMPANY_ID,
    [row({ nroDocto: "1", nombreCliente: "Desconocido A", valorTotal: 500000 }), row({ nroDocto: "2", nombreCliente: "Desconocido B", valorTotal: 750000 })],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.matchedCount, 0);
  assert.equal(result.totalAmount, 1250000);
});

test("generatePayrollBatch: varios proveedores sin match se marcan de forma independiente, cada uno preservando sus propios datos", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(
    supabase,
    COMPANY_ID,
    [row({ nroDocto: "A", nombreCliente: "Desconocido Uno", valorTotal: 100 }), row({ nroDocto: "B", nombreCliente: "Desconocido Dos", valorTotal: 200 })],
    "facturas.xlsx",
    "admin-1"
  );
  assert.equal(result.items.filter((i) => i.status === "UNMATCHED").length, 2);
  assert.deepEqual(result.items.map((i) => i.nroDocto), ["A", "B"]);
});

test("generatePayrollBatch: todos los proveedores matchean -> lote sin ninguna bandera roja", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nombreCliente: "Proveedor Conocido" }), row({ nroDocto: "2", rut: "11.111.111-1" })], "facturas.xlsx", "admin-1");
  assert.equal(result.unmatchedCount, 0);
  assert.ok(result.items.every((i) => i.status === "MATCHED"));
});

test("generatePayrollBatch: la generación se completa exitosamente aunque haya proveedores sin match (nunca es un error fatal)", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  await assert.doesNotReject(() => generatePayrollBatch(supabase, COMPANY_ID, [row({ nombreCliente: "Desconocido" })], "facturas.xlsx", "admin-1"));
});

test("generatePayrollBatch: nunca hace match parcial/fuzzy -- un nombre distinto no calza aunque se parezca", async () => {
  const supabase = mockSupabase([SAMPLE_SUPPLIER]);
  const result = await generatePayrollBatch(supabase, COMPANY_ID, [row({ nroDocto: "6052", nombreCliente: "Proveedor Conocido SPA", valorTotal: 10000 })], "facturas.xlsx", "admin-1");
  assert.equal(result.items[0].status, "UNMATCHED", "un nombre con texto adicional no conocido nunca debe matchear automáticamente");
});
