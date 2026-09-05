import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, isAuthorizedExpenseFileScanCron } from "./route";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/expense-file-scan", {
    headers: header ? { authorization: header } : undefined,
  });
}

test("cron de cuarentena falla cerrado sin CRON_SECRET", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedExpenseFileScanCron(request("Bearer anything")), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("una invocación autorizada permanece inerte con el scanner apagado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_FILE_SCAN_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_FILE_SCAN_ENABLED = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: false,
      reason: "EXPENSE_FILE_SCAN_ENABLED is not true",
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_FILE_SCAN_ENABLED;
    else process.env.EXPENSE_FILE_SCAN_ENABLED = previousEnabled;
  }
});

test("habilitar sin un proveedor permitido falla cerrado", async () => {
  const snapshot = {
    secret: process.env.CRON_SECRET,
    enabled: process.env.EXPENSE_FILE_SCAN_ENABLED,
    provider: process.env.EXPENSE_FILE_SCAN_PROVIDER,
    fixture: process.env.EXPENSE_FILE_SCAN_ALLOW_FIXTURE,
  };
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_FILE_SCAN_ENABLED = "true";
  process.env.EXPENSE_FILE_SCAN_PROVIDER = "disabled";
  process.env.EXPENSE_FILE_SCAN_ALLOW_FIXTURE = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Fallo interno procesando la cuarentena." });
  } finally {
    for (const [key, value] of Object.entries({
      CRON_SECRET: snapshot.secret,
      EXPENSE_FILE_SCAN_ENABLED: snapshot.enabled,
      EXPENSE_FILE_SCAN_PROVIDER: snapshot.provider,
      EXPENSE_FILE_SCAN_ALLOW_FIXTURE: snapshot.fixture,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
