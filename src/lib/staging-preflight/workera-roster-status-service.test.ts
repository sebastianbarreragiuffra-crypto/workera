import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./workera-roster-status-service.ts", import.meta.url), "utf8");

test("auditor de roster: el acceso service_role vive en un límite server-only y capacidad literal", () => {
  assert.match(source, /import "server-only"/);
  assert.match(source, /createAdminClient\("workera-roster-status-audit"\)/);
});

test("auditor de roster: fija ARCOTEX en el servicio y sólo extrae identidad técnica/estado", () => {
  assert.match(source, /\.eq\("company_id", ARCOTEX_WORKFORCE_COMPANY_ID\)/);
  assert.match(source, /\.select\("id, external_workera_id, source, active"\)/);
});
