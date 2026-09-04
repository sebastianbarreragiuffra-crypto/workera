import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, isAuthorizedExpenseAccountingCron } from "./route";

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
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, reason: "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true" });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED; else process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED = previousEnabled;
  }
});
