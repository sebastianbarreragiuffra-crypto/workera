import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(
  process.cwd(), "src", "app", "(expenses)", "empresas", "[companySlug]",
  "rendiciones", "asistente", "page.tsx"
), "utf8");

test("la evidencia individual se enlaza solo cuando el rol puede leer la rendición", () => {
  assert.match(source, /const canOpenEvidence = canOpenExpenseAssistantEvidence\(context\)/);
  const evidenceLink = source.indexOf("/rendiciones/${citation.reportId}");
  assert.ok(evidenceLink >= 0);
  const conditional = source.lastIndexOf("canOpenEvidence ? (", evidenceLink);
  assert.ok(conditional >= 0 && conditional < evidenceLink);
});

test("un conciliador sin lectura recibe una explicación en vez de un enlace roto", () => {
  assert.match(source, /El detalle individual exige permiso de lectura de rendiciones\./);
  assert.match(source, /<span className="font-semibold text-slate-800">\{citation\.referenceNumber\}<\/span>/);
});
