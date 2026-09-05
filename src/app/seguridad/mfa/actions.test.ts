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
const COMPONENT_PATH = path.join(import.meta.dirname, "MfaEnrollment.tsx");

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

test("usa directamente el data URI validado por el normalizador", () => {
  const body = bodyOf(readSource(), "startMfaEnrollmentAction");

  assert.match(body, /normalizeMfaQrCodeDataUri\(data\.totp\.qr_code\)/);
  assert.doesNotMatch(body, /encodeURIComponent\(data\.totp\.qr_code\)/);
  assert.doesNotMatch(body, /`data:image\/svg\+xml/);
});

test("si el proveedor devuelve un QR inválido, elimina el factor recién creado", () => {
  const body = bodyOf(readSource(), "startMfaEnrollmentAction");
  const normalizeIdx = body.indexOf("normalizeMfaQrCodeDataUri(data.totp.qr_code)");
  const cleanupIdx = body.indexOf("supabase.auth.mfa.unenroll({ factorId: data.id })");

  assert.ok(normalizeIdx > 0 && cleanupIdx > normalizeIdx);
});

test("el identificador del factor que llega desde el navegador debe ser UUID", () => {
  assert.match(readSource(), /factorId:\s*z\.string\(\)\.uuid\(\)/);
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

test("el secreto TOTP nunca vuelve al servidor como estado previo de otra acción", () => {
  const actions = readSource();
  const component = readFileSync(COMPONENT_PATH, "utf8");

  for (const fnName of MFA_ACTIONS) {
    const body = bodyOf(actions, fnName);
    assert.doesNotMatch(body, /prevState/, `${fnName} no debe recibir estado serializado del navegador`);
  }
  assert.doesNotMatch(actions, /mfaEnrollmentAction/);
  assert.doesNotMatch(component, /useActionState/);
  assert.match(component, /name="factorId" value=\{enrollment\.factorId\}/);
  assert.match(component, /if \(result\.status === "done"\) setEnrollment\(null\)/);
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
test("inscribir, confirmar y dar de baja exigen el desafío ANTES de tocar Supabase Auth", () => {
  const source = readSource();

  for (const [fnName, mutation] of [
    ["startMfaEnrollmentAction", /supabase\.auth\.mfa\.enroll\(/],
    ["confirmMfaEnrollmentAction", /supabase\.auth\.mfa\.challenge\(/],
    ["discardMfaFactorAction", /supabase\.auth\.mfa\.unenroll\(/],
  ] as const) {
    const body = bodyOf(source, fnName);
    const guardIdx = body.indexOf("mustChallengeBeforeChangingFactors(supabase)");
    const mutationIdx = body.search(mutation);

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

  assert.match(body, /if \(!mfaSession\) return true;/, "sin datos verificados debe bloquear");
  assert.match(body, /mfaSession\.currentLevel === "aal2"/, "solo una sesión en aal2 queda liberada");
  assert.match(
    body,
    /mfaSession\.factors\.totp \?\? \[\]\)\.length > 0/,
    "sin factor verificado no hay nada que exigir",
  );
});
