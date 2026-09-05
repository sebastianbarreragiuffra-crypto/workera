import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const COMPANY_PAGE = path.join(
  import.meta.dirname,
  "..",
  "..",
  "app",
  "(platform)",
  "plataforma",
  "empresas",
  "[companySlug]",
  "page.tsx",
);

test("el aviso de workspace bloqueado permite operar módulos multiempresa independientes", () => {
  const source = readFileSync(COMPANY_PAGE, "utf8");

  assert.match(source, /El workspace laboral está bloqueado\./);
  assert.match(source, /puede operar únicamente en los módulos multiempresa/);
  assert.match(source, /funciones laborales seguirán cerradas/);
  assert.doesNotMatch(source, /puede configurarse, pero no operar/);
});
