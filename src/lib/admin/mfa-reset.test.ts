import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática. `resetUserMfa` combina cliente de sesión y cliente
 * `service_role`, y lo que no puede perderse en una edición futura es cuál
 * decide qué: la autorización la resuelve siempre la sesión real, y el
 * service_role solo hace la parte que una sesión normal no puede hacer.
 */
const RESET_PATH = path.join(import.meta.dirname, "mfa-reset.ts");
const ACTIONS_PATH = path.join(
  import.meta.dirname,
  "..", "..", "app", "(platform)", "plataforma", "actions.ts"
);

function read(file: string): string {
  return readFileSync(file, "utf8");
}

test("la autorización se decide antes de tocar el cliente admin", () => {
  const source = read(RESET_PATH);
  const sessionIdx = source.indexOf("getMfaAccountState(supabase)");
  const aalIdx = source.indexOf("getAuthenticatorAssuranceLevel()");
  const canResetIdx = source.indexOf('supabase.rpc("can_reset_mfa_for"');
  const adminIdx = source.indexOf('createAdminClient("mfa-factor-administration")');

  assert.ok(sessionIdx > 0 && aalIdx > sessionIdx, "primero la sesión, después su nivel");
  assert.ok(canResetIdx > aalIdx, "el permiso se consulta después de exigir aal2 al llamador");
  assert.ok(adminIdx > canResetIdx, "el cliente admin recién aparece cuando ya hubo autorización");
});

test("el permiso se consulta con el cliente de sesión, nunca con el admin", () => {
  const source = read(RESET_PATH);
  assert.match(source, /supabase\.rpc\("can_reset_mfa_for"/);
  assert.doesNotMatch(source, /admin\.rpc\(/);
});

test("la bitácora se abre antes de borrar el primer factor", () => {
  const source = read(RESET_PATH);
  const startedIdx = source.indexOf('eventType: "ADMIN_RESET_STARTED"');
  const deleteIdx = source.indexOf("admin.auth.admin.mfa.deleteFactor");
  assert.ok(startedIdx > 0 && deleteIdx > startedIdx);
  assert.match(source, /if \(!startedRecorded\)/);
});

test("un fallo intermedio registra si el reseteo fue parcial o total", () => {
  const source = read(RESET_PATH);
  assert.match(source, /removedFactors > 0 \? "ADMIN_RESET_PARTIAL" : "ADMIN_RESET_FAILED"/);
  assert.match(source, /eventType: "ADMIN_RESET"/);
  assert.match(source, /performedBy: account\.userId/);
});

test("el llamador tiene que estar en aal2 y ese requisito no depende del flag", () => {
  const source = read(RESET_PATH);
  assert.match(source, /currentLevel !== "aal2"/);
  assert.doesNotMatch(source, /isMfaEnforcementEnabled/);
});

test("el cliente admin solo se usa para la API de administración de Auth", () => {
  const source = read(RESET_PATH);
  for (const match of source.matchAll(/admin\.[A-Za-z.]+/g)) {
    assert.match(
      match[0],
      /^admin\.auth\.admin\.mfa\.(listFactors|deleteFactor)$/,
      `uso inesperado del cliente service_role: ${match[0]}`
    );
  }
});

test("la acción no afirma que se envió un correo que este proyecto no envía", () => {
  const source = read(ACTIONS_PATH);
  const start = source.indexOf("export async function resetMemberMfaAction");
  const body = source.slice(start);
  assert.ok(start > 0, "la acción debe existir");
  assert.match(body, /Avisa tú a la persona/, "el mensaje debe pedir el aviso manual");
  assert.doesNotMatch(body, /correo enviado|se envió un correo|te enviamos/i);
});

test("un reseteo que no quedó en la bitácora se reporta como advertencia, no como éxito", () => {
  const source = read(ACTIONS_PATH);
  const start = source.indexOf("export async function resetMemberMfaAction");
  const body = source.slice(start);
  const noRecordIdx = body.indexOf("!result.eventRecorded");
  assert.ok(noRecordIdx > 0);
  assert.match(body.slice(noRecordIdx, noRecordIdx + 260), /status: "warning"/);
});
