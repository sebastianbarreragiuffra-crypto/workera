import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Fase 8D: "APP_ADMIN must be the ONLY role allowed to perform
 * application-administration capabilities... ADMIN_RRHH must not inherit
 * APP_ADMIN capabilities." `requireAppAdmin()`/`requireCurrentRole()` viven
 * en src/lib/supabase/authorize.ts y dependen de sesión real (cookies) --
 * no son unit-testeables sin mockear next/headers, y este repo no tiene ese
 * patrón establecido en ningún otro lado. La autorización REAL la sigue
 * decidiendo RLS (probado exhaustivamente vía pgTAP,
 * supabase/tests/028_phase8d_authorized_email_provisioning.sql y
 * supabase/tests/024_super_admin_and_access_model.sql) -- estos tests
 * confirman la INTENCIÓN del código de aplicación: que las funciones de
 * administración de usuarios llaman al gate de APP_ADMIN exclusivo y nunca
 * a uno que también deje pasar ADMIN_RRHH.
 */

const USER_MANAGEMENT_PATH = path.join(import.meta.dirname, "user-management.ts");
const USUARIOS_PAGE_PATH = path.resolve(import.meta.dirname, "..", "..", "app", "(app)", "usuarios", "page.tsx");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("la administración global exige OWNER + MFA sin depender de un rol Arcotex", () => {
  const content = readSource(USER_MANAGEMENT_PATH);
  assert.match(content, /async function requireGlobalIdentityOwner/);
  assert.doesNotMatch(content, /await requireAppAdmin\(\)/);
  assert.match(content, /platform\?\.role !== "OWNER" \|\| aal !== "aal2"/);
  for (const fnName of ["listAppUsers", "createAppUser", "assignRole", "setUserActive"]) {
    const fnStart = content.indexOf(`export async function ${fnName}`);
    assert.ok(fnStart >= 0, `${fnName} debe existir en user-management.ts`);
    assert.match(content.slice(fnStart, fnStart + 500), /requireGlobalIdentityOwner\(\)/);
  }
});

test("user-management.ts nunca gatea con un allowedRoles que incluya ADMIN_RRHH (Fase 8D restringió el gate previo)", () => {
  const content = readSource(USER_MANAGEMENT_PATH);
  assert.doesNotMatch(
    content,
    /requireCurrentRole\([^)]*ADMIN_RRHH/,
    "ninguna función de administración de usuarios debe permitir ADMIN_RRHH -- ver requireAppAdmin() en authorize.ts"
  );
});

test("requireAppAdmin() se define como exactamente requireCurrentRole('SUPER_ADMIN') -- APP_ADMIN mapea al rol técnico SUPER_ADMIN, sin rol nuevo", () => {
  const content = readSource(path.join(import.meta.dirname, "..", "supabase", "authorize.ts"));
  const fnStart = content.indexOf("export async function requireAppAdmin");
  assert.ok(fnStart >= 0, "requireAppAdmin debe existir en authorize.ts");
  const fnBody = content.slice(fnStart, fnStart + 200);
  assert.match(fnBody, /requireCurrentRole\("SUPER_ADMIN"\)/, "requireAppAdmin debe delegar exactamente en requireCurrentRole(\"SUPER_ADMIN\")");
});

test("/usuarios (administración de cuentas) exige SUPER_ADMIN exclusivamente, nunca ADMIN_RRHH", () => {
  const content = readSource(USUARIOS_PAGE_PATH);
  assert.match(content, /profile\.role !== "SUPER_ADMIN"/, "/usuarios debe redirigir a cualquiera que no sea SUPER_ADMIN");
  assert.doesNotMatch(
    content,
    /profile\.role\s*(!==|===)\s*"ADMIN_RRHH"|"SUPER_ADMIN"[^;]*&&[^;]*"ADMIN_RRHH"/,
    "/usuarios no debe tener ninguna condición que compare el rol contra ADMIN_RRHH (solo prosa explicativa está permitida)"
  );
});

test("ningún componente de src/app compara profile.email/user.email contra un literal de email aprobado (el email solo se usa en el límite de provisioning, nunca en runtime de la app)", () => {
  const APP_ROOT = path.resolve(import.meta.dirname, "..", "..", "app");
  const CORPORATE_EMAIL_LITERAL = /[a-z0-9._%+-]+@arcotex\.cl/gi;

  function listFilesRecursively(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) files.push(...listFilesRecursively(fullPath));
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) files.push(fullPath);
    }
    return files;
  }

  const offenders: string[] = [];
  for (const file of listFilesRecursively(APP_ROOT)) {
    const content = readFileSync(file, "utf8");
    if (CORPORATE_EMAIL_LITERAL.test(content)) offenders.push(file);
    CORPORATE_EMAIL_LITERAL.lastIndex = 0;
  }

  assert.deepEqual(offenders, [], `el mapeo email->rol debe vivir SOLO en la migración, nunca en src/app: ${offenders.join(", ")}`);
});
