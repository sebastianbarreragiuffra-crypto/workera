import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import {
  isApiPath,
  isAuthorizedExpenseAccountingCronRequest,
  isAuthorizedExpenseOcrCronRequest,
  isAuthorizedWorkeraCronRequest,
  isExternalWebhookRequest,
  isPublicPath,
  updateSession,
} from "./middleware";
import { isValidCronSecretHeader } from "../auth/cron-secret";

/**
 * Tests del guard de sesión de Gate B pre-UI. Cero llamadas reales a
 * Supabase: el cliente se reemplaza por una fábrica falsa inyectada en
 * updateSession(), controlando exactamente qué devuelve getClaims().
 */

function makeRequest(
  pathname: string,
  cookies: Record<string, string> = {},
  method = "GET"
): NextRequest {
  const request = new NextRequest(new URL(pathname, "http://localhost:3000"), { method });
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

function authenticatedFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: { claims: { sub: "user-1", role: "authenticated" } }, error: null };
        },
      },
    };
  };
}

function unauthenticatedFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: null, error: { message: "no session" } };
        },
      },
    };
  };
}

function invalidTokenFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: null, error: { message: "invalid JWT signature" } };
        },
      },
    };
  };
}

function throwingFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          throw new Error("JWKS endpoint unreachable");
        },
      },
    };
  };
}

/** Fábrica que además simula una renovación de cookies (patrón setAll real). */
function authenticatedWithRefreshedCookieFactory(callCount: { count: number }) {
  return (request: NextRequest, responseRef: { current: NextResponse }) => {
    callCount.count += 1;
    responseRef.current = NextResponse.next({ request });
    responseRef.current.cookies.set("sb-refreshed-token", "renewed-value");
    return {
      auth: {
        async getClaims() {
          return { data: { claims: { sub: "user-1" } }, error: null };
        },
      },
    };
  };
}

/** getClaims() sin error pero sin ningún claim (payload vacío). */
function noClaimsFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: { claims: {} }, error: null };
        },
      },
    };
  };
}

/** getClaims() con claims presentes pero sin la propiedad `sub`. */
function claimsWithoutSubFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: { claims: { role: "authenticated" } }, error: null };
        },
      },
    };
  };
}

/** getClaims() con `sub` presente pero vacío. */
function emptySubFactory(callCount: { count: number }) {
  return () => {
    callCount.count += 1;
    return {
      auth: {
        async getClaims() {
          return { data: { claims: { sub: "" } }, error: null };
        },
      },
    };
  };
}

/** Cookie con el conjunto completo de atributos que un cliente Supabase real fija. */
function authenticatedWithFullAttributeCookieFactory(callCount: { count: number }) {
  return (request: NextRequest, responseRef: { current: NextResponse }) => {
    callCount.count += 1;
    responseRef.current = NextResponse.next({ request });
    responseRef.current.cookies.set("sb-access-token", "full-attrs-value", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
    return {
      auth: {
        async getClaims() {
          return { data: { claims: { sub: "user-1" } }, error: null };
        },
      },
    };
  };
}

function unauthenticatedWithFullAttributeCookieFactory(callCount: { count: number }) {
  return (request: NextRequest, responseRef: { current: NextResponse }) => {
    callCount.count += 1;
    responseRef.current = NextResponse.next({ request });
    responseRef.current.cookies.set("sb-access-token", "full-attrs-value", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
    return {
      auth: {
        async getClaims() {
          return { data: null, error: { message: "no session" } };
        },
      },
    };
  };
}

function unauthenticatedWithRefreshedCookieFactory(callCount: { count: number }) {
  return (request: NextRequest, responseRef: { current: NextResponse }) => {
    callCount.count += 1;
    responseRef.current = NextResponse.next({ request });
    responseRef.current.cookies.set("sb-refreshed-token", "renewed-value");
    return {
      auth: {
        async getClaims() {
          return { data: null, error: { message: "no session" } };
        },
      },
    };
  };
}

// 1. /login sin sesión -> permitido
test("/login sin sesión es permitido (ruta pública)", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/login"), unauthenticatedFactory(calls));
  assert.equal(res.status, 200);
});

// 2. / sin sesión -> redirect /login
test("/ sin sesión redirige a /login", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), unauthenticatedFactory(calls));
  assert.equal(res.status, 307);
  const location = res.headers.get("location");
  assert.ok(location, "debe incluir header Location");
  assert.equal(new URL(location!).pathname, "/login");
});

