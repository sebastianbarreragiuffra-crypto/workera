import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildPayrollExportWorkbook, SUPPLIER_NOT_FOUND_STATUS } from "./payroll-export";
import type { PayrollBatchItemResult } from "./invoice-import";

const MATCHED_ITEM: PayrollBatchItemResult = {
  nroDocto: "6050",
  nombreCliente: "Proveedor Conocido",
  valorTotal: 100000,
  status: "MATCHED",
  supplier: { rut: "11111111", name: "Proveedor Conocido", paymentMethod: "OTC", bankCode: "1", accountNumber: "999" },
};

const UNMATCHED_ITEM: PayrollBatchItemResult = {
  nroDocto: "6051",
  nombreCliente: "Proveedor Desconocido",
  valorTotal: 50000,
  status: "UNMATCHED",
  supplier: null,
};

function readRows(bytes: Uint8Array): (string | number)[][] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
}

test("buildPayrollExportWorkbook: encabezado exacto (BCI + columnas de trazabilidad/estado)", () => {
  const rows = readRows(buildPayrollExportWorkbook([MATCHED_ITEM]));
  assert.deepEqual(rows[0], ["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte.", "N° Documento", "Monto a pago", "Nombre Cliente (Factura)", "Estado"]);
});

test("proveedor encontrado -> fila con los datos del proveedor correctamente poblados", () => {
  const rows = readRows(buildPayrollExportWorkbook([MATCHED_ITEM]));
  assert.deepEqual(rows[1], ["11111111", "Proveedor Conocido", "OTC", "1", "999", "6050", 100000, "Proveedor Conocido", "OK"]);
});

test("proveedor sin match -> la fila de la factura NUNCA se excluye del Excel", () => {
  const rows = readRows(buildPayrollExportWorkbook([MATCHED_ITEM, UNMATCHED_ITEM]));
  assert.equal(rows.length, 3, "encabezado + 2 filas (una MATCHED, una UNMATCHED) -- ninguna se descarta");
});

test("proveedor sin match -> los campos dependientes del maestro quedan en blanco (nunca se inventan)", () => {
  const rows = readRows(buildPayrollExportWorkbook([UNMATCHED_ITEM]));
  const [rut, nombreBeneficiario, fp, bco, cuenta] = rows[1];
  assert.deepEqual([rut, nombreBeneficiario, fp, bco, cuenta], ["", "", "", "", ""]);
});

test("proveedor sin match -> se marca con la bandera roja de revisión (columna Estado)", () => {
  const rows = readRows(buildPayrollExportWorkbook([UNMATCHED_ITEM]));
  assert.equal(rows[1][8], SUPPLIER_NOT_FOUND_STATUS);
  assert.match(String(rows[1][8]), /PROVEEDOR_NO_ENCONTRADO/);
});

test("proveedor sin match -> los datos de la factura (documento, monto, nombre cliente) se conservan íntegros", () => {
  const rows = readRows(buildPayrollExportWorkbook([UNMATCHED_ITEM]));
  const [, , , , , nroDocto, monto, nombreCliente] = rows[1];
  assert.equal(nroDocto, "6051");
  assert.equal(monto, 50000);
  assert.equal(nombreCliente, "Proveedor Desconocido");
});

test("múltiples proveedores sin match -> cada uno se marca de forma independiente", () => {
  const second: PayrollBatchItemResult = { ...UNMATCHED_ITEM, nroDocto: "6099", nombreCliente: "Otro Desconocido", valorTotal: 7000 };
  const rows = readRows(buildPayrollExportWorkbook([UNMATCHED_ITEM, second]));
  assert.equal(rows.length, 3);
  assert.equal(rows[1][8], SUPPLIER_NOT_FOUND_STATUS);
  assert.equal(rows[2][8], SUPPLIER_NOT_FOUND_STATUS);
  assert.equal(rows[1][5], "6051");
  assert.equal(rows[2][5], "6099");
});

test("proveedores encontrados no se ven afectados por filas sin match en el mismo lote", () => {
  const rows = readRows(buildPayrollExportWorkbook([UNMATCHED_ITEM, MATCHED_ITEM]));
  const matchedRow = rows.find((r) => r[5] === "6050")!;
  assert.deepEqual(matchedRow, ["11111111", "Proveedor Conocido", "OTC", "1", "999", "6050", 100000, "Proveedor Conocido", "OK"]);
});

test("el Excel final combina, en una sola fila por factura, datos de la factura y del maestro de proveedores", () => {
  const rows = readRows(buildPayrollExportWorkbook([MATCHED_ITEM]));
  const row = rows[1];
  // columnas del maestro (Rut/Nombre Beneficiario/FP/BCO/Cuenta) + columnas de la factura (Documento/Monto/Nombre Cliente) en la MISMA fila.
  assert.equal(row[0], MATCHED_ITEM.supplier!.rut);
  assert.equal(row[5], MATCHED_ITEM.nroDocto);
  assert.equal(row[6], MATCHED_ITEM.valorTotal);
});
