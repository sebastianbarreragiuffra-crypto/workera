import assert from "node:assert/strict";
import test from "node:test";
import { EXPENSE_STATUS_LABEL, expenseStatusTone, formatExpenseMoney } from "./presentation";

test("los estados de Rendiciones siempre tienen etiqueta en español", () => {
  assert.deepEqual(Object.keys(EXPENSE_STATUS_LABEL).sort(), [
    "APPROVED", "CANCELLED", "DRAFT", "IN_REVIEW", "PAID", "REJECTED", "SUBMITTED",
  ]);
});

test("los estados aprobados/rechazados/en revisión no dependen solo del texto", () => {
  assert.equal(expenseStatusTone("APPROVED"), "positive");
  assert.equal(expenseStatusTone("REJECTED"), "negative");
  assert.equal(expenseStatusTone("SUBMITTED"), "warning");
  assert.equal(expenseStatusTone("DRAFT"), "neutral");
});

test("los montos se presentan con su moneda y formato chileno", () => {
  assert.match(formatExpenseMoney(17850, "CLP"), /17\.850/);
  assert.match(formatExpenseMoney(25.5, "USD"), /25,50/);
});