// 3. ruta privada anidada sin sesión -> redirect /login
test("ruta privada anidada sin sesión redirige a /login", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/dashboard/settings"), unauthenticatedFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

// 4. / con claims válidos -> permitido
test("/ con claims válidos es permitido", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), authenticatedFactory(calls));
  assert.equal(res.status, 200);
});

// 5. ruta privada con claims válidos -> permitido
test("ruta privada anidada con claims válidos es permitida", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/dashboard/settings"), authenticatedFactory(calls));
  assert.equal(res.status, 200);
});

// 6. /api/example sin sesión -> 401 JSON
test("/api/example sin sesión responde 401 JSON genérico", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/api/example"), unauthenticatedFactory(calls));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("location"), null, "no debe redirigir");
  const body = await res.json();
  assert.deepEqual(body, { error: "unauthorized" });
});

test("solo POST al webhook exacto de Resend llega sin sesión para validar su firma", async () => {
  const calls = { count: 0 };
  const allowed = await updateSession(
    makeRequest("/api/webhooks/resend/expense-receipts", {}, "POST"),
    unauthenticatedFactory(calls)
  );
  assert.equal(allowed.status, 200);

  const wrongMethod = await updateSession(
    makeRequest("/api/webhooks/resend/expense-receipts"),
    unauthenticatedFactory({ count: 0 })
  );
  assert.equal(wrongMethod.status, 401);

  const nearMatch = await updateSession(
    makeRequest("/api/webhooks/resend/expense-receipts/extra", {}, "POST"),
    unauthenticatedFactory({ count: 0 })
  );
  assert.equal(nearMatch.status, 401);
});

test("Meta permite solo GET/POST en la ruta exacta y conserva la validación del handler", async () => {
  for (const method of ["GET", "POST"]) {
    const allowed = await updateSession(
      makeRequest("/api/webhooks/meta/expense-receipts", {}, method),
      unauthenticatedFactory({ count: 0 })
    );
    assert.equal(allowed.status, 200, `${method} debe llegar al handler`);
  }

  for (const request of [
    makeRequest("/api/webhooks/meta/expense-receipts", {}, "DELETE"),
    makeRequest("/api/webhooks/meta/expense-receipts/extra", {}, "POST"),
  ]) {
    const blocked = await updateSession(request, unauthenticatedFactory({ count: 0 }));
    assert.equal(blocked.status, 401);
  }
});

// 7. /api/example con claims válidos -> permitido
test("/api/example con claims válidos es permitido", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/api/example"), authenticatedFactory(calls));
  assert.equal(res.status, 200);
});

// 8. token inválido -> tratado como no autenticado
test("token inválido (error de getClaims) se trata como no autenticado", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), invalidTokenFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

// 9. error inesperado -> fail closed
test("error inesperado en getClaims falla cerrado (no concede acceso)", async () => {
  const calls = { count: 0 };
  const pageRes = await updateSession(makeRequest("/dashboard"), throwingFactory(calls));
  assert.equal(pageRes.status, 307);
  assert.equal(new URL(pageRes.headers.get("location")!).pathname, "/login");

  const apiRes = await updateSession(makeRequest("/api/example"), throwingFactory({ count: 0 }));
  assert.equal(apiRes.status, 401);
});

// 10. no redirect loop en /login
test("/login nunca produce un redirect (evita loop con el guard)", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/login"), unauthenticatedFactory(calls));
  assert.equal(res.headers.get("location"), null);
});

