import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { isAuthorizedExpenseAssistantRetentionCron } from "./route";

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

test("la ruta autoriza antes de invocar el límite service_role", () => {
  const source = readFileSync(path.join(
    process.cwd(), "src", "app", "api", "jobs", "expense-assistant-retention", "route.ts"
  ), "utf8");
  const authCall = source.lastIndexOf("isAuthorizedExpenseAssistantRetentionCron(request)");
  const purgeCall = source.lastIndexOf("purgeExpiredExpenseAssistantQueriesWithServiceRole()");
  assert.ok(authCall >= 0);
  assert.ok(purgeCall > authCall);
  assert.doesNotMatch(source, /error\.message|String\(error\)/);
});
