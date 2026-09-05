import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";

const ROUTE_PATH = path.join(import.meta.dirname, "route.ts");
const MIDDLEWARE_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "lib",
  "supabase",
  "middleware.ts"
);

function source(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("la confirmación de email es pública antes de crear la sesión", () => {
  const middleware = source(MIDDLEWARE_PATH);
  const publicPaths = middleware.slice(
    middleware.indexOf("const PUBLIC_PATHS"),
    middleware.indexOf("]);", middleware.indexOf("const PUBLIC_PATHS"))
  );
  assert.match(publicPaths, /"\/auth\/confirm"/);
});

test("la confirmación sanea next y vuelve a decidir MFA después de verificar el token", () => {
  const route = source(ROUTE_PATH);
  assert.match(route, /safeInternalDestination/);
  assert.match(route, /resolvePostLoginDestination\(supabase\)/);
  assert.match(route, /mfaDestination === "\/" \? next : mfaDestination/);
});

test("la confirmación usa el origen canónico y limpia una sesión parcial ante fallos", () => {
  const route = source(ROUTE_PATH);
  assert.match(route, /resolvePublicOrigin\(requestOrigin\)/);
  assert.match(route, /publicAppUrl\(destination, requestOrigin\)/);
  assert.match(route, /supabase\.auth\.signOut\(\)/);
  assert.doesNotMatch(route, /x-forwarded-host|`\$\{origin\}/i);
});

test("el handler real de confirmación tampoco puede devolver localhost detrás del proxy", async () => {
  const previous = process.env.APP_PUBLIC_ORIGIN;
  process.env.APP_PUBLIC_ORIGIN = "https://mobile-tunnel.example";
  try {
    const response = await GET(
      new NextRequest("https://localhost:3000/auth/confirm?next=%2Fplataforma")
    );
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://mobile-tunnel.example/login?error=invite"
    );
  } finally {
    if (previous === undefined) delete process.env.APP_PUBLIC_ORIGIN;
    else process.env.APP_PUBLIC_ORIGIN = previous;
  }
});
