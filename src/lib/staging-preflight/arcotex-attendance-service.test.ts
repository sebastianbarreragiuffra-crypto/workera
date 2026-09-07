import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "arcotex-attendance-service.ts"), "utf8");

test("el preflight ARCOTEX es server-only y usa una capacidad literal", () => {
  assert.match(source, /import "server-only"/);
  assert.match(source, /createAdminClient\("arcotex-attendance-preflight"\)/);
});

test("el preflight es estrictamente de solo lectura", () => {
  for (const mutation of ["insert", "update", "upsert", "delete", "rpc", "storage"]) {
    assert.doesNotMatch(source, new RegExp(`\\.${mutation}\\(`), `no debe invocar ${mutation}`);
  }
});

test("las consultas nunca solicitan atributos personales", () => {
  for (const forbidden of ["display_name", "first_name", "last_name", "rut", "email", "external_workera_id", "reason", "error_summary"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "i"));
  }
  assert.doesNotMatch(source, /select\("\*"/);
});

test("los errores del proveedor se reducen a un código seguro", () => {
  assert.doesNotMatch(source, /error\?*\.message|String\(error\)/);
  assert.match(source, /QUERY_FAILED/);
});
