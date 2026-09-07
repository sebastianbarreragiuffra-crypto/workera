import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { expenseFileScanCronHttpStatus, GET, isAuthorizedExpenseFileScanCron } from "./route";

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

test("el estado HTTP hace visible cualquier fallo sanitizado del worker", () => {
  const healthy = { reclaimed: 0, claimed: 1, clean: 1, rejected: 0, failed: 0, retried: 0 };
  assert.equal(expenseFileScanCronHttpStatus(healthy), 200);
  assert.equal(expenseFileScanCronHttpStatus({ ...healthy, clean: 0, failed: 1, retried: 1 }), 503);
});

test("una invocación autorizada permanece inerte con el scanner apagado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_FILE_SCAN_ENABLED;
  const previousExpected = process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_FILE_SCAN_ENABLED = "false";
  process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.reason, "EXPENSE_FILE_SCAN_ENABLED is not true");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_FILE_SCAN_ENABLED;
    else process.env.EXPENSE_FILE_SCAN_ENABLED = previousEnabled;
    if (previousExpected === undefined) delete process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED;
    else process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED = previousExpected;
  }
});

test("el monitor esperado convierte un scanner apagado por drift en 503", async () => {
  const snapshot = {
    secret: process.env.CRON_SECRET,
    enabled: process.env.EXPENSE_FILE_SCAN_ENABLED,
    expected: process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED,
  };
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.EXPENSE_FILE_SCAN_ENABLED = "false";
  process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED = "true";
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.error, "configuration_drift");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    console.error = originalError;
    for (const [key, value] of Object.entries({
      CRON_SECRET: snapshot.secret,
      EXPENSE_FILE_SCAN_ENABLED: snapshot.enabled,
      EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED: snapshot.expected,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "Fallo interno procesando la cuarentena.");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    console.error = originalError;
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
