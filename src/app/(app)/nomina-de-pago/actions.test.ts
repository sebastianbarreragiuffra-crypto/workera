import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Auditoría de arquitectura: `generatePayrollBatchAction` (facturas) era el
 * único importador Excel de este módulo sin tope de tamaño -- el maestro de
 * proveedores ya validaba con `validateFileMeta` (extensión + tamaño), pero
 * las facturas solo chequeaban "no vacío". Reutiliza la misma función, sin
 * duplicar la validación.
 *
 * Auditoría de Vercel readiness: `uploadSuppliersAction` (el importador
 * simple de proveedores, distinto del "maestro" con reemplazo seguro) seguía
 * siendo el único importador de este módulo sin ningún tope -- mismo criterio
 * de la nota anterior, misma función reutilizada.
 */
const ACTIONS_PATH = path.join(import.meta.dirname, "actions.ts");
const readSource = () => readFileSync(ACTIONS_PATH, "utf8");

test("generatePayrollBatchAction valida tamaño/extensión del Excel de facturas con validateFileMeta, igual que el maestro de proveedores", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function generatePayrollBatchAction");
  const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /validateFileMeta\(file\.name, file\.size\)/, "debe reusar validateFileMeta, no reimplementar el chequeo");
});

test("uploadSuppliersAction valida tamaño/extensión del Excel de proveedores con validateFileMeta, ANTES de parsear el archivo", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function uploadSuppliersAction");
  const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /validateFileMeta\(file\.name, file\.size\)/, "debe reusar validateFileMeta, no reimplementar el chequeo");

  const validateIdx = fnBody.indexOf("validateFileMeta(");
  const parseIdx = fnBody.indexOf("parseSuppliersExcel(");
  assert.ok(validateIdx >= 0 && parseIdx >= 0 && validateIdx < parseIdx, "debe validar ANTES de parsear el archivo");
});

test("generatePayrollBatchAction/importSuppliersAction/las acciones de maestro de proveedores usan isPrivilegedAdmin (helper compartido) para el gate de rol", () => {
  const content = readSource();
  assert.match(content, /isPrivilegedAdmin\(profile\.role\)/, "requirePayrollAccess debe usar el helper compartido, no una comparación inline de strings");
});
