import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, isAuthorizedSupportingDocumentCleanupCron } from "./route";

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
