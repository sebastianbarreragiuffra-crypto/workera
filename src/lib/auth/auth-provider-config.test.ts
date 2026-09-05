import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(import.meta.dirname, "..", "..", "..", "supabase", "config.toml");
const config = readFileSync(CONFIG_PATH, "utf8");

function tomlSection(name: string): string {
  const start = config.indexOf(`[${name}]`);
  assert.ok(start >= 0, `debe existir [${name}]`);
  const end = config.indexOf("\n[", start + name.length + 2);
  return config.slice(start, end === -1 ? undefined : end);
}

test("Auth local es invitation-only: signup general y por email permanecen cerrados", () => {
  assert.match(tomlSection("auth"), /\benable_signup\s*=\s*false\b/);
  assert.match(tomlSection("auth.email"), /\benable_signup\s*=\s*false\b/);
  assert.match(tomlSection("auth"), /\benable_anonymous_sign_ins\s*=\s*false\b/);
});

test("MFA usa TOTP y nunca habilita el factor SMS", () => {
  const totp = tomlSection("auth.mfa.totp");
  const phone = tomlSection("auth.mfa.phone");
  assert.match(totp, /\benroll_enabled\s*=\s*true\b/);
  assert.match(totp, /\bverify_enabled\s*=\s*true\b/);
  assert.match(phone, /\benroll_enabled\s*=\s*false\b/);
  assert.match(phone, /\bverify_enabled\s*=\s*false\b/);
});
