import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  expenseAccountingWatchdogHttpStatus,
  expenseAccountingPausedWatchdogHttpStatus,
  handleExpenseAccountingWatchdog,
  isAuthorizedExpenseAccountingWatchdog,
} from "./route";
import type { ExpenseAccountingHealthResult } from "@/lib/expense-accounting/service";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/expense-accounting-watchdog", {
    headers: header ? { authorization: header } : undefined,
  });
}

function pausedOperations(overrides: Partial<ExpenseAccountingHealthResult["health"]> = {}): ExpenseAccountingHealthResult {
  return {
    enabled: false,
    provider: "disabled",
    health: {
      queuedCount: 0,
      retryCount: 0,
      processingCount: 0,
      failedCount: 0,
      staleProcessingCount: 0,
      oldestReadyAt: null,
      lastRunStatus: "SUCCEEDED",
      lastRunStartedAt: "2026-09-04T10:00:00.000Z",
      lastRunCompletedAt: "2026-09-04T10:00:01.000Z",
      lastSuccessCompletedAt: "2026-09-04T10:00:01.000Z",
      schedulerStale: false,
      status: "HEALTHY",
      ...overrides,
    },
  };
}

test("watchdog contable falla cerrado sin CRON_SECRET", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedExpenseAccountingWatchdog(request("Bearer anything")), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("watchdog autorizado permanece inerte con export deshabilitado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
  const previousExpected = process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = "false";
  delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  try {
    const response = await handleExpenseAccountingWatchdog(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => pausedOperations({ queuedCount: 2, schedulerStale: true, status: "CRITICAL" })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.expectedActive, false);
    assert.equal(body.reason, "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true");
    assert.equal(body.health.queuedCount, 2);
    assert.equal(body.health.schedulerStale, true);
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
    else process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = previousEnabled;
    if (previousExpected === undefined) delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
    else process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = previousExpected;
  }
});

test("watchdog falla si el ambiente exige operación y el flag se perdió", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
  const previousExpected = process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = "false";
  process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = "true";
  try {
    const response = await handleExpenseAccountingWatchdog(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => pausedOperations()
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).expectedActive, true);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
    else process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = previousEnabled;
    if (previousExpected === undefined) delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
    else process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = previousExpected;
  }
});

test("watchdog convierte una condición crítica en HTTP 503", () => {
  assert.equal(expenseAccountingWatchdogHttpStatus("HEALTHY"), 200);
  assert.equal(expenseAccountingWatchdogHttpStatus("DEGRADED"), 200);
  assert.equal(expenseAccountingWatchdogHttpStatus("CRITICAL"), 503);
});

test("watchdog pausado conserva salud read-only y alerta fallos reales", () => {
  assert.equal(expenseAccountingPausedWatchdogHttpStatus(false, pausedOperations()), 200);
  assert.equal(
    expenseAccountingPausedWatchdogHttpStatus(false, pausedOperations({ failedCount: 1, status: "CRITICAL" })),
    503
  );
  assert.equal(
    expenseAccountingPausedWatchdogHttpStatus(false, pausedOperations({ staleProcessingCount: 1, status: "CRITICAL" })),
    503
  );
});
