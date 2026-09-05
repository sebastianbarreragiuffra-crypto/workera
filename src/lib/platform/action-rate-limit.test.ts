import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlatformActionLimit,
  consumePlatformActionRateLimit,
  PlatformActionLimitError,
} from "./action-rate-limit";

const COMPANY_ID = "77000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "77000000-0000-4000-8000-000000000002";

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

test("envia scope, empresa y recurso cerrados al RPC", async () => {
  const { client, calls } = mockClient({
    data: { allowed: true, request_limit: 30, remaining: 29, retry_after_seconds: 0 },
    error: null,
  });
  assert.deepEqual(await consumePlatformActionRateLimit(client, {
    scope: "platform.invitation.resend",
    companyId: COMPANY_ID,
    resourceId: RESOURCE_ID,
  }), { status: "ALLOWED", requestLimit: 30, remaining: 29 });
  assert.deepEqual(calls, [{
    name: "consume_platform_action_rate_limit",
    args: { p_scope: "platform.invitation.resend", p_company_id: COMPANY_ID, p_resource_id: RESOURCE_ID },
  }]);
});

test("scope global no inventa una empresa centinela", async () => {
  const { client, calls } = mockClient({
    data: { allowed: true, request_limit: 5, remaining: 4, retry_after_seconds: 0 },
    error: null,
  });
  await consumePlatformActionRateLimit(client, { scope: "platform.company.create" });
  assert.deepEqual(calls[0], {
    name: "consume_platform_action_rate_limit",
    args: { p_scope: "platform.company.create", p_company_id: null, p_resource_id: null },
  });
});

test("bloqueo no se confunde con una caída y acota Retry-After", async () => {
  const limited = mockClient({
    data: { allowed: false, request_limit: 10, remaining: 0, retry_after_seconds: 999_999 },
    error: null,
  }).client;
  assert.deepEqual(await consumePlatformActionRateLimit(limited, {
    scope: "platform.mfa.reset", resourceId: RESOURCE_ID,
  }), { status: "RATE_LIMITED", requestLimit: 10, retryAfterSeconds: 86_400 });

  const unavailable = mockClient({ data: null, error: { code: "08006" } }).client;
  assert.deepEqual(await consumePlatformActionRateLimit(unavailable, {
    scope: "platform.company.create",
  }), { status: "UNAVAILABLE" });
});

test("errores de autorización se reducen a DENIED", async () => {
  for (const code of ["42501", "22023", "P0002"]) {
    const client = mockClient({ data: null, error: { code } }).client;
    assert.deepEqual(await consumePlatformActionRateLimit(client, {
      scope: "platform.company.create",
    }), { status: "DENIED" });
  }
});

test("assert devuelve mensajes operables sin detalle de proveedor", () => {
  assert.doesNotThrow(() => assertPlatformActionLimit({
    status: "ALLOWED", requestLimit: 5, remaining: 4,
  }));
  assert.throws(
    () => assertPlatformActionLimit({ status: "RATE_LIMITED", requestLimit: 5, retryAfterSeconds: 42 }),
    (error) => error instanceof PlatformActionLimitError
      && error.reason === "RATE_LIMITED"
      && error.retryAfterSeconds === 42
      && error.message.includes("42 segundos"),
  );
  assert.throws(
    () => assertPlatformActionLimit({ status: "UNAVAILABLE" }),
    (error) => error instanceof PlatformActionLimitError
      && error.reason === "UNAVAILABLE"
      && !error.message.includes("08006"),
  );
});
