import "server-only";

export type ExpenseAccountingConfig =
  | { enabled: false; provider: "disabled" }
  | {
      enabled: true;
      provider: "dry-run";
      batchSize: number;
      maxBatches: number;
      maxRuntimeMs: number;
      jobTimeoutMs: number;
      watchdogStaleSeconds: number;
    };

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} debe ser un entero.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} está fuera del rango permitido.`);
  }
  return value;
}

export function readExpenseAccountingConfig(): ExpenseAccountingConfig {
  if (process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED !== "true") {
    return { enabled: false, provider: "disabled" };
  }
  if (process.env.EXPENSE_ACCOUNTING_PROVIDER !== "dry-run") {
    throw new Error("EXPENSE_ACCOUNTING_PROVIDER debe ser dry-run mientras no exista un conector aprobado.");
  }
  const maxRuntimeMs = boundedInteger("EXPENSE_ACCOUNTING_MAX_RUNTIME_MS", 45_000, 5_000, 50_000);
  const jobTimeoutMs = boundedInteger("EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS", 10_000, 1_000, 30_000);
  if (jobTimeoutMs + 1_000 > maxRuntimeMs) {
    throw new Error("EXPENSE_ACCOUNTING_JOB_TIMEOUT_MS debe dejar al menos 1 segundo para cerrar el lease.");
  }
  return {
    enabled: true,
    provider: "dry-run",
    batchSize: boundedInteger("EXPENSE_ACCOUNTING_BATCH_SIZE", 10, 1, 25),
    maxBatches: boundedInteger("EXPENSE_ACCOUNTING_MAX_BATCHES", 4, 1, 10),
    maxRuntimeMs,
    jobTimeoutMs,
    watchdogStaleSeconds: readExpenseAccountingWatchdogStaleSeconds(),
  };
}

export function readExpenseAccountingWatchdogStaleSeconds(): number {
  return boundedInteger(
    "EXPENSE_ACCOUNTING_WATCHDOG_STALE_SECONDS",
    93_600,
    3_600,
    604_800
  );
}

export function isExpenseAccountingExpectedActive(): boolean {
  return process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED === "true";
}
