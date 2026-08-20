import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildPayrollExportWorkbook } from "./payroll-export";
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

test("buildPayrollExportWorkbook: encabezado exacto del formato BCI confirmado", () => {
  const bytes = buildPayrollExportWorkbook([MATCHED_ITEM]);
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
  assert.deepEqual(rows[0], ["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte.", "N° Documento", "Monto a pago"]);
});

test("buildPayrollExportWorkbook: solo incluye ítems MATCHED, nunca UNMATCHED (nunca inventa datos bancarios)", () => {
  const bytes = buildPayrollExportWorkbook([MATCHED_ITEM, UNMATCHED_ITEM]);
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
  assert.equal(rows.length, 2); // encabezado + 1 fila matched
  assert.equal(rows[1][0], "11111111");
});

test("buildPayrollExportWorkbook: fila coincide exactamente con los datos del proveedor + documento/monto de la factura", () => {
  const bytes = buildPayrollExportWorkbook([MATCHED_ITEM]);
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
  assert.deepEqual(rows[1], ["11111111", "Proveedor Conocido", "OTC", "1", "999", "6050", 100000]);
});
