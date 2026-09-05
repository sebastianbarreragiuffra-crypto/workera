import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  isValidCronSecret,
  worstHttpStatus,
  datesReadyForRuleEngine,
  MAX_MANUAL_RERUN_BODY_BYTES,
  readManualRerunBody,
} from "./route";

const LONG_CRON_SECRET = "test-secret-fake-000000000000000000000000";

function requestWithAuth(header?: string): NextRequest {
  const headers = new Headers();
  if (header !== undefined) headers.set("authorization", header);
  return new NextRequest("http://localhost/api/sync/workera", { headers });
}

test("isValidCronSecret: sin CRON_SECRET configurado en el servidor -> siempre false (fail-closed)", () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth("Bearer cualquier-cosa")), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: header ausente -> false", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = LONG_CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth(undefined)), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: header sin prefijo Bearer -> false", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = LONG_CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth(LONG_CRON_SECRET)), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: secreto incorrecto -> false", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = LONG_CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth("Bearer secreto-equivocado-00000")), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: secreto de longitud distinta -> false (nunca revienta timingSafeEqual)", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = LONG_CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth("Bearer corto")), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: secreto correcto -> true", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = LONG_CRON_SECRET;
  try {
    assert.equal(isValidCronSecret(requestWithAuth(`Bearer ${LONG_CRON_SECRET}`)), true);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("isValidCronSecret: secreto configurado menor a 32 bytes -> false", () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "demasiado-corto";
  try {
    assert.equal(isValidCronSecret(requestWithAuth("Bearer demasiado-corto")), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("worstHttpStatus: todos SUCCEEDED -> 200", () => {
  assert.equal(worstHttpStatus(["SUCCEEDED", "SUCCEEDED"]), 200);
});

test("worstHttpStatus: cualquier FAILED -> 500 (nunca 200 si el sync falló, PASO 30)", () => {
  assert.equal(worstHttpStatus(["SUCCEEDED", "FAILED"]), 500);
});

test("worstHttpStatus: ALREADY_RUNNING sin FAILED -> 409", () => {
  assert.equal(worstHttpStatus(["SUCCEEDED", "ALREADY_RUNNING"]), 409);
});

test("worstHttpStatus: BLOCKED_* sin FAILED/ALREADY_RUNNING -> 422", () => {
  assert.equal(worstHttpStatus(["BLOCKED_RANGE_TOO_LARGE"]), 422);
  assert.equal(worstHttpStatus(["BLOCKED_UNRESOLVED_EMPLOYEES"]), 422);
});

test("worstHttpStatus: FAILED tiene prioridad sobre ALREADY_RUNNING y BLOCKED_*", () => {
  assert.equal(worstHttpStatus(["BLOCKED_RANGE_TOO_LARGE", "ALREADY_RUNNING", "FAILED"]), 500);
});

test("datesReadyForRuleEngine: solo las fechas cuyo sync terminó SUCCEEDED", () => {
  assert.deepEqual(
    datesReadyForRuleEngine({
      "2026-08-29": { status: "SUCCEEDED" },
      "2026-08-30": { status: "FAILED" },
      "2026-08-31": { status: "SUCCEEDED" },
    }),
    ["2026-08-29", "2026-08-31"]
  );
});

test("datesReadyForRuleEngine: DRY_RUN no cuenta -- no escribió ningún evento sobre el que derivar", () => {
  assert.deepEqual(datesReadyForRuleEngine({ "2026-08-29": { status: "DRY_RUN" } }), []);
});

test("datesReadyForRuleEngine: ALREADY_RUNNING no cuenta -- otro proceso está a cargo de esa fecha", () => {
  assert.deepEqual(datesReadyForRuleEngine({ "2026-08-29": { status: "ALREADY_RUNNING" } }), []);
});

test("datesReadyForRuleEngine: un sync bloqueado nunca dispara el motor de reglas", () => {
  assert.deepEqual(
    datesReadyForRuleEngine({
      "2026-08-29": { status: "BLOCKED_UNRESOLVED_EMPLOYEES" },
      "2026-08-30": { status: "BLOCKED_RANGE_TOO_LARGE" },
    }),
    []
  );
});

test("el body del rerun manual acepta solo JSON pequeño", async () => {
  const request = new Request("https://gestora.example/api/sync/workera", {
    method: "POST",
    body: JSON.stringify({ startDate: "2026-09-01", endDate: "2026-09-02" }),
  });
  assert.deepEqual(await readManualRerunBody(request), {
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  });
  assert.equal(MAX_MANUAL_RERUN_BODY_BYTES, 1024);
});

test("el body chunked se corta al superar 1 KiB", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(700));
      controller.enqueue(new Uint8Array(700));
      controller.close();
    },
  });
  const request = new Request("https://gestora.example/api/sync/workera", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(readManualRerunBody(request), RangeError);
});
