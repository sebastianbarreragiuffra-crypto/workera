import assert from "node:assert/strict";
import test from "node:test";
import { buildExpenseAccountingCsv, safeSpreadsheetText } from "./csv";
import { parseExpenseAccountingPayload } from "./payload";
import { validAccountingPayload } from "./fixture";

test("neutraliza fórmulas de Excel y elimina saltos de línea", () => {
  assert.equal(safeSpreadsheetText("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(safeSpreadsheetText("+SUM(A1:A2)"), "'+SUM(A1:A2)");
  assert.equal(safeSpreadsheetText("Hola\r\nMundo"), "Hola Mundo");
  assert.equal(safeSpreadsheetText("ABC\u202Etxt"), "ABCtxt");
});

test("genera CSV contable estable, escapado y sin datos de comprobantes", () => {
  const raw = structuredClone(validAccountingPayload);
  raw.lines[0].merchant = "=PROVEEDOR";
  raw.lines[0].description = "Taxi, aeropuerto";
  const csv = buildExpenseAccountingCsv(parseExpenseAccountingPayload(raw));
  assert.match(csv, /^"Fecha","Folio rendición"/);
  assert.match(csv, /"'=PROVEEDOR"/);
  assert.match(csv, /"Taxi, aeropuerto"/);
  assert.doesNotMatch(csv, /receipt|storage|extraction/i);
});
