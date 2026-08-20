import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que
 * `src/lib/admin/app-admin-authorization.test.ts`) de que
 * approve/rejectMedicalLicenseAction determinan la identidad EXCLUSIVAMENTE
 * server-side (`requireMedicalLicenseApprover()`, que a su vez lee
 * `auth.getClaims()`/`profiles` -- nunca un campo del `formData` del
 * cliente). Una petición forjada (ej. agregar `approverId`/`isApprover` al
 * FormData) nunca puede cambiar quién puede aprobar/rechazar, porque la
 * acción ni siquiera lee un campo así. La autorización REAL además la
 * repite RLS + `approve_medical_license`/`reject_medical_license` en la
 * base de datos (ver supabase/tests/030_medical_license_approval.sql) --
 * este test solo confirma que la capa de aplicación no abre un atajo.
 */

const ACTIONS_PATH = path.join(import.meta.dirname, "actions.ts");

function readSource(): string {
  return readFileSync(ACTIONS_PATH, "utf8");
}

test("approveMedicalLicenseAction y rejectMedicalLicenseAction llaman a requireMedicalLicenseApprover() antes de tocar la base de datos", () => {
  const content = readSource();
  for (const fnName of ["approveMedicalLicenseAction", "rejectMedicalLicenseAction"]) {
    const fnStart = content.indexOf(`export async function ${fnName}`);
    assert.ok(fnStart >= 0, `${fnName} debe existir en actions.ts`);
    const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
    const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    assert.match(fnBody, /requireMedicalLicenseApprover\(\)/, `${fnName} debe llamar a requireMedicalLicenseApprover()`);

    const requireIdx = fnBody.indexOf("requireMedicalLicenseApprover()");
    const firstRpcIdx = [fnBody.indexOf("approveMedicalLicense("), fnBody.indexOf("rejectMedicalLicense(")].filter((i) => i > 0).sort((a, b) => a - b)[0];
    assert.ok(requireIdx < firstRpcIdx, `${fnName} debe verificar la autorización ANTES de llamar a la función de aprobar/rechazar`);
  }
});

test("approve/rejectMedicalLicenseAction nunca leen un campo del formData para decidir autorización (ni approverId, ni isApprover, ni email)", () => {
  const content = readSource();
  const forbiddenPatterns = [/formData\.get\(["']approverId["']\)/, /formData\.get\(["']isApprover["']\)/, /formData\.get\(["']email["']\)/, /formData\.get\(["']role["']\)/];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(content, pattern, `actions.ts no debe leer autorización desde un campo forjable del cliente (${pattern})`);
  }
});

test("ningún literal de email aparece en actions.ts -- la identidad del aprobador se resuelve por auth.uid(), nunca comparando un email en código de aplicación", () => {
  const content = readSource();
  assert.doesNotMatch(content, /@arcotex\.cl/, "el email del aprobador nunca debe compararse en código de aplicación (ver profiles.medical_license_approver)");
});

test("uploadMedicalLicenseAction valida acceso al empleado con assertEmployeeAccessAllowed antes de subir (nunca confía en que el cliente ya esté autorizado)", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function uploadMedicalLicenseAction");
  const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /assertEmployeeAccessAllowed\(/, "uploadMedicalLicenseAction debe validar el acceso al empleado server-side");
});
