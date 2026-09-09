import assert from "node:assert/strict";
import test from "node:test";
import { validateHostedPreflight } from "./preflight";

const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-09T15:00:00Z");

function valid(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const ids = {
    HOSTED_RRHH_ALLOWED_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000001",
    HOSTED_PRODUCTION_ALLOWED_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000002",
    HOSTED_INSTALLATION_ALLOWED_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000003",
    HOSTED_PRODUCTION_DENIED_AREA_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000004",
    HOSTED_INSTALLATION_DENIED_AREA_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000005",
    HOSTED_OTHER_COMPANY_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000006",
    HOSTED_OUTSIDE_ROSTER_EMPLOYEE_ID: "00000000-0000-4000-8000-000000000007",
  };
  return {
    HOSTED_EXECUTION_APPROVED: "staging-deployed",
    HOSTED_OPERATOR_AAL2_APPROVED: "personal-aal2",
    HOSTED_WINDOW_START_UTC: "2026-09-09T14:00:00Z",
    HOSTED_WINDOW_END_UTC: "2026-09-09T16:00:00Z",
    HOSTED_BASE_URL: "https://arcotex-workera-staging.vercel.app",
    HOSTED_CANDIDATE_SHA: sha,
    HOSTED_DEPLOYED_SHA: sha.toUpperCase(),
    HOSTED_AUTHORIZATION_DIGEST: digest,
    HOSTED_DEPLOYMENT_EVIDENCE_DIGEST: digest.toUpperCase(),
    HOSTED_RRHH_EMAIL: "rrhh@example.invalid",
    HOSTED_RRHH_PASSWORD: "synthetic",
    HOSTED_RRHH_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
    HOSTED_PRODUCTION_EMAIL: "production@example.invalid",
    HOSTED_PRODUCTION_PASSWORD: "synthetic",
    HOSTED_PRODUCTION_TOTP_SECRET: "JBSWY3DPEHPK3PXQ",
    HOSTED_INSTALLATION_EMAIL: "installation@example.invalid",
    HOSTED_INSTALLATION_PASSWORD: "synthetic",
    HOSTED_INSTALLATION_TOTP_SECRET: "JBSWY3DPEHPK3PXR",
    HOSTED_NO_ACCESS_EMAIL: "none@example.invalid",
    HOSTED_NO_ACCESS_PASSWORD: "synthetic",
    HOSTED_NO_ACCESS_TOTP_SECRET: "JBSWY3DPEHPK3PXS",
    ...ids,
    HOSTED_FORBIDDEN_CANARY_AREA: "CANARY-AREA",
    HOSTED_FORBIDDEN_CANARY_COMPANY: "CANARY-COMPANY",
    HOSTED_FORBIDDEN_CANARY_ROSTER: "CANARY-ROSTER",
    ...overrides,
  };
}

test("acepta sólo un origen HTTPS, SHA idénticos, AAL2 y una ventana vigente", () => {
  assert.deepEqual(validateHostedPreflight(valid(), now), {
    baseUrl: "https://arcotex-workera-staging.vercel.app",
    candidateSha: sha,
    deployedSha: sha,
    authorizationDigest: digest,
    deploymentEvidenceDigest: digest,
    windowStartUtc: "2026-09-09T14:00:00Z",
    windowEndUtc: "2026-09-09T16:00:00Z",
  });
});

test("falla cerrado sin aprobación exacta", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_EXECUTION_APPROVED: "blocked" }), now), /Ejecución bloqueada/);
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_OPERATOR_AAL2_APPROVED: "blocked" }), now), /Ejecución bloqueada/);
});

test("falla cerrado fuera de la ventana autorizada o ante un intervalo inválido", () => {
  assert.throws(() => validateHostedPreflight(valid(), new Date("2026-09-09T16:00:01Z")), /fuera de la ventana/);
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_WINDOW_END_UTC: "2026-09-09T13:00:00Z" }), now),
    /intervalo válido/,
  );
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_WINDOW_START_UTC: "09-09-2026 14:00" }), now),
    /formato/,
  );
});

test("falla cerrado ante SHA abreviado o despliegue distinto", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_CANDIDATE_SHA: "0123456" }), now), /SHA Git completo/);
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_DEPLOYED_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), now),
    /no coincide/,
  );
});

test("exige huellas SHA-256 de autorización y evidencia independiente", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_AUTHORIZATION_DIGEST: "ticket-123" }), now), /SHA-256/);
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_DEPLOYMENT_EVIDENCE_DIGEST: "" }), now), /EVIDENCE_DIGEST/);
});

test("rechaza URL con secretos, rutas o parámetros", () => {
  for (const url of [
    "http://staging.example.test",
    "https://user:secret@staging.example.test",
    "https://staging.example.test/login",
    "https://staging.example.test/?token=secret",
  ]) {
    assert.throws(() => validateHostedPreflight(valid({ HOSTED_BASE_URL: url }), now), /origen HTTPS/);
  }
});

test("falla antes del navegador si faltan cuentas, fixtures o canarios únicos", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_RRHH_EMAIL: "" }), now), /HOSTED_RRHH_EMAIL/);
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_RRHH_TOTP_SECRET: "invalid!" }), now), /Base32/);
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_OTHER_COMPANY_EMPLOYEE_ID: "no-uuid" }), now), /debe ser UUID/);
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_FORBIDDEN_CANARY_ROSTER: "CANARY-AREA" }), now),
    /deben ser únicos/,
  );
});