// 11. ninguna URL externa puede convertirse en destino
test("el destino del redirect es siempre interno, ignora cualquier query param", async () => {
  const calls = { count: 0 };
  const res = await updateSession(
    makeRequest("/?next=https://evil.example.com"),
    unauthenticatedFactory(calls)
  );
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, "http://localhost:3000");
  assert.equal(location.pathname, "/login");
});

// 12. cookies del response de Supabase se conservan en respuestas permitidas
test("cookies renovadas se conservan cuando el acceso es permitido", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), authenticatedWithRefreshedCookieFactory(calls));
  assert.equal(res.cookies.get("sb-refreshed-token")?.value, "renewed-value");
});

// 13. cookies renovadas se conservan en redirect
test("cookies renovadas se conservan en la respuesta de redirect", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), unauthenticatedWithRefreshedCookieFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(res.cookies.get("sb-refreshed-token")?.value, "renewed-value");
});

// 14. cookies renovadas se conservan en 401
test("cookies renovadas se conservan en la respuesta 401", async () => {
  const calls = { count: 0 };
  const res = await updateSession(
    makeRequest("/api/example"),
    unauthenticatedWithRefreshedCookieFactory(calls)
  );
  assert.equal(res.status, 401);
  assert.equal(res.cookies.get("sb-refreshed-token")?.value, "renewed-value");
});

// Identidad verificada: claims sin sub, sub vacío, sin claims -> fail closed.
test("claims válidas con sub no vacío es autenticado", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), authenticatedFactory(calls));
  assert.equal(res.status, 200);
});

test("getClaims() sin error pero sin ningún claim -> no autenticado", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), noClaimsFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

test("claims sin la propiedad sub -> no autenticado", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/dashboard"), claimsWithoutSubFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

test("sub vacío ('') -> no autenticado", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/dashboard"), emptySubFactory(calls));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

// Preservación completa de atributos de cookies (no solo nombre/valor).
test("redirect preserva httpOnly, secure, sameSite, path y maxAge de la cookie renovada", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), unauthenticatedWithFullAttributeCookieFactory(calls));
  assert.equal(res.status, 307);
  const setCookieHeader = res.headers.get("set-cookie");
  assert.ok(setCookieHeader, "debe incluir Set-Cookie");
  assert.match(setCookieHeader!, /HttpOnly/i);
  assert.match(setCookieHeader!, /Secure/i);
  assert.match(setCookieHeader!, /SameSite=Lax/i);
  assert.match(setCookieHeader!, /Path=\//i);
  assert.match(setCookieHeader!, /Max-Age=3600/i);
});

