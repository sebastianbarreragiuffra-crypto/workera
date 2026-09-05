import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "service.ts"), "utf8");

test("el inventario privilegiado es server-only y usa una capacidad literal", () => {
  assert.match(source, /import "server-only"/);
  assert.match(source, /createAdminClient\("staging-data-inventory"\)/);
});

test("cada consulta es HEAD, solo cuenta id y nunca solicita filas", () => {
  assert.match(source, /select\("id", \{ count: "exact", head: true \}\)/);
  assert.doesNotMatch(source, /select\("\*"/);
  assert.doesNotMatch(source, /const\s+\{\s*data(?:\s*[,}])/);
});

test("los errores se reducen a código y nunca exponen mensajes del proveedor", () => {
  assert.doesNotMatch(source, /error\?*\.message|String\(error\)/);
  assert.match(source, /QUERY_FAILED/);
});
