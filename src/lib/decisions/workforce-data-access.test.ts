import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeWorkforceDataAccess,
  workforceDataAccessFailureResponse,
  workforceRateLimitHeaders,
} from "./workforce-data-access";

const RESOURCE_ID = "76000000-0000-4000-8000-000000000201";

function mockClient(result: { data: unknown; error: { code?: string } | null }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { maybeSingle: () => Promise.resolve(result) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

test("asistencia envia al RPC solo el periodo ya resuelto por el dominio", async () => {
  const { client, calls } = mockClient({
    data: {
      allowed: true, request_limit: 20, remaining: 19, retry_after_seconds: 0,
      storage_path: null, original_filename: null,
    },
    error: null,
  });

  assert.deepEqual(await authorizeWorkforceDataAccess(client, {
    scope: "attendance.export",
    period: { type: "PAGO", startDate: "2026-08-16", endDate: "2026-09-15", label: "Pago" },
  }), {
    status: "ALLOWED", requestLimit: 20, remaining: 19,
    storagePath: null, originalFilename: null,
  });
  assert.deepEqual(calls, [{
    name: "authorize_workforce_data_access",
    args: {
      p_scope: "attendance.export", p_resource_id: null, p_period_type: "PAGO",
      p_period_start: "2026-08-16", p_period_end: "2026-09-15",
    },
  }]);
});

test("nomina envia el UUID y nunca inventa contexto de periodo", async () => {
  const { client, calls } = mockClient({
    data: {
      allowed: true, request_limit: 20, remaining: 18, retry_after_seconds: 0,
      storage_path: null, original_filename: null,
    },
    error: null,
  });
  await authorizeWorkforceDataAccess(client, { scope: "payroll_batch.export", resourceId: RESOURCE_ID });
  assert.deepEqual(calls[0], {
    name: "authorize_workforce_data_access",
    args: {
      p_scope: "payroll_batch.export", p_resource_id: RESOURCE_ID,
      p_period_type: null, p_period_start: null, p_period_end: null,
    },
  });
});

test("maestro exige que la fila permitida incluya ruta y filename", async () => {
  const allowed = mockClient({
    data: {
      allowed: true, request_limit: 10, remaining: 9, retry_after_seconds: 0,
      storage_path: "imports/master.xlsx", original_filename: "maestro.xlsx",
    },
    error: null,
  }).client;
  assert.deepEqual(await authorizeWorkforceDataAccess(allowed, { scope: "supplier_master.download" }), {
    status: "ALLOWED", requestLimit: 10, remaining: 9,
    storagePath: "imports/master.xlsx", originalFilename: "maestro.xlsx",
  });

  const malformed = mockClient({
    data: {
      allowed: true, request_limit: 10, remaining: 9, retry_after_seconds: 0,
      storage_path: null, original_filename: "maestro.xlsx",
    },
    error: null,
  }).client;
  assert.deepEqual(
    await authorizeWorkforceDataAccess(malformed, { scope: "supplier_master.download" }),
    { status: "UNAVAILABLE" },
  );
});

test("cuota bloqueada no propaga metadata y acota Retry-After", async () => {
  const client = mockClient({
    data: {
      allowed: false, request_limit: 10, remaining: 0, retry_after_seconds: 999_999,
      storage_path: "no-debe-salir", original_filename: "no-debe-salir",
    },
    error: null,
  }).client;
  assert.deepEqual(await authorizeWorkforceDataAccess(client, { scope: "supplier_master.download" }), {
    status: "RATE_LIMITED", retryAfterSeconds: 86_400, requestLimit: 10,
  });
});

test("distingue denegacion esperada de indisponibilidad", async () => {
  for (const code of ["42501", "22023", "P0002"]) {
    const client = mockClient({ data: null, error: { code } }).client;
    assert.deepEqual(
      await authorizeWorkforceDataAccess(client, { scope: "supplier_master.download" }),
      { status: "DENIED" },
    );
  }
  const unavailable = mockClient({ data: null, error: { code: "08006" } }).client;
  assert.deepEqual(
    await authorizeWorkforceDataAccess(unavailable, { scope: "supplier_master.download" }),
    { status: "UNAVAILABLE" },
  );
});

test("respuestas privadas entregan 429, 404 configurable y 503 sin cache", async () => {
  const limited = workforceDataAccessFailureResponse({
    status: "RATE_LIMITED", retryAfterSeconds: 42, requestLimit: 10,
  });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "42");
  assert.equal(limited?.headers.get("ratelimit-remaining"), "0");
  assert.equal(limited?.headers.get("cache-control"), "private, no-store, max-age=0");

  const denied = workforceDataAccessFailureResponse(
    { status: "DENIED" },
    { deniedStatus: 404, deniedMessage: "No encontrado." },
  );
  assert.equal(denied?.status, 404);
  assert.equal(await denied?.text(), "No encontrado.");
  assert.equal(workforceDataAccessFailureResponse({ status: "UNAVAILABLE" })?.status, 503);
});

test("cabeceras de cuota permitida nunca exponen identificadores", () => {
  assert.deepEqual(workforceRateLimitHeaders({
    status: "ALLOWED", requestLimit: 20, remaining: 17,
    storagePath: "sensible/path", originalFilename: "sensible.xlsx",
  }), {
    "RateLimit-Limit": "20",
    "RateLimit-Remaining": "17",
  });
});