test("401 preserva httpOnly, secure, sameSite, path y maxAge de la cookie renovada", async () => {
  const calls = { count: 0 };
  const res = await updateSession(
    makeRequest("/api/example"),
    unauthenticatedWithFullAttributeCookieFactory(calls)
  );
  assert.equal(res.status, 401);
  const setCookieHeader = res.headers.get("set-cookie");
  assert.ok(setCookieHeader, "debe incluir Set-Cookie");
  assert.match(setCookieHeader!, /HttpOnly/i);
  assert.match(setCookieHeader!, /Secure/i);
  assert.match(setCookieHeader!, /SameSite=Lax/i);
  assert.match(setCookieHeader!, /Path=\//i);
  assert.match(setCookieHeader!, /Max-Age=3600/i);
});

test("respuesta permitida (200) también conserva todos los atributos de la cookie renovada", async () => {
  const calls = { count: 0 };
  const res = await updateSession(makeRequest("/"), authenticatedWithFullAttributeCookieFactory(calls));
  assert.equal(res.status, 200);
  const setCookieHeader = res.headers.get("set-cookie");
  assert.ok(setCookieHeader, "debe incluir Set-Cookie");
  assert.match(setCookieHeader!, /HttpOnly/i);
  assert.match(setCookieHeader!, /Secure/i);
  assert.match(setCookieHeader!, /SameSite=Lax/i);
  assert.match(setCookieHeader!, /Path=\//i);
  assert.match(setCookieHeader!, /Max-Age=3600/i);
});

// Logging sin PII: un pathname con UUID ficticio nunca debe aparecer en logs.
test("un fallo inesperado no registra el pathname (puede contener UUIDs/identificadores)", async () => {
  const fakeUuid = "3fbb6c1e-4c1a-4e2b-9a2d-9d4e5f6a7b8c";
  const capturedCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    capturedCalls.push(args);
  };

  try {
    const calls = { count: 0 };
    await updateSession(makeRequest(`/employees/${fakeUuid}`), throwingFactory(calls));
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(capturedCalls.length > 0, "el fallo inesperado debe registrar al menos un evento");
  const serialized = JSON.stringify(capturedCalls);
  assert.doesNotMatch(serialized, new RegExp(fakeUuid));
  assert.doesNotMatch(serialized, /\/employees\//);
});

// 15. getClaims() se llama exactamente una vez por request
test("getClaims() se llama exactamente una vez por request", async () => {
  const calls = { count: 0 };
  await updateSession(makeRequest("/"), authenticatedFactory(calls));
  assert.equal(calls.count, 1);
});

// 16. matcher excluye assets estáticos previstos
test("el matcher de proxy.ts excluye _next/static, _next/image, favicon y extensiones estáticas", async () => {
  const { config } = await import("../../proxy");
  assert.equal(config.matcher.length, 1);
  const pattern = config.matcher[0];
  assert.match(pattern, /_next\/static/);
  assert.match(pattern, /_next\/image/);
  assert.match(pattern, /favicon\.ico/);
  assert.match(pattern, /svg|png|jpg|jpeg|gif|webp/);
});

// Cobertura directa de los helpers de clasificación de rutas.
test("isPublicPath: solo login y callback OAuth son páginas públicas", () => {
  assert.equal(isPublicPath("/login"), true);
  assert.equal(isPublicPath("/auth/callback"), true);
  assert.equal(isPublicPath("/api/webhooks/resend/expense-receipts"), false);
  assert.equal(isPublicPath("/"), false);
  assert.equal(isPublicPath("/login/"), false);
  assert.equal(isPublicPath("/dashboard"), false);
  assert.equal(isPublicPath("/auth/callback/"), false);
  assert.equal(isPublicPath("/api/webhooks/resend/expense-receipts/extra"), false);
});

test("isExternalWebhookRequest limita proveedor, método y ruta exactos", () => {
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/resend/expense-receipts", {}, "POST")), true);
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/resend/expense-receipts")), false);
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/meta/expense-receipts")), true);
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/meta/expense-receipts", {}, "POST")), true);
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/meta/expense-receipts", {}, "PATCH")), false);
  assert.equal(isExternalWebhookRequest(makeRequest("/api/webhooks/meta/expense-receipts/extra", {}, "POST")), false);
});

test("isApiPath: reconoce /api y cualquier subruta", () => {
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/api/example"), true);
  assert.equal(isApiPath("/api/workera/sync"), true);
  assert.equal(isApiPath("/apinotreal"), false);
  assert.equal(isApiPath("/"), false);
});

// ---------------------------------------------------------------------------
// Bypass del cron de Workera
// ---------------------------------------------------------------------------

/**
 * Este camino deja pasar un request SIN sesión de usuario, así que su alcance
 * tiene que ser exactamente un método y una ruta. El route handler revalida el
 * secreto por su cuenta: esto solo evita el redirect al login.
 */
const CRON_SECRET_FAKE = "test-secret-fake-000000000000000000000000";

function cronRequest(
  options: { header?: string; method?: string; path?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (options.header !== undefined) headers.set("authorization", options.header);
  return new NextRequest(`http://localhost${options.path ?? "/api/sync/workera"}`, {
    headers,
    method: options.method ?? "GET",
  });
}

function withCronSecret(value: string | undefined, run: () => void): void {
  const original = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
}

test("cron: secreto correcto en GET /api/sync/workera -> autorizado", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: `Bearer ${CRON_SECRET_FAKE}` })), true);
  });
});

