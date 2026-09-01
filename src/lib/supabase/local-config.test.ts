import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const config = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");

function section(name: string): string {
  const escapedName = name.replaceAll(".", "\\.");
  const match = config.match(new RegExp(`^\\[${escapedName}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|\\Z)`, "m"));
  assert.ok(match, `Missing [${name}] in supabase/config.toml`);
  return match[1];
}

test("local Supabase uses the shared Workera port range", () => {
  assert.match(section("api"), /^port = 54421$/m);
  assert.match(section("db"), /^port = 54422$/m);
  assert.match(section("db"), /^shadow_port = 54420$/m);
  assert.match(section("studio"), /^port = 54423$/m);
  assert.match(section("local_smtp"), /^port = 54424$/m);
  assert.match(section("analytics"), /^port = 54427$/m);
  assert.match(section("edge_runtime"), /^inspector_port = 8093$/m);
});

test("local OAuth accepts both valid application callback origins", () => {
  const auth = section("auth");

  assert.match(auth, /^site_url = "http:\/\/127\.0\.0\.1:3000"$/m);
  assert.match(auth, /"http:\/\/127\.0\.0\.1:3000\/\*\*"/);
  assert.match(auth, /"http:\/\/localhost:3000\/\*\*"/);
  assert.doesNotMatch(auth, /https:\/\/(?:127\.0\.0\.1|localhost):3000/);
});

test("Google OAuth credentials remain environment-backed", () => {
  const google = section("auth.external.google");

  assert.match(google, /^enabled = true$/m);
  assert.match(
    google,
    /^client_id = "env\(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID\)"$/m,
  );
  assert.match(
    google,
    /^secret = "env\(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET\)"$/m,
  );
});
