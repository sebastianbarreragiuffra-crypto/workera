import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseSuppliersExcel, importSuppliers, deactivateSupplier } from "./suppliers-import";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

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

interface ExistingSupplierRow {
  normalized_name: string;
  name: string;
  active: boolean;
}

interface CapturedSupplierCalls {
  selectedCompanyId?: string;
  upserted?: unknown[];
  updated?: { companyId: string; normalizedName: string; patch: unknown };
}

function mockSupabase(existing: ExistingSupplierRow[], captured: CapturedSupplierCalls = {}) {
  return {
    from() {
      return {
        select() {
          return {
            eq(_col: string, companyId: string) {
              captured.selectedCompanyId = companyId;
              return Promise.resolve({ data: existing, error: null });
            },
          };
        },
        upsert(rows: unknown[]) {
          captured.upserted = rows;
          return Promise.resolve({ error: null });
        },
        update(patch: unknown) {
          return {
            eq(_col: string, companyId: string) {
              return {
                eq(_nameCol: string, normalizedName: string) {
                  captured.updated = { companyId, normalizedName, patch };
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Compatibilidad con los tests existentes, que solo les importan nombres normalizados ya existentes (sin distinguir activo/inactivo ni nombre real). */
function mockSupabaseByNames(existingNormalizedNames: string[], inserted: { upserted?: unknown[] } = {}) {
  return mockSupabase(
    existingNormalizedNames.map((n) => ({ normalized_name: n, name: n, active: true })),
    inserted
  );
}

test("importSuppliers: proveedor nuevo se cuenta como imported, no updated", async () => {
  const inserted: { upserted?: unknown[] } = {};
  const supabase = mockSupabase([], inserted);
  const result = await importSuppliers(
    supabase,
    COMPANY_ID,
    [{ rowNumber: 2, rut: "11111111", name: "PROVEEDOR NUEVO", paymentMethod: "OTC", bankCode: "1", accountNumber: "12345678" }],
    "admin-1"
  );
  assert.equal(result.imported, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.conflicts.length, 0);
  const insertedSupplier = (inserted.upserted as { company_id: string; normalized_name: string }[])[0];
  assert.equal(insertedSupplier.company_id, COMPANY_ID);
  assert.equal(insertedSupplier.normalized_name, "PROVEEDOR NUEVO");
});

test("importSuppliers: proveedor ya existente (mismo nombre normalizado) se cuenta como updated", async () => {
  const supabase = mockSupabaseByNames(["PROVEEDOR EXISTENTE"]);
  const result = await importSuppliers(
    supabase,
    COMPANY_ID,
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
    COMPANY_ID,
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
    COMPANY_ID,
    [
      { rowNumber: 2, ...row },
      { rowNumber: 3, ...row },
    ],
    "admin-1"
  );
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.imported, 1);
});

test("importSuppliers: un proveedor ACTIVO ausente del archivo nuevo se reporta en absentActiveSuppliers, nunca se desactiva solo", async () => {
  const supabase = mockSupabase([
    { normalized_name: "PROVEEDOR AUSENTE", name: "Proveedor Ausente", active: true },
    { normalized_name: "PROVEEDOR PRESENTE", name: "Proveedor Presente", active: true },
  ]);
  const result = await importSuppliers(
    supabase,
    COMPANY_ID,
    [{ rowNumber: 2, rut: "11111111", name: "Proveedor Presente", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" }],
    "admin-1"
  );
  assert.deepEqual(result.absentActiveSuppliers, [{ normalizedName: "PROVEEDOR AUSENTE", name: "Proveedor Ausente" }]);
});

test("importSuppliers: un proveedor ya INACTIVO ausente del archivo no se reporta (ya se sabía que no está vigente)", async () => {
  const supabase = mockSupabase([{ normalized_name: "PROVEEDOR INACTIVO", name: "Proveedor Inactivo", active: false }]);
  const result = await importSuppliers(
    supabase,
    COMPANY_ID,
    [{ rowNumber: 2, rut: "11111111", name: "Proveedor Nuevo", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" }],
    "admin-1"
  );
  assert.deepEqual(result.absentActiveSuppliers, []);
});

test("importSuppliers: si el proveedor SÍ aparece en el archivo, nunca se reporta como ausente aunque esté activo", async () => {
  const supabase = mockSupabase([{ normalized_name: "PROVEEDOR PRESENTE", name: "Proveedor Presente", active: true }]);
  const result = await importSuppliers(
    supabase,
    COMPANY_ID,
    [{ rowNumber: 2, rut: "11111111", name: "Proveedor Presente", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" }],
    "admin-1"
  );
  assert.deepEqual(result.absentActiveSuppliers, []);
});

test("deactivateSupplier: actualiza active=false filtrando por empresa y normalized_name", async () => {
  const captured: CapturedSupplierCalls = {};
  const supabase = mockSupabase([], captured);
  await deactivateSupplier(supabase, COMPANY_ID, "PROVEEDOR A DAR DE BAJA");
  assert.deepEqual(captured.updated, {
    companyId: COMPANY_ID,
    normalizedName: "PROVEEDOR A DAR DE BAJA",
    patch: { active: false },
  });
});

test("importSuppliers: si un proveedor inactivo reaparece, el upsert lo reactiva", async () => {
  const captured: { upserted?: unknown[] } = {};
  const supabase = mockSupabase(
    [{ normalized_name: "PROVEEDOR QUE VOLVIO", name: "Proveedor que volvió", active: false }],
    captured
  );
  await importSuppliers(
    supabase,
    COMPANY_ID,
    [{ rowNumber: 2, rut: "11111111", name: "Proveedor que volvió", paymentMethod: "OTC", bankCode: "1", accountNumber: "111" }],
    "admin-1"
  );
  assert.equal((captured.upserted as Array<{ active: boolean }>)[0].active, true);
});

test("deactivateSupplier: rechaza un identificador vacío antes de consultar la base", async () => {
  await assert.rejects(() => deactivateSupplier(mockSupabase([]), COMPANY_ID, ""), /inválido/);
});