test("cron: sin CRON_SECRET configurado -> nunca autoriza (fail-closed)", () => {
  withCronSecret(undefined, () => {
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: `Bearer ${CRON_SECRET_FAKE}` })), false);
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: "Bearer " })), false);
  });
});

test("cron: un secreto configurado con menos de 32 bytes falla cerrado", () => {
  withCronSecret("demasiado-corto", () => {
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: "Bearer demasiado-corto" })), false);
    assert.equal(isAuthorizedExpenseOcrCronRequest(cronRequest({
      header: "Bearer demasiado-corto",
      path: "/api/jobs/expense-ocr",
    })), false);
  });
});

test("cron: secreto incorrecto, ausente o sin prefijo Bearer -> no autoriza", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: "Bearer secreto-equivocado-00000" })), false);
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: CRON_SECRET_FAKE })), false, "sin prefijo Bearer");
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({})), false, "sin header");
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header: "Bearer corto" })), false, "longitud distinta no revienta");
  });
});

test("cron: el bypass NO se extiende a otra ruta ni a otro método", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    const header = `Bearer ${CRON_SECRET_FAKE}`;
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header, path: "/dashboard" })), false);
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header, path: "/api/sync/workera/otra" })), false);
    assert.equal(isAuthorizedWorkeraCronRequest(cronRequest({ header, method: "POST" })), false, "el rerun administrativo exige sesión, no el secreto de cron");
  });
});

