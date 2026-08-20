import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseSuppliersExcel, importSuppliers } from "./suppliers-import";

function buildWorkbookBytes(rows: (string | number | null)[][]): Uint8Array {
  const sheetRows: (string | number | null)[][] = [["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte."], ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Beneficiarios");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

test("parseSuppliersExcel: fila completa se parsea correctamente", () => {
  const bytes = buildWorkbookBytes([["11111111", "PROVEEDOR FICTICIO SPA", "OTC", "1", "12345678"]]);
  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.valid[0], { rowNumber: 2, rut: "11111111", name: "PROVEEDOR FICTICIO SPA", paymentMethod: "OTC", bankCode: "1", accountNumber: "12345678" });
});

test("parseSuppliersExcel: fila con campo faltante se reporta como issue, no se incluye en valid", () => {
  const bytes = buildWorkbookBytes([["11111111", "", "OTC", "1", "12345678"]]);
  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.issues, [{ rowNumber: 2, reason: "MISSING_FIELD" }]);
});

test("parseSuppliersExcel: archivo equivocado (formato de facturas mensuales, sin FP/BCO/Cuenta) -> HEADER_NOT_FOUND, nunca '0 filas válidas' sin explicación", () => {
  // Regresión real: un usuario subió el mockup de facturas (Nro. Docto./Nombre Cliente/Valor Total)
  // al importador de proveedores por error -- debe detectarse como archivo equivocado, no como archivo vacío.
  const sheet = XLSX.utils.aoa_to_sheet([["Nro. Interno", "Nro. Docto.", "Fecha", "Nombre Cliente", "Valor Total ($)"], [1, "6050", "2026-08-01", "PROVEEDOR FICTICIO", 100000]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PROVEEDORES");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.issues, [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }]);
});

test("parseSuppliersExcel: encabezado se encuentra aunque no esté en la primera hoja del archivo", () => {
  const irrelevantSheet = XLSX.utils.aoa_to_sheet([["algo", "irrelevante"]]);
  const suppliersSheet = XLSX.utils.aoa_to_sheet([["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte."], ["11111111", "PROVEEDOR FICTICIO SPA", "OTC", "1", "12345678"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, irrelevantSheet, "Portada");
  XLSX.utils.book_append_sheet(workbook, suppliersSheet, "Beneficiarios");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 1);
});

test("parseSuppliersExcel: encabezado se encuentra aunque tenga filas de título antes (no asume fila 0)", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["LISTADO DE PROVEEDORES"],
    [],
    ["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte."],
    ["11111111", "PROVEEDOR FICTICIO SPA", "OTC", "1", "12345678"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Beneficiarios");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].rowNumber, 4);
});

test("parseSuppliersExcel: fila en blanco se ignora sin reportar issue", () => {
  const bytes = buildWorkbookBytes([[null, null, null, null, null], ["11111111", "PROVEEDOR FICTICIO SPA", "OTC", "1", "12345678"]]);
  const result = parseSuppliersExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.issues.length, 0);
});

function mockSupabase(existingNormalizedNames: string[], inserted: { upserted?: unknown[] } = {}) {
  return {
    from() {
      return {
        select() {
          return { data: existingNormalizedNames.map((n) => ({ normalized_name: n })), error: null };
        },
        upsert(rows: unknown[]) {
          inserted.upserted = rows;
          return Promise.resolve({ error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("importSuppliers: proveedor nuevo se cuenta como imported, no updated", async () => {
  const inserted: { upserted?: unknown[] } = {};
  const supabase = mockSupabase([], inserted);
  const result = await importSuppliers(
    supabase,
    [{ rowNumber: 2, rut: "11111111", name: "PROVEEDOR NUEVO", paymentMethod: "OTC", bankCode: "1", accountNumber: "12345678" }],
    "admin-1"
  );
  assert.equal(result.imported, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal((inserted.upserted as { normalized_name: string }[])[0].normalized_name, "PROVEEDOR NUEVO");
});

test("importSuppliers: proveedor ya existente (mismo nombre normalizado) se cuenta como updated", async () => {
  const supabase = mockSupabase(["PROVEEDOR EXISTENTE"]);
  const result = await importSuppliers(
    supabase,
    [{ rowNumber: 2, rut: "11111111", name: "Proveedor Existente", paymentMethod: "OTC", bankCode: "1", accountNumber: "12345678" }],
    "admin-1"
  );
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 1);
});

test("importSuppliers: mismo nombre normalizado con datos bancarios distintos dentro del archivo -> conflicto, NO importa nada", async () => {
  const supabase = mockSupabase([]);
  const result = await importSuppliers(
    supabase,
    [
      { rowNumber: 2, rut: "11111111", name: "PROVEEDOR AMBIGUO", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" },
      { rowNumber: 3, rut: "22222222", name: "Proveedor Ambiguo", paymentMethod: "OTC", bankCode: "1", accountNumber: "222" },
    ],
    "admin-1"
  );
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].normalizedName, "PROVEEDOR AMBIGUO");
  assert.deepEqual(result.conflicts[0].rows, [2, 3]);
});

test("importSuppliers: filas exactamente duplicadas (mismo nombre y mismos datos bancarios) NO son conflicto", async () => {
  const supabase = mockSupabase([]);
  const row = { rut: "11111111", name: "PROVEEDOR DUPLICADO", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" };
  const result = await importSuppliers(
    supabase,
    [
      { rowNumber: 2, ...row },
      { rowNumber: 3, ...row },
    ],
    "admin-1"
  );
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.imported, 1);
});
