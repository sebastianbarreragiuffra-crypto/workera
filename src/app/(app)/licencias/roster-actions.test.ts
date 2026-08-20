import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que `licencias/actions.test.ts` y
 * `admin/app-admin-authorization.test.ts`): las tres Server Actions de
 * roster verifican `requireRosterAdmin()` (SUPER_ADMIN/ADMIN_RRHH,
 * respaldado por RLS `employees_write_admin` -- probado exhaustivamente en
 * `supabase/tests/031_employee_roster_bootstrap.sql`) ANTES de tocar la
 * base de datos, y nunca leen un campo forjable del cliente para decidir
 * autorización.
 */
const ROSTER_ACTIONS_PATH = path.join(import.meta.dirname, "roster-actions.ts");

function readSource(): string {
  return readFileSync(ROSTER_ACTIONS_PATH, "utf8");
}

test("previewPersonnelRosterAction/applyPersonnelRosterAction/runWorkeraRosterReconciliationAction llaman a requireRosterAdmin() antes de tocar la base de datos", () => {
  const content = readSource();
  for (const fnName of ["previewPersonnelRosterAction", "applyPersonnelRosterAction", "runWorkeraRosterReconciliationAction"]) {
    const fnStart = content.indexOf(`export async function ${fnName}`);
    assert.ok(fnStart >= 0, `${fnName} debe existir en roster-actions.ts`);
    const fnEnd = content.indexOf("\nexport ", fnStart + 1);
    const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    assert.match(fnBody, /requireRosterAdmin\(\)/, `${fnName} debe llamar a requireRosterAdmin()`);

    const requireIdx = fnBody.indexOf("requireRosterAdmin()");
    const firstWriteIdx = [
      fnBody.indexOf("computePersonnelRosterPreview("),
      fnBody.indexOf("applyPersonnelRosterImport("),
      fnBody.indexOf("bootstrapEmployeesFromRoster("),
    ]
      .filter((i) => i > 0)
      .sort((a, b) => a - b)[0];
    if (firstWriteIdx !== undefined) {
      assert.ok(requireIdx < firstWriteIdx, `${fnName} debe verificar autorización ANTES de leer/escribir el roster`);
    }
  }
});

test("requireRosterAdmin() exige exactamente SUPER_ADMIN o ADMIN_RRHH -- nunca un supervisor", () => {
  const content = readSource();
  const fnStart = content.indexOf("async function requireRosterAdmin");
  const fnBody = content.slice(fnStart, fnStart + 400);
  assert.match(fnBody, /role !== "SUPER_ADMIN" && profile\.role !== "ADMIN_RRHH"/);
  assert.doesNotMatch(fnBody, /SUPERVISOR/);
});

test("las Server Actions de roster nunca leen un campo del formData para decidir autorización (ni role, ni isAdmin)", () => {
  const content = readSource();
  assert.doesNotMatch(content, /formData\.get\(["']role["']\)/);
  assert.doesNotMatch(content, /formData\.get\(["']isAdmin["']\)/);
});
