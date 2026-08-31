import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const authorizeSource = readFileSync(fileURLToPath(new URL("./authorize.ts", import.meta.url)), "utf8");
const sessionSource = readFileSync(fileURLToPath(new URL("../auth/session.ts", import.meta.url)), "utf8");

test("los gates de rol y licencia consultan y exigen profiles.active", () => {
  assert.match(authorizeSource, /select\("role, active"\)/);
  assert.match(authorizeSource, /!profile\?\.active/);
  assert.match(authorizeSource, /select\("role, active, medical_license_approver"\)/);
});

test("getCurrentProfile solo devuelve perfiles activos para páginas, actions y route handlers", () => {
  assert.match(sessionSource, /\.eq\("active", true\)/);
  assert.match(sessionSource, /\.maybeSingle\(\)/);
});
