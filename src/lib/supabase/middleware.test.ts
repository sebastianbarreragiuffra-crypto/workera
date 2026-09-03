import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { isApiPath, isPublicPath, updateSession } from "./middleware";

/**
 * Tests del guard de sesión de Gate B pre-UI. Cero llamadas reales a
 * Supabase: el cliente se reemplaza por una fábrica falsa inyectada en
 * updateSession(), controlando exactamente qué devuelve getClaims().
 */

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(pathname, "http://localhost:3000"));
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

test("solo el webhook exacto de Resend llega sin sesión para validar su firma", async () => {
  const calls = { count: 0 };
  const allowed = await updateSession(
    makeRequest("/api/webhooks/resend/expense-receipts"),
    unauthenticatedFactory(calls)
  );
  assert.equal(allowed.status, 200);

  const nearMatch = await updateSession(
    makeRequest("/api/webhooks/resend/expense-receipts/extra"),
    unauthenticatedFactory({ count: 0 })
  );
  assert.equal(nearMatch.status, 401);
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
test("isPublicPath: login, callback OAuth y el webhook exacto de Resend son públicos", () => {
  assert.equal(isPublicPath("/login"), true);
  assert.equal(isPublicPath("/auth/callback"), true);
  assert.equal(isPublicPath("/api/webhooks/resend/expense-receipts"), true);
  assert.equal(isPublicPath("/"), false);
  assert.equal(isPublicPath("/login/"), false);
  assert.equal(isPublicPath("/dashboard"), false);
  assert.equal(isPublicPath("/auth/callback/"), false);
  assert.equal(isPublicPath("/api/webhooks/resend/expense-receipts/extra"), false);
});

test("isApiPath: reconoce /api y cualquier subruta", () => {
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/api/example"), true);
  assert.equal(isApiPath("/api/workera/sync"), true);
  assert.equal(isApiPath("/apinotreal"), false);
  assert.equal(isApiPath("/"), false);
});
