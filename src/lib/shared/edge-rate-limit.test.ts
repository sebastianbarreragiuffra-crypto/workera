import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  EDGE_RATE_LIMIT_POLICIES,
  enforceEdgeRateLimit,
  findEdgeRateLimitPolicy,
  trustedVercelClientIp,
} from "./edge-rate-limit";

const hosted = {
  VERCEL: "1",
  NODE_ENV: "production",
  EDGE_RATE_LIMIT_ENABLED: "true",
  EDGE_RATE_LIMIT_EXPECT_ENABLED: "true",
};

function request(path: string, init: RequestInit = {}, ip = "203.0.113.10"): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("x-vercel-forwarded-for", ip);
  return new NextRequest(`https://gestora.example${path}`, { method: init.method, headers });
}

test("solo selecciona metodos y rutas sensibles exactos", () => {
  assert.equal(findEdgeRateLimitPolicy(request("/login", { method: "POST" }))?.id, "gestora-login");
  assert.equal(findEdgeRateLimitPolicy(request("/login/mfa", { method: "POST" }))?.id, "gestora-mfa-challenge");
  assert.equal(findEdgeRateLimitPolicy(request("/seguridad/mfa", { method: "POST" }))?.id, "gestora-mfa-management");
  assert.equal(findEdgeRateLimitPolicy(request("/login", { method: "GET" })), null);
  assert.equal(findEdgeRateLimitPolicy(request("/api/webhooks/meta/expense-receipts/extra", { method: "POST" })), null);
  assert.equal(findEdgeRateLimitPolicy(request("/_next/static/app.js")), null);
  assert.equal(findEdgeRateLimitPolicy(request("/logo.svg")), null);
});

test("solo confia en la identidad canonica de Vercel y rechaza cadenas ambiguas", () => {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.99",
    "x-real-ip": "198.51.100.98",
    "x-vercel-forwarded-for": "203.0.113.7",
  });
  assert.equal(trustedVercelClientIp(headers, hosted), "203.0.113.7");
  assert.equal(trustedVercelClientIp(headers, { VERCEL: "0" }), null);
  headers.set("x-vercel-forwarded-for", "203.0.113.7, 198.51.100.1");
  assert.equal(trustedVercelClientIp(headers, hosted), null);
  headers.set("x-vercel-forwarded-for", "not-an-ip");
  assert.equal(trustedVercelClientIp(headers, hosted), null);
});

test("pasa la identidad confiable como clave y entrega 429 uniforme", async () => {
  let observedKey = "";
  const response = await enforceEdgeRateLimit(
    request("/api/webhooks/resend/expense-receipts", { method: "POST" }),
    async (_id, options) => {
      observedKey = options.rateLimitKey;
      return { rateLimited: true };
    },
    hosted,
  );
  assert.equal(observedKey, "203.0.113.10");
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("retry-after"), "60");
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response?.json(), { error: "too_many_requests" });
});

test("falla cerrado si falta identidad, regla o disponibilidad y se recupera", async () => {
  const missingIdentity = request("/auth/confirm");
  missingIdentity.headers.delete("x-vercel-forwarded-for");
  assert.equal((await enforceEdgeRateLimit(missingIdentity, async () => ({ rateLimited: false }), hosted))?.status, 503);

  assert.equal((await enforceEdgeRateLimit(
    request("/auth/confirm"), async () => ({ rateLimited: false, error: "not-found" }), hosted,
  ))?.status, 503);
  assert.equal((await enforceEdgeRateLimit(
    request("/auth/confirm"), async () => ({ rateLimited: true, error: "blocked" }), hosted,
  ))?.status, 503);

  let available = false;
  const checker = async () => {
    if (!available) throw new TypeError("synthetic outage");
    return { rateLimited: false } as const;
  };
  assert.equal((await enforceEdgeRateLimit(request("/auth/confirm"), checker, hosted))?.status, 503);
  available = true;
  assert.equal(await enforceEdgeRateLimit(request("/auth/confirm"), checker, hosted), null);
});

test("el contador compartido simulado aisla IPs y conserva el limite bajo concurrencia", async () => {
  const counts = new Map<string, number>();
  const checker = async (_id: string, options: { rateLimitKey: string }) => {
    const next = (counts.get(options.rateLimitKey) ?? 0) + 1;
    counts.set(options.rateLimitKey, next);
    return { rateLimited: next > 3 };
  };
  const burst = await Promise.all(Array.from({ length: 8 }, () =>
    enforceEdgeRateLimit(request("/login", { method: "POST" }), checker, hosted)));
  assert.equal(burst.filter((response) => response === null).length, 3);
  assert.equal(burst.filter((response) => response?.status === 429).length, 5);
  assert.equal(await enforceEdgeRateLimit(
    request("/login", { method: "POST" }, "203.0.113.11"), checker, hosted,
  ), null);
});

test("desarrollo local no llama al WAF y cada politica tiene ID unico", async () => {
  let calls = 0;
  assert.equal(await enforceEdgeRateLimit(
    request("/login", { method: "POST" }),
    async () => { calls += 1; return { rateLimited: true }; },
    { VERCEL: "0", NODE_ENV: "test", EDGE_RATE_LIMIT_ENABLED: "false" },
  ), null);
  assert.equal(calls, 0);
  assert.equal(new Set(EDGE_RATE_LIMIT_POLICIES.map((policy) => policy.id)).size, EDGE_RATE_LIMIT_POLICIES.length);
});

test("el rollout parte inerte y detecta drift despues de exigirlo", async () => {
  let calls = 0;
  const checker = async () => { calls += 1; return { rateLimited: false }; };
  const sensitive = request("/login", { method: "POST" });

  assert.equal(await enforceEdgeRateLimit(sensitive, checker, {
    VERCEL: "1",
    EDGE_RATE_LIMIT_ENABLED: "false",
    EDGE_RATE_LIMIT_EXPECT_ENABLED: "false",
  }), null);
  assert.equal(calls, 0);

  const drift = await enforceEdgeRateLimit(sensitive, checker, {
    VERCEL: "1",
    EDGE_RATE_LIMIT_ENABLED: "false",
    EDGE_RATE_LIMIT_EXPECT_ENABLED: "true",
  });
  assert.equal(drift?.status, 503);
  assert.equal(calls, 0);
});
