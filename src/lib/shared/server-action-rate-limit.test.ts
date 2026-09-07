import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSensitiveServerActionRateLimit,
  SENSITIVE_SERVER_ACTION_POLICIES,
} from "./server-action-rate-limit";
import { EDGE_RATE_LIMIT_POLICIES } from "./edge-rate-limit";

const hosted = {
  VERCEL: "1",
  EDGE_RATE_LIMIT_ENABLED: "true",
  EDGE_RATE_LIMIT_EXPECT_ENABLED: "true",
};

function requestHeaders(ip = "203.0.113.8"): Promise<Headers> {
  return Promise.resolve(new Headers({ "x-vercel-forwarded-for": ip }));
}

test("la identidad de la acción selecciona un bucket independiente del pathname", async () => {
  let observedId = "";
  let observedKey = "";
  const result = await checkSensitiveServerActionRateLimit(
    "gestora-login-action",
    async (id, options) => {
      observedId = id;
      observedKey = options?.rateLimitKey ?? "";
      return { rateLimited: false };
    },
    hosted,
    requestHeaders,
  );
  assert.equal(result, "allowed");
  assert.equal(observedId, "gestora-login-action");
  assert.equal(observedKey, "203.0.113.8");
});

test("limite, regla ausente, identidad y proveedor fallan cerrados", async () => {
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-mfa-challenge-action",
    async () => ({ rateLimited: true }),
    hosted,
    requestHeaders,
  ), "limited");
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-mfa-management-action",
    async () => ({ rateLimited: false, error: "not-found" }),
    hosted,
    requestHeaders,
  ), "unavailable");
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-login-action",
    async () => ({ rateLimited: false }),
    hosted,
    () => requestHeaders("invalid"),
  ), "unavailable");
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-login-action",
    async () => { throw new TypeError("synthetic"); },
    hosted,
    requestHeaders,
  ), "unavailable");
});

test("rollout inerte no llama al WAF y el estado esperado detecta drift", async () => {
  let calls = 0;
  const checker = async () => { calls += 1; return { rateLimited: false } as const; };
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-login-action",
    checker,
    { VERCEL: "1", EDGE_RATE_LIMIT_ENABLED: "false", EDGE_RATE_LIMIT_EXPECT_ENABLED: "false" },
    requestHeaders,
  ), "allowed");
  assert.equal(calls, 0);
  assert.equal(await checkSensitiveServerActionRateLimit(
    "gestora-login-action",
    checker,
    { VERCEL: "1", EDGE_RATE_LIMIT_ENABLED: "false", EDGE_RATE_LIMIT_EXPECT_ENABLED: "true" },
    requestHeaders,
  ), "unavailable");
  assert.equal(calls, 0);
  const allIds = [
    ...SENSITIVE_SERVER_ACTION_POLICIES,
    ...EDGE_RATE_LIMIT_POLICIES.map((policy) => policy.id),
  ];
  assert.equal(new Set(allIds).size, allIds.length);
});
