import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeInternalDestination,
  PublicOriginConfigurationError,
  publicAppUrl,
  resolvePublicOrigin,
  safeInternalDestination,
  type PublicOriginEnvironment,
} from "./public-origin";

const noDeploymentEnvironment: PublicOriginEnvironment = {};

test("APP_PUBLIC_ORIGIN prevalece sobre el localhost interno de un reverse proxy", () => {
  const environment = { APP_PUBLIC_ORIGIN: "https://mobile-tunnel.example" };
  assert.equal(
    resolvePublicOrigin("https://localhost:3000", environment),
    "https://mobile-tunnel.example"
  );
  assert.equal(
    publicAppUrl("/login/mfa", "https://localhost:3000", environment).toString(),
    "https://mobile-tunnel.example/login/mfa"
  );
});

test("la variable anterior NEXT_PUBLIC_APP_URL sigue siendo compatible y Vercel es fallback confiable", () => {
  assert.equal(
    resolvePublicOrigin(null, { NEXT_PUBLIC_APP_URL: "https://app.example/" }),
    "https://app.example"
  );
  assert.equal(
    resolvePublicOrigin(null, { VERCEL_PROJECT_PRODUCTION_URL: "gestora.vercel.app" }),
    "https://gestora.vercel.app"
  );
  assert.equal(
    resolvePublicOrigin(null, { VERCEL_URL: "gestora-preview.vercel.app" }),
    "https://gestora-preview.vercel.app"
  );
});

test("sin configuración solo se admite desarrollo HTTP en loopback", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    assert.equal(resolvePublicOrigin(origin, noDeploymentEnvironment), origin);
  }

  for (const origin of [
    "https://localhost:3000",
    "https://public.example",
    "http://public.example",
  ]) {
    assert.throws(
      () => resolvePublicOrigin(origin, noDeploymentEnvironment),
      PublicOriginConfigurationError
    );
  }
});

test("la configuración rechaza HTTP externo, credenciales, rutas, query, fragmentos y wildcards", () => {
  for (const APP_PUBLIC_ORIGIN of [
    "http://public.example",
    "https://user:pass@public.example",
    "https://public.example/base",
    "https://public.example?tenant=one",
    "https://public.example#fragment",
    "https://*.trycloudflare.com",
    "file:///tmp/app",
    "not-a-url",
  ]) {
    assert.throws(
      () => resolvePublicOrigin(null, { APP_PUBLIC_ORIGIN }),
      PublicOriginConfigurationError,
      APP_PUBLIC_ORIGIN
    );
  }
});

test("una configuración primaria inválida falla cerrada y no cae a otro dominio", () => {
  assert.throws(
    () =>
      resolvePublicOrigin(null, {
        APP_PUBLIC_ORIGIN: "http://unsafe.example",
        NEXT_PUBLIC_APP_URL: "https://fallback.example",
      }),
    PublicOriginConfigurationError
  );
});

test("los destinos internos válidos conservan path y query", () => {
  const environment = { APP_PUBLIC_ORIGIN: "https://app.example" };
  assert.equal(
    publicAppUrl("/auth/confirm?next=%2F", null, environment).toString(),
    "https://app.example/auth/confirm?next=%2F"
  );
  assert.equal(isSafeInternalDestination("/empresas/acme?tab=roles"), true);
});

test("destinos absolutos, protocol-relative, backslashes y controles nunca salen de la app", () => {
  for (const destination of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%5C%5Cevil.example",
    "/%255C%255Cevil.example",
    "/%2F%2Fevil.example",
    "/safe%0d%0aLocation:%20https://evil.example",
    "login",
  ]) {
    assert.equal(isSafeInternalDestination(destination), false, destination);
    assert.throws(
      () => publicAppUrl(destination, null, { APP_PUBLIC_ORIGIN: "https://app.example" }),
      PublicOriginConfigurationError
    );
  }
});

test("safeInternalDestination evita loops hacia callbacks de autenticación", () => {
  const blocked = new Set(["/auth/callback", "/auth/confirm"]);
  assert.equal(safeInternalDestination("/auth/callback?code=fake", "/", blocked), "/");
  assert.equal(safeInternalDestination("/auth/confirm", "/", blocked), "/");
  assert.equal(safeInternalDestination("/plataforma", "/", blocked), "/plataforma");
});
