import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const MANAGEMENT_PAGE = path.join(import.meta.dirname, "..", "..", "app", "seguridad", "mfa", "page.tsx");
const CHALLENGE_PAGE = path.join(import.meta.dirname, "..", "..", "app", "login", "mfa", "page.tsx");
const MFA_ACCOUNT = path.join(import.meta.dirname, "mfa-account.ts");

function read(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("las pantallas MFA fallan cerradas si no pueden leer la cuenta", () => {
  for (const pagePath of [MANAGEMENT_PAGE, CHALLENGE_PAGE]) {
    const source = read(pagePath);
    const accountRead = source.indexOf("getMfaAccountState(supabase)");
    const catchBlock = source.indexOf("catch {", accountRead);
    const errorView = source.indexOf("<MfaLoadError", catchBlock);

    assert.ok(accountRead > 0 && catchBlock > accountRead && errorView > catchBlock);
  }
});

test("las pantallas MFA usan solo el estado verificado y fallan cerradas si falta", () => {
  const helper = read(MFA_ACCOUNT);
  assert.match(
    helper,
    /claimsResult\.error \|\| !claimsResult\.data \|\| factorsResult\.error \|\| !factorsResult\.data/,
  );

  for (const pagePath of [MANAGEMENT_PAGE, CHALLENGE_PAGE]) {
    const source = read(pagePath);
    const stateRead = source.indexOf("getVerifiedMfaSessionState(supabase)");
    const closedGuard = source.indexOf("if (!mfaSession)", stateRead);
    const firstUse = source.indexOf("mfaSession.", closedGuard);

    assert.ok(stateRead > 0 && closedGuard > stateRead && firstUse > closedGuard);
    assert.doesNotMatch(source, /getAuthenticatorAssuranceLevel/);
  }
});

test("el error visible permite reintentar o cerrar sesión sin filtrar el proveedor", () => {
  const componentPath = path.join(import.meta.dirname, "..", "..", "components", "auth", "MfaLoadError.tsx");
  const source = read(componentPath);

  assert.match(source, /Reintentar/);
  assert.match(source, /<MfaSignOut \/>/);
  assert.doesNotMatch(source, /error\.message|error\.stack|SUPABASE|token|claims/);
});
