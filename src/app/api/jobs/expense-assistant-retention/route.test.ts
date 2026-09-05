import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  handleExpenseAssistantRetention,
  isAuthorizedExpenseAssistantRetentionCron,
} from "./route";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/expense-assistant-retention", {
    headers: header ? { authorization: header } : undefined,
  });
}

test("la purga del asistente falla cerrada sin un CRON_SECRET fuerte", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedExpenseAssistantRetentionCron(request("Bearer anything")), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("la ruta no invoca service_role antes de autorizar", async () => {
  let invoked = false;
  const response = await handleExpenseAssistantRetention(request(), async () => {
    invoked = true;
    return 0;
  });
  assert.equal(response.status, 401);
  assert.equal(invoked, false);
});

test("una purga autorizada devuelve solo conteo, retencion y correlacion", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  try {
    const response = await handleExpenseAssistantRetention(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => 3,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.deleted, 3);
    assert.equal(body.retentionDays, 90);
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(body).sort(), ["correlationId", "deleted", "retentionDays"]);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("un fallo interno expone codigo y correlacion, nunca el mensaje crudo", async () => {
  const previous = process.env.CRON_SECRET;
  const previousConsoleError = console.error;
  const logs: unknown[][] = [];
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await handleExpenseAssistantRetention(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => { throw new Error("consulta privada y token secreto"); },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.errorCode, "RETENTION_RUN_FAILED");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /consulta privada|token secreto/);
    assert.doesNotMatch(JSON.stringify(logs), /consulta privada|token secreto/);
  } finally {
    console.error = previousConsoleError;
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
