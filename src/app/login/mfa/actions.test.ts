import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Prueba estática, mismo criterio que las demás Server Actions del repo. */
const CHALLENGE_ACTIONS_PATH = path.join(import.meta.dirname, "actions.ts");
const LOGIN_ACTIONS_PATH = path.join(import.meta.dirname, "..", "actions.ts");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

test("el desafío comprueba la sesión antes de verificar el código", () => {
  const source = read(CHALLENGE_ACTIONS_PATH);
  const guardIdx = source.indexOf("getMfaAccountState(supabase)");
  const verifyIdx = source.indexOf("supabase.auth.mfa.challengeAndVerify(");
  assert.ok(guardIdx > 0 && verifyIdx > guardIdx);
});

test("un intento fallido queda registrado: es la señal de fuerza bruta", () => {
  const source = read(CHALLENGE_ACTIONS_PATH);
  const verifyIdx = source.indexOf("supabase.auth.mfa.challengeAndVerify(");
  const failureIdx = source.indexOf('eventType: "VERIFY_FAILURE"');
  const successIdx = source.indexOf('eventType: "VERIFY_SUCCESS"');
  assert.ok(failureIdx > verifyIdx, "VERIFY_FAILURE se registra después de intentar verificar");
  assert.ok(successIdx > failureIdx, "el camino de éxito viene después del de error");
});

test("el desafío nunca usa el cliente service_role", () => {
  assert.doesNotMatch(read(CHALLENGE_ACTIONS_PATH), /createAdminClient|SUPABASE_SERVICE_ROLE_KEY|admin-client/);
});

test("el factorId recibido del navegador se valida como uuid", () => {
  assert.match(read(CHALLENGE_ACTIONS_PATH), /factorId:\s*z\.string\(\)\.uuid\(\)/);
});

test("ningún log del desafío lleva el código escrito por la persona", () => {
  const source = read(CHALLENGE_ACTIONS_PATH);
  for (const match of source.matchAll(/console\.[a-z]+\([^)]*\)/g)) {
    assert.doesNotMatch(match[0], /code/i);
  }
});

test("el login ya no entra directo: resuelve el destino según el estado de MFA", () => {
  const source = read(LOGIN_ACTIONS_PATH);
  const loginStart = source.indexOf("export async function login(");
  const loginEnd = source.indexOf("\nexport ", loginStart + 1);
  const body = source.slice(loginStart, loginEnd === -1 ? undefined : loginEnd);

  assert.match(body, /resolvePostLoginDestination\(supabase\)/);
  assert.match(body, /redirect\(destination\)/);
  assert.doesNotMatch(body, /redirect\("\/"\)/, "el login no debe volver a redirigir siempre a la raíz");
});

test("si no puede resolver el estado MFA, elimina la sesión parcial y muestra un error genérico", () => {
  const source = read(LOGIN_ACTIONS_PATH);
  const loginStart = source.indexOf("export async function login(");
  const loginEnd = source.indexOf("\nexport ", loginStart + 1);
  const body = source.slice(loginStart, loginEnd === -1 ? undefined : loginEnd);
  const catchStart = body.indexOf("catch {");
  const catchBody = body.slice(catchStart, body.indexOf("\n  }", catchStart));

  assert.match(catchBody, /supabase\.auth\.signOut\(\)/);
  assert.match(catchBody, /estado de seguridad de tu cuenta/);
  assert.doesNotMatch(catchBody, /error\.message|token|claims|email/);
});
