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

test('el módulo "use server" solo exporta funciones async en runtime', () => {
  const source = readSource();
  assert.match(source, /^"use server";/);
  assert.doesNotMatch(source, /^export\s+(?:const|let|var|class)\s/m);
});

test("ni el secreto TOTP ni el QR se escriben en el log", () => {
  const source = readSource();
  for (const match of source.matchAll(/console\.[a-z]+\([^)]*\)/g)) {
    assert.doesNotMatch(match[0], /secret|qr_code|qrCode/i, "un log no debe llevar el secreto ni el QR");
  }
});

test("usa directamente el data URI de supabase-js y nunca lo codifica por segunda vez", () => {
  const body = bodyOf(readSource(), "startMfaEnrollmentAction");
  assert.match(body, /qrCodeDataUri:\s*data\.totp\.qr_code/);
  assert.doesNotMatch(body, /encodeURIComponent\(data\.totp\.qr_code\)/);
  assert.doesNotMatch(body, /data:image\/svg\+xml[^`]*\$\{data\.totp\.qr_code\}/);
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

/**
 * Con un factor verificado ya inscrito, inscribir otro o dar de baja el actual
 * desde una sesión que solo presentó la contraseña es el bypass completo del
 * segundo factor. La pantalla ya no ofrece esos botones en aal1, pero una
 * Server Action es un endpoint y ocultar el botón no la protege.
 */
test("inscribir y dar de baja exigen el desafío ANTES de tocar Supabase Auth", () => {
  const source = readSource();

  for (const fnName of ["startMfaEnrollmentAction", "discardMfaFactorAction"]) {
    const body = bodyOf(source, fnName);
    const guardIdx = body.indexOf("mustChallengeBeforeChangingFactors(supabase)");
    const mutationIdx = body.search(/supabase\.auth\.mfa\.(enroll|unenroll)\(/);

    assert.ok(guardIdx > 0, `${fnName} debe exigir el desafío con un factor verificado presente`);
    assert.ok(mutationIdx > 0, `${fnName} debe modificar factores en Supabase Auth`);
    assert.ok(guardIdx < mutationIdx, `${fnName} debe exigirlo antes de modificar el factor`);
  }
});

test("la guarda de cambio de factores falla cerrada y solo cede ante aal2", () => {
  const source = readSource();
  const start = source.indexOf("async function mustChallengeBeforeChangingFactors");
  assert.ok(start > 0, "la guarda debe existir");
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.match(body, /if \(!aal \|\| !factors\) return true;/, "sin datos legibles debe bloquear");
  assert.match(body, /aal\.currentLevel === "aal2"/, "solo una sesión en aal2 queda liberada");
  assert.match(body, /factors\.totp \?\? \[\]\)\.length > 0/, "sin factor verificado no hay nada que exigir");
});
