import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  GET,
  handleSupportingDocumentCleanup,
  isAuthorizedSupportingDocumentCleanupCron,
  supportingDocumentCleanupHttpStatus,
} from "./route";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/supporting-document-cleanup", {
    headers: header ? { authorization: header } : undefined,
  });
}

test("el cron de limpieza falla cerrado sin CRON_SECRET", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedSupportingDocumentCleanupCron(request("Bearer any")), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("una invocacion autorizada permanece inerte con el barrido apagado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests-000000000000"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: false,
      reason: "SUPPORTING_DOCUMENT_CLEANUP_ENABLED is not true",
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
    else process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = previousEnabled;
  }
});

const baseResult = {
  summary: { reclaimed: 0, claimed: 0, cleaned: 0, failed: 0, retried: 0 },
  health: {
    pendingReadyCount: 0,
    lockedCount: 0,
    failedCount: 0,
    stalePendingCount: 0,
    oldestPendingExpiresAt: null,
    requiresAttention: false,
  },
};

test("el estado HTTP permite que monitoreo distinga salud de backlog", () => {
  assert.equal(supportingDocumentCleanupHttpStatus(baseResult), 200);
  assert.equal(supportingDocumentCleanupHttpStatus({
    ...baseResult,
    health: { ...baseResult.health, failedCount: 1, requiresAttention: true },
  }), 503);
});

test("el cron habilitado devuelve snapshot minimo y 503 ante deuda accionable", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = "true";
  const unhealthy = {
    ...baseResult,
    health: { ...baseResult.health, stalePendingCount: 1, requiresAttention: true },
  };
  try {
    const response = await handleSupportingDocumentCleanup(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => unhealthy,
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.enabled, true);
    assert.deepEqual(body.summary, unhealthy.summary);
    assert.deepEqual(body.health, unhealthy.health);
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
    else process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = previousEnabled;
  }
});

test("un fallo interno expone solo codigo y correlacion, nunca el mensaje crudo", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
  const previousConsoleError = console.error;
  const logs: unknown[][] = [];
  process.env.CRON_SECRET = "fake-cron-secret-for-tests-000000000000";
  process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = "true";
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await handleSupportingDocumentCleanup(
      request("Bearer fake-cron-secret-for-tests-000000000000"),
      async () => { throw new Error("ruta privada y token secreto"); },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.errorCode, "CLEANUP_RUN_FAILED");
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /ruta privada|token secreto/);
    assert.doesNotMatch(JSON.stringify(logs), /ruta privada|token secreto/);
  } finally {
    console.error = previousConsoleError;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED;
    else process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED = previousEnabled;
  }
});
