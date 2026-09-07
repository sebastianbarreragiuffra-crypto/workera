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

test("cloudmersive exige transferencia aprobada, tenant privado y secreto fuerte", () => {
  const valid = {
    EXPENSE_FILE_SCAN_ENABLED: "true",
    EXPENSE_FILE_SCAN_PROVIDER: "cloudmersive-advanced",
    EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED: "true",
    CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN: "https://scanner-private.example/",
    CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME: "scanner-private.example",
    CLOUDMERSIVE_API_KEY: "fake-cloudmersive-key-for-tests-000000000000",
    EXPENSE_FILE_SCAN_REQUEST_TIMEOUT_MS: "12000",
    NODE_ENV: "production",
  };
  assert.deepEqual(readExpenseFileScanConfig(valid), {
    enabled: true,
    provider: "cloudmersive-advanced",
    origin: "https://scanner-private.example",
    apiKey: "fake-cloudmersive-key-for-tests-000000000000",
    timeoutMs: 12000,
    maxFilesPerRun: 10,
    maxRuntimeMs: 45000,
  });

  for (const override of [
    { EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED: "false" },
    {
      CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN: "https://api.cloudmersive.com",
      CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME: "api.cloudmersive.com",
    },
    { CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN: "http://scanner-private.example" },
    { CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN: "https://scanner-private.example/base" },
    { CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME: "otro-host.example" },
    {
      CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME: "127.0.0.1",
      CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN: "https://127.0.0.1",
    },
    { CLOUDMERSIVE_API_KEY: "short" },
    { EXPENSE_FILE_SCAN_REQUEST_TIMEOUT_MS: "999" },
    { EXPENSE_FILE_SCAN_MAX_FILES_PER_RUN: "26" },
    { EXPENSE_FILE_SCAN_MAX_RUNTIME_MS: "12000", EXPENSE_FILE_SCAN_REQUEST_TIMEOUT_MS: "12000" },
  ]) {
    assert.throws(() => readExpenseFileScanConfig({ ...valid, ...override }), /proveedor antimalware habilitable/);
  }
});
