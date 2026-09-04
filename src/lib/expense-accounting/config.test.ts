import "server-only";
import assert from "node:assert/strict";
import test from "node:test";
import {
  isExpenseAccountingExpectedActive,
  readExpenseAccountingConfig,
  readExpenseAccountingWatchdogStaleSeconds,
} from "./config";

const names = [
  "EXPENSE_ACCOUNTING_EXPORT_ENABLED",
  "EXPENSE_ACCOUNTING_PROVIDER",
  "EXPENSE_ACCOUNTING_BATCH_SIZE",
  "EXPENSE_ACCOUNTING_MAX_BATCHES",
  "EXPENSE_ACCOUNTING_MAX_RUNTIME_MS",
  "EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS",
  "EXPENSE_ACCOUNTING_WATCHDOG_STALE_SECONDS",
  "EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED",
] as const;

function withEnv(values: Partial<Record<(typeof names)[number], string>>, run: () => void): void {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    run();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("contabilidad permanece fail-closed salvo true literal", () => {
  withEnv({ EXPENSE_ACCOUNTING_EXPORT_ENABLED: "TRUE", EXPENSE_ACCOUNTING_PROVIDER: "dry-run" }, () => {
    assert.deepEqual(readExpenseAccountingConfig(), { enabled: false, provider: "disabled" });
  });
});

test("configuración operativa usa límites seguros por defecto", () => {
  withEnv({ EXPENSE_ACCOUNTING_EXPORT_ENABLED: "true", EXPENSE_ACCOUNTING_PROVIDER: "dry-run" }, () => {
    assert.deepEqual(readExpenseAccountingConfig(), {
      enabled: true,
      provider: "dry-run",
      batchSize: 10,
      maxBatches: 4,
      maxRuntimeMs: 45_000,
      jobTimeoutMs: 10_000,
      watchdogStaleSeconds: 93_600,
    });
  });
});

test("configuración operativa acepta solo enteros dentro de sus cotas", () => {
  withEnv({
    EXPENSE_ACCOUNTING_EXPORT_ENABLED: "true",
    EXPENSE_ACCOUNTING_PROVIDER: "dry-run",
    EXPENSE_ACCOUNTING_BATCH_SIZE: "25",
    EXPENSE_ACCOUNTING_MAX_BATCHES: "10",
    EXPENSE_ACCOUNTING_MAX_RUNTIME_MS: "50000",
    EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS: "30000",
    EXPENSE_ACCOUNTING_WATCHDOG_STALE_SECONDS: "604800",
  }, () => {
    const config = readExpenseAccountingConfig();
    assert.equal(config.enabled, true);
    if (!config.enabled) return;
    assert.equal(config.batchSize, 25);
    assert.equal(config.maxBatches, 10);
    assert.equal(config.maxRuntimeMs, 50_000);
    assert.equal(config.jobTimeoutMs, 30_000);
    assert.equal(config.watchdogStaleSeconds, 604_800);
  });
});

test("timeout por trabajo siempre deja margen para cerrar el lease", () => {
  withEnv({
    EXPENSE_ACCOUNTING_EXPORT_ENABLED: "true",
    EXPENSE_ACCOUNTING_PROVIDER: "dry-run",
    EXPENSE_ACCOUNTING_MAX_RUNTIME_MS: "5000",
    EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS: "5000",
  }, () => {
    assert.throws(() => readExpenseAccountingConfig(), /debe dejar al menos 1 segundo/);
  });
});

test("el monitor solo espera operación activa con true literal", () => {
  withEnv({ EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED: "TRUE" }, () => {
    assert.equal(isExpenseAccountingExpectedActive(), false);
  });
  withEnv({ EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED: "true" }, () => {
    assert.equal(isExpenseAccountingExpectedActive(), true);
  });
});

test("el watchdog conserva su umbral aunque el procesamiento esté pausado", () => {
  withEnv({
    EXPENSE_ACCOUNTING_EXPORT_ENABLED: "false",
    EXPENSE_ACCOUNTING_WATCHDOG_STALE_SECONDS: "7200",
  }, () => {
    assert.equal(readExpenseAccountingConfig().enabled, false);
    assert.equal(readExpenseAccountingWatchdogStaleSeconds(), 7_200);
  });
});

test("una cota inválida falla cerrado antes de reclamar la cola", () => {
  withEnv({
    EXPENSE_ACCOUNTING_EXPORT_ENABLED: "true",
    EXPENSE_ACCOUNTING_PROVIDER: "dry-run",
    EXPENSE_ACCOUNTING_BATCH_SIZE: "26",
  }, () => {
    assert.throws(() => readExpenseAccountingConfig(), /fuera del rango permitido/);
  });
});
