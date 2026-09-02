import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, isAuthorizedExpenseOcrCron } from "./route";

function request(header?: string): NextRequest {
  return new NextRequest("http://localhost/api/jobs/expense-ocr", { headers: header ? { authorization: header } : undefined });
}

test("cron OCR falla cerrado sin CRON_SECRET y exige Bearer exacto", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try { assert.equal(isAuthorizedExpenseOcrCron(request("Bearer anything")), false); }
  finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("cron OCR compara el secreto correctamente incluso con longitudes distintas", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests";
  try {
    assert.equal(isAuthorizedExpenseOcrCron(request("Bearer short")), false);
    assert.equal(isAuthorizedExpenseOcrCron(request("Bearer fake-cron-secret-for-tests")), true);
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("endpoint autorizado no procesa nada mientras OCR no esté exactamente habilitado", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnabled = process.env.EXPENSE_OCR_ENABLED;
  process.env.CRON_SECRET = "fake-cron-secret-for-tests";
  process.env.EXPENSE_OCR_ENABLED = "false";
  try {
    const response = await GET(request("Bearer fake-cron-secret-for-tests"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, reason: "EXPENSE_OCR_ENABLED is not true" });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.EXPENSE_OCR_ENABLED; else process.env.EXPENSE_OCR_ENABLED = previousEnabled;
  }
});
