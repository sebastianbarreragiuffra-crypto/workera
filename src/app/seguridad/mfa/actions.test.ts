import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática, mismo criterio que `licencias/roster-actions.test.ts`: las
 * Server Actions de esta pantalla no se pueden ejercitar sin una petición
 * real, así que lo que se fija acá son las propiedades que no deben perderse
 * en una edición futura.
 */
const ACTIONS_PATH = path.join(import.meta.dirname, "actions.ts");

function readSource(): string {
  return readFileSync(ACTIONS_PATH, "utf8");
}

function bodyOf(source: string, fnName: string): string {
  const start = source.indexOf(`export async function ${fnName}`);
  assert.ok(start >= 0, `${fnName} debe existir en actions.ts`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

const MFA_ACTIONS = [
  "startMfaEnrollmentAction",
  "confirmMfaEnrollmentAction",
  "discardMfaFactorAction",
];

test("cada acción comprueba la sesión antes de llamar a Supabase Auth", () => {
  const source = readSource();
  for (const fnName of MFA_ACTIONS) {
    const body = bodyOf(source, fnName);
    const guardIdx = body.indexOf("getMfaAccountState(supabase)");
    const mfaCallIdx = body.indexOf("supabase.auth.mfa.");
    assert.ok(guardIdx > 0, `${fnName} debe resolver el estado de la cuenta`);
    assert.ok(mfaCallIdx > 0, `${fnName} debe operar sobre supabase.auth.mfa`);
    assert.ok(guardIdx < mfaCallIdx, `${fnName} debe comprobar la sesión ANTES de tocar el factor`);
  }
});

test("la pantalla de inscripción nunca usa el cliente service_role", () => {
  const source = readSource();
  assert.doesNotMatch(source, /createAdminClient|SUPABASE_SERVICE_ROLE_KEY|admin-client/);
});

test("ni el secreto TOTP ni el QR se escriben en el log", () => {
  const source = readSource();
  for (const match of source.matchAll(/console\.[a-z]+\([^)]*\)/g)) {
    assert.doesNotMatch(match[0], /secret|qr_code|qrCode/i, "un log no debe llevar el secreto ni el QR");
  }
});

test("la confirmación encadena challenge y luego verify, y solo registra ENROLLED si verify no falló", () => {
  const body = bodyOf(readSource(), "confirmMfaEnrollmentAction");
  const challengeIdx = body.indexOf("supabase.auth.mfa.challenge(");
  const verifyIdx = body.indexOf("supabase.auth.mfa.verify(");
  const verifyErrorIdx = body.indexOf("if (verifyError)");
  const recordIdx = body.indexOf('eventType: "ENROLLED"');

  assert.ok(challengeIdx > 0 && verifyIdx > challengeIdx, "challenge debe preceder a verify");
  assert.ok(verifyErrorIdx > verifyIdx, "el error de verify debe evaluarse después de verify");
  assert.ok(recordIdx > verifyErrorIdx, "ENROLLED solo se registra tras descartar el error de verify");
});

test("un código equivocado conserva la inscripción en curso para no borrar el QR de la pantalla", () => {
  const body = bodyOf(readSource(), "confirmMfaEnrollmentAction");
  assert.match(body, /return error\(INVALID_CODE_MESSAGE, pending\)/);
});

test("el mensaje de código inválido menciona el reloj del teléfono", () => {
  const source = readSource();
  assert.match(source, /hora de tu teléfono esté en automático/);
});

test("dar de baja un factor deja el evento UNENROLLED en la bitácora", () => {
  const body = bodyOf(readSource(), "discardMfaFactorAction");
  const unenrollIdx = body.indexOf("supabase.auth.mfa.unenroll(");
  const recordIdx = body.indexOf('eventType: "UNENROLLED"');
  assert.ok(unenrollIdx > 0 && recordIdx > unenrollIdx);
});
