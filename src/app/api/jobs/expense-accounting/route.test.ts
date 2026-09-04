import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { expenseAccountingCronHttpStatus, GET, isAuthorizedExpenseAccountingCron } from "./route";
import type { ExpenseAccountingCatchUpResult } from "@/lib/expense-accounting/orchestrator";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/expense-accounting", {
    headers: header ? { authorization: header } : undefined,
  });
}

test("cron contable falla cerrado sin un CRON_SECRET fuerte", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try { assert.equal(isAuthorizedExpenseAccountingCron(request("Bearer anything")), false); }
  finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("endpoint autorizado no reclama la cola mientras el export esté deshabilitado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
  const previousExpected = process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = "false";
  delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.expectedActive, false);
    assert.equal(body.reason, "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED; else process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = previousEnabled;
    if (previousExpected === undefined) delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED; else process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = previousExpected;
  }
});

test("cron alerta si la integración esperada para el ambiente quedó deshabilitada", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED;
  const previousExpected = process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = "false";
  process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = "true";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).expectedActive, true);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED; else process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = previousEnabled;
    if (previousExpected === undefined) delete process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED; else process.env.EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED = previousExpected;
  }
});

function result(status: "HEALTHY" | "DEGRADED" | "CRITICAL", skipped = false): ExpenseAccountingCatchUpResult {
  return {
    skipped,
    runId: skipped ? null : "40000000-0000-4000-8000-000000000001",
    batches: skipped ? 0 : 1,
    summary: { claimed: 0, succeeded: 0, retried: 0, failed: 0 },
    health: {
      status,
      queuedCount: 0,
      retryCount: 0,
      processingCount: 0,
      failedCount: status === "CRITICAL" ? 1 : 0,
      staleProcessingCount: 0,
      oldestReadyAt: null,
      lastRunStatus: "SUCCEEDED",
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastSuccessCompletedAt: null,
      schedulerStale: false,
    },
  };
}

test("cron devuelve 503 para que monitoreo detecte DLQ crítica incluso si la entrega se solapa", () => {
  assert.equal(expenseAccountingCronHttpStatus(result("HEALTHY")), 200);
  assert.equal(expenseAccountingCronHttpStatus(result("DEGRADED")), 200);
  assert.equal(expenseAccountingCronHttpStatus(result("DEGRADED", true)), 202);
  assert.equal(expenseAccountingCronHttpStatus(result("CRITICAL")), 503);
  assert.equal(expenseAccountingCronHttpStatus(result("CRITICAL", true)), 503);
});
