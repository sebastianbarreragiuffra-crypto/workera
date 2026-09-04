import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(
  process.cwd(), "src", "app", "(expenses)", "empresas", "[companySlug]",
  "rendiciones", "asistente", "actions.ts"
), "utf8");

test("la acción resuelve sesión, empresa y permisos antes de ejecutar el asistente", () => {
  const contextIndex = source.lastIndexOf("getExpenseCompanyContextFromClient(");
  const runIndex = source.lastIndexOf("runExpenseAssistantQuery(");
  assert.ok(contextIndex >= 0);
  assert.ok(runIndex > contextIndex);
});

test("la acción nunca acepta actor, companyId, prompt ni respuesta desde FormData", () => {
  assert.doesNotMatch(source, /formData\.get\(["'](?:actor|actorId|userId|companyId|prompt|response|result)["']\)/);
});

test("los errores internos se reducen a códigos UI allowlisted", () => {
  assert.match(source, /\?error=\$\{code\}/);
  assert.doesNotMatch(source, /error\.message|String\(error\)/);
});

test("el resultado solo redirige a la ruta derivada del contexto autorizado", () => {
  assert.match(source, /pagePath\(context\.slug\)/);
  assert.doesNotMatch(source, /redirect\([^\n]*formData\.get/);
});