test("cron: middleware y route handler comparten la MISMA decisión", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    for (const header of [`Bearer ${CRON_SECRET_FAKE}`, "Bearer equivocado", "sin-bearer", ""]) {
      assert.equal(
        isAuthorizedWorkeraCronRequest(cronRequest({ header })),
        isValidCronSecretHeader(header),
        `deben coincidir para ${JSON.stringify(header)}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Gate de MFA (etapa E de docs/MFA_DESIGN.md).

interface MfaFactoryOptions {
  aal?: string;
  requiresMfa?: boolean | null;
  rpcError?: { message: string } | null;
  /** Simula un cliente que no sabe responder la consulta del gate. */
  withoutRpc?: boolean;
}

function mfaFactory(options: MfaFactoryOptions, rpcCalls: { count: number }) {
  const auth = {
    async getClaims() {
      return {
        data: { claims: { sub: "user-1", ...(options.aal ? { aal: options.aal } : {}) } },
        error: null,
      };
    },
  };
  const rpc = async () => {
    rpcCalls.count += 1;
    return { data: options.requiresMfa ?? null, error: options.rpcError ?? null };
  };
  return () => (options.withoutRpc ? { auth } : { auth, rpc });
}

/**
 * `await run()` y no `return run()`: el gate lee la variable en medio de una
 * cadena asíncrona, así que restaurarla al salir de una función síncrona la
 * dejaba en su valor original antes de que el middleware llegara a mirarla.
 */
async function withEnforcement<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MFA_ENFORCEMENT_ENABLED;
  if (value === undefined) delete process.env.MFA_ENFORCEMENT_ENABLED;
  else process.env.MFA_ENFORCEMENT_ENABLED = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MFA_ENFORCEMENT_ENABLED;
    else process.env.MFA_ENFORCEMENT_ENABLED = previous;
  }
}

test("el flag apagado deja todo exactamente como antes y ni siquiera consulta el gate", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("false", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal1", requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 200);
  assert.equal(rpcCalls.count, 0, "con el flag apagado no se consulta la base");
});

test("una variable ausente equivale a apagado: el bloqueo nunca se activa solo", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement(undefined, () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal1", requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 200);
  assert.equal(rpcCalls.count, 0);
});

test("con el flag activo, una cuenta privilegiada en aal1 rebota a /seguridad/mfa", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal1", requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/seguridad/mfa");
  assert.equal(rpcCalls.count, 1);
});

test("una cuenta que no exige MFA sigue navegando normalmente", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal1", requiresMfa: false }, rpcCalls))
  );
  assert.equal(response.status, 200);
});

test("una sesión ya en aal2 pasa sin consultar la base", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal2", requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 200);
  assert.equal(rpcCalls.count, 0, "tras el rollout la mayoría de los requests no debe pagar una consulta");
});

test("las rutas permitidas en aal1 son alcanzables y no gatillan la consulta", async () => {
  for (const path of ["/seguridad/mfa", "/login", "/login/mfa", "/auth/callback"]) {
    const rpcCalls = { count: 0 };
    const response = await withEnforcement("true", () =>
      updateSession(makeRequest(path), mfaFactory({ aal: "aal1", requiresMfa: true }, rpcCalls))
    );
    assert.equal(response.status, 200, `${path} debe ser alcanzable en aal1`);
    assert.equal(rpcCalls.count, 0, `${path} no debe consultar el gate`);
  }
});

test("una llamada de API recibe 403 mfa_required, no un redirect HTML", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/api/algo"), mfaFactory({ aal: "aal1", requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "mfa_required" });
});

test("si la consulta del gate falla, se cierra: no se deja pasar por las dudas", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(
      makeRequest("/dashboard"),
      mfaFactory({ aal: "aal1", rpcError: { message: "connection refused" } }, rpcCalls)
    )
  );
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/seguridad/mfa");
});

test("un cliente que no sabe responder el gate también cierra", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ aal: "aal1", withoutRpc: true }, rpcCalls))
  );
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/seguridad/mfa");
});

test("una sesión sin claim de nivel se trata como aal1", async () => {
  const rpcCalls = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), mfaFactory({ requiresMfa: true }, rpcCalls))
  );
  assert.equal(response.status, 307);
  assert.equal(rpcCalls.count, 1);
});

test("el gate no cambia el destino de quien no tiene sesión: sigue yendo al login", async () => {
  const callCount = { count: 0 };
  const response = await withEnforcement("true", () =>
    updateSession(makeRequest("/dashboard"), unauthenticatedFactory(callCount))
  );
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
});

test("cron OCR: solo GET exacto con Bearer correcto evita el guard de sesión", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    const header = `Bearer ${CRON_SECRET_FAKE}`;
    assert.equal(isAuthorizedExpenseOcrCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-ocr",
    })), true);
    assert.equal(isAuthorizedExpenseOcrCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-ocr/extra",
    })), false);
    assert.equal(isAuthorizedExpenseOcrCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-ocr",
      method: "POST",
    })), false);
    assert.equal(isAuthorizedExpenseOcrCronRequest(cronRequest({
      header: "Bearer incorrecto",
      path: "/api/jobs/expense-ocr",
    })), false);
  });
});

test("cron contable: solo GET exacto con Bearer correcto evita el guard de sesión", () => {
  withCronSecret(CRON_SECRET_FAKE, () => {
    const header = `Bearer ${CRON_SECRET_FAKE}`;
    assert.equal(isAuthorizedExpenseAccountingCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-accounting",
    })), true);
    assert.equal(isAuthorizedExpenseAccountingCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-accounting/extra",
    })), false);
    assert.equal(isAuthorizedExpenseAccountingCronRequest(cronRequest({
      header,
      path: "/api/jobs/expense-accounting",
      method: "POST",
    })), false);
    assert.equal(isAuthorizedExpenseAccountingCronRequest(cronRequest({
      header: "Bearer incorrecto",
      path: "/api/jobs/expense-accounting",
    })), false);
  });
});

test("cron contable: el bypass llega al handler sin consultar una sesión humana", async () => {
  await new Promise<void>((resolve, reject) => {
    withCronSecret(CRON_SECRET_FAKE, () => {
      updateSession(
        cronRequest({
          header: `Bearer ${CRON_SECRET_FAKE}`,
          path: "/api/jobs/expense-accounting",
        }),
        () => ({
          auth: {
            async getClaims() {
              reject(new Error("el bypass no debe consultar getClaims"));
              return { data: null, error: { message: "unexpected" } };
            },
          },
        })
      ).then((response) => {
        assert.equal(response.status, 200);
        resolve();
      }, reject);
    });
  });
});
