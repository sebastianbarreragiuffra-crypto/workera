import assert from "node:assert/strict";
import test from "node:test";
import { readExpenseFileScanConfig } from "./config";

test("el scanner queda apagado ante ausencia o typo del flag", () => {
  assert.deepEqual(readExpenseFileScanConfig({}), { enabled: false, provider: "disabled" });
  assert.deepEqual(readExpenseFileScanConfig({ EXPENSE_FILE_SCAN_ENABLED: "TRUE" }), {
    enabled: false,
    provider: "disabled",
  });
});

test("fixture exige doble opt-in y nunca se habilita en production", () => {
  assert.throws(
    () => readExpenseFileScanConfig({
      EXPENSE_FILE_SCAN_ENABLED: "true",
      EXPENSE_FILE_SCAN_PROVIDER: "fixture",
      NODE_ENV: "test",
    }),
    /proveedor antimalware habilitable/,
  );
  assert.throws(
    () => readExpenseFileScanConfig({
      EXPENSE_FILE_SCAN_ENABLED: "true",
      EXPENSE_FILE_SCAN_PROVIDER: "fixture",
      EXPENSE_FILE_SCAN_ALLOW_FIXTURE: "true",
      NODE_ENV: "production",
    }),
    /proveedor antimalware habilitable/,
  );
  assert.deepEqual(readExpenseFileScanConfig({
    EXPENSE_FILE_SCAN_ENABLED: "true",
    EXPENSE_FILE_SCAN_PROVIDER: "fixture",
    EXPENSE_FILE_SCAN_ALLOW_FIXTURE: "true",
    NODE_ENV: "test",
  }), { enabled: true, provider: "fixture" });
});

test("habilitar sin un adapter real falla cerrado", () => {
  assert.throws(
    () => readExpenseFileScanConfig({
      EXPENSE_FILE_SCAN_ENABLED: "true",
      EXPENSE_FILE_SCAN_PROVIDER: "disabled",
      NODE_ENV: "production",
    }),
    /proveedor antimalware habilitable/,
  );
});
