import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que `actions.test.ts`/`roster-actions.test.ts`):
 * `updateDiscountWorkbookAction` verifica `isPrivilegedAdmin(profile.role)`
 * ANTES de tocar Storage/la base de datos, y nunca lee un campo forjable
 * del cliente para decidir autorización. La autorización REAL la vuelve a
 * exigir RLS (`is_privileged_admin()` en la tabla y en el bucket, ver
 * `032_colaciones_discount_workbook_storage.sql`) -- este test solo prueba
 * que la capa de aplicación no abre un atajo.
 */
const ACTIONS_PATH = path.join(import.meta.dirname, "discount-workbook-actions.ts");
const readSource = () => readFileSync(ACTIONS_PATH, "utf8");

test("updateDiscountWorkbookAction verifica isPrivilegedAdmin ANTES de leer/subir el archivo", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function updateDiscountWorkbookAction");
  assert.ok(fnStart >= 0, "updateDiscountWorkbookAction debe existir");
  const fnBody = content.slice(fnStart);
  assert.match(fnBody, /isPrivilegedAdmin\(profile\.role\)/, "debe usar el helper centralizado, no una comparación inline");

  const authIdx = fnBody.indexOf("isPrivilegedAdmin(profile.role)");
  const uploadIdx = fnBody.indexOf("updateActiveDiscountWorkbook(");
  assert.ok(authIdx >= 0 && uploadIdx >= 0);
  assert.ok(authIdx < uploadIdx, "la verificación de rol debe ocurrir ANTES de subir/activar el archivo");
});

test("updateDiscountWorkbookAction nunca lee un campo del formData para decidir autorización", () => {
  const content = readSource();
  assert.doesNotMatch(content, /formData\.get\(["']role["']\)/);
  assert.doesNotMatch(content, /formData\.get\(["']isAdmin["']\)/);
});

test("updateDiscountWorkbookAction valida extensión y tamaño máximo antes de procesar el archivo", () => {
  const content = readSource();
  assert.match(content, /\\\.\(xlsx\|xls\)\$/i, "debe validar la extensión");
  assert.match(content, /MAX_DISCOUNT_WORKBOOK_SIZE_BYTES/, "debe existir un límite explícito de tamaño");
});
