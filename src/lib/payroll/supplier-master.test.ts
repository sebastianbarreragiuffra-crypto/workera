import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { validateFileMeta, computeSupplierMasterPreview, applySupplierMasterImport } from "./supplier-master";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

function buildWorkbookBytes(rows: (string | number | null)[][]): Uint8Array {
  const sheetRows: (string | number | null)[][] = [["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte."], ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Beneficiarios");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

interface CurrentSupplierRow {
  normalized_rut: string;
  name: string;
  payment_method: string;
  bank_code: string;
  account_number: string;
}

/**
 * Mock mínimo de SupabaseClient para probar la lógica de negocio en
 * aislamiento -- registra cada operación (`calls`) para que los tests de
 * la secuencia de reemplazo puedan verificar el ORDEN y simular fallos en
 * cualquier paso.
 */
function mockSupabase(opts: { currentSuppliers?: CurrentSupplierRow[]; failAt?: "upload" | "apply" }) {
  const calls: string[] = [];
  const { currentSuppliers = [], failAt } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "suppliers") {
        return {
          select() {
            return {
              eq() { return this; },
              then(resolve: (value: unknown) => void) { resolve({ data: currentSuppliers, error: null }); },
            };
          },
        };
      }
      throw new Error(`mockSupabase: tabla no soportada en el test: ${table}`);
    },
    storage: {
      from(_bucket: string) {
        void _bucket;
        return {
          upload(_path: string, _bytes: Uint8Array) {
            void _path;
            void _bytes;
            calls.push("upload");
            if (failAt === "upload") return Promise.resolve({ error: { message: "boom upload" } });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
    rpc(fnName: string, _args: unknown) {
      void _args;
      calls.push(fnName);
      if (failAt === "apply") return Promise.resolve({ error: { message: "boom apply (transacción revertida)" } });
      return Promise.resolve({ error: null });
    },
  };

  return { client, calls };
}

test("validateFileMeta: rechaza extensión no soportada", () => {
  const result = validateFileMeta("archivo.docx", 100);
  assert.equal(result.ok, false);
});

test("validateFileMeta: rechaza archivo vacío", () => {
  const result = validateFileMeta("archivo.xlsx", 0);
  assert.equal(result.ok, false);
});

test("validateFileMeta: rechaza archivo que excede el máximo permitido", () => {
  const result = validateFileMeta("archivo.xlsx", 6 * 1024 * 1024);
  assert.equal(result.ok, false);
});

test("validateFileMeta: acepta un .xlsx dentro del límite", () => {
  const result = validateFileMeta("archivo.xlsx", 1024);
  assert.equal(result.ok, true);
});

test("computeSupplierMasterPreview: proveedor sin coincidencia en el maestro actual -> NEW", async () => {
  const { client } = mockSupabase({ currentSuppliers: [] });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR NUEVO", "OTC", "1", "12345"]]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.ok, true);
  assert.equal(preview.newCount, 1);
  assert.equal(preview.rows[0].status, "NEW");
});

test("computeSupplierMasterPreview: mismo RUT, mismos datos bancarios -> UNCHANGED", async () => {
  const { client } = mockSupabase({
    currentSuppliers: [{ normalized_rut: "111111111", name: "PROVEEDOR IGUAL", payment_method: "OTC", bank_code: "1", account_number: "12345" }],
  });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR IGUAL", "OTC", "1", "12345"]]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.unchangedCount, 1);
  assert.equal(preview.rows[0].status, "UNCHANGED");
});

test("computeSupplierMasterPreview: mismo RUT, cuenta bancaria distinta -> UPDATED", async () => {
  const { client } = mockSupabase({
    currentSuppliers: [{ normalized_rut: "111111111", name: "PROVEEDOR CAMBIO", payment_method: "OTC", bank_code: "1", account_number: "OLD-999" }],
  });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR CAMBIO", "OTC", "1", "NEW-000"]]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.updatedCount, 1);
  assert.equal(preview.rows[0].status, "UPDATED");
});

test("computeSupplierMasterPreview: mismo RUT repetido con datos idénticos en el archivo -> se deduplica, no es error", async () => {
  const { client } = mockSupabase({ currentSuppliers: [] });
  const row = ["11.111.111-1", "PROVEEDOR REPETIDO", "OTC", "1", "12345"];
  const bytes = buildWorkbookBytes([row, row]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.ok, true);
  assert.equal(preview.totalFound, 1);
});

test("computeSupplierMasterPreview: mismo RUT repetido con datos bancarios distintos en el archivo -> conflicto, bloquea todo el archivo", async () => {
  const { client } = mockSupabase({ currentSuppliers: [] });
  const bytes = buildWorkbookBytes([
    ["11.111.111-1", "PROVEEDOR AMBIGUO", "OTC", "1", "111"],
    ["11.111.111-1", "PROVEEDOR AMBIGUO", "OTC", "1", "222"],
  ]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.ok, false);
  assert.match(preview.blockingError ?? "", /aparece más de una vez/);
});

test("computeSupplierMasterPreview: archivo sin las columnas esperadas -> bloqueado con mensaje claro", async () => {
  const { client } = mockSupabase({ currentSuppliers: [] });
  const sheet = XLSX.utils.aoa_to_sheet([["Nro. Docto.", "Nombre Cliente", "Valor Total ($)"], ["6050", "ALGUIEN", 100]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.ok, false);
  assert.match(preview.blockingError ?? "", /columnas esperadas/);
});

test("computeSupplierMasterPreview: fila con campo faltante se reporta como error, no bloquea el resto del archivo", async () => {
  const { client } = mockSupabase({ currentSuppliers: [] });
  const bytes = buildWorkbookBytes([
    ["11.111.111-1", "PROVEEDOR OK", "OTC", "1", "12345"],
    ["22.222.222-2", "", "OTC", "1", "999"],
  ]);
  const preview = await computeSupplierMasterPreview(client, COMPANY_ID, bytes);
  assert.equal(preview.ok, true);
  assert.equal(preview.newCount, 1);
  assert.equal(preview.errorCount, 1);
});

test("applySupplierMasterImport: primer maestro -- sube el archivo y aplica todo en una sola llamada atómica (RPC)", async () => {
  const { client, calls } = mockSupabase({ currentSuppliers: [] });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR NUEVO", "OTC", "1", "12345"]]);
  const result = await applySupplierMasterImport(client, { companyId: COMPANY_ID, fileBytes: bytes, filename: "maestro.xlsx", uploadedBy: "admin-1" });

  assert.equal(result.insertedCount, 1);
  assert.deepEqual(calls, ["upload", "apply_supplier_master_import"]);
});

test("applySupplierMasterImport: si falla la subida a Storage, nunca se llega a llamar la función de persistencia", async () => {
  const { client, calls } = mockSupabase({ currentSuppliers: [], failAt: "upload" });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR NUEVO", "OTC", "1", "12345"]]);
  await assert.rejects(() => applySupplierMasterImport(client, { companyId: COMPANY_ID, fileBytes: bytes, filename: "maestro.xlsx", uploadedBy: "admin-1" }));
  assert.deepEqual(calls, ["upload"]);
});

test("applySupplierMasterImport: si la función de persistencia (transacción) falla, se reporta el error -- nada quedó a medias porque todo ocurrió en una sola transacción de base de datos", async () => {
  const { client, calls } = mockSupabase({ currentSuppliers: [], failAt: "apply" });
  const bytes = buildWorkbookBytes([["11.111.111-1", "PROVEEDOR NUEVO", "OTC", "1", "12345"]]);
  await assert.rejects(
    () => applySupplierMasterImport(client, { companyId: COMPANY_ID, fileBytes: bytes, filename: "maestro.xlsx", uploadedBy: "admin-1" }),
    /transacción revertida/
  );
  assert.deepEqual(calls, ["upload", "apply_supplier_master_import"]);
});

test("applySupplierMasterImport: archivo inválido (encabezado no encontrado) nunca llega a subir nada a Storage", async () => {
  const { client, calls } = mockSupabase({ currentSuppliers: [] });
  const sheet = XLSX.utils.aoa_to_sheet([["Nro. Docto.", "Nombre Cliente", "Valor Total ($)"], ["6050", "ALGUIEN", 100]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  await assert.rejects(() => applySupplierMasterImport(client, { companyId: COMPANY_ID, fileBytes: bytes, filename: "maestro.xlsx", uploadedBy: "admin-1" }));
  assert.deepEqual(calls, []);
});
