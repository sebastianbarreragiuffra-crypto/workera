import assert from "node:assert/strict";
import test from "node:test";
import { validateHostedPreflight } from "./preflight";

const sha = "0123456789abcdef0123456789abcdef01234567";

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
    HOSTED_BASE_URL: "https://arcotex-workera-staging.vercel.app",
    HOSTED_CANDIDATE_SHA: sha,
    HOSTED_DEPLOYED_SHA: sha.toUpperCase(),
    HOSTED_RRHH_EMAIL: "rrhh@example.invalid",
    HOSTED_RRHH_PASSWORD: "synthetic",
    HOSTED_PRODUCTION_EMAIL: "production@example.invalid",
    HOSTED_PRODUCTION_PASSWORD: "synthetic",
    HOSTED_INSTALLATION_EMAIL: "installation@example.invalid",
    HOSTED_INSTALLATION_PASSWORD: "synthetic",
    HOSTED_NO_ACCESS_EMAIL: "none@example.invalid",
    HOSTED_NO_ACCESS_PASSWORD: "synthetic",
    ...ids,
    HOSTED_FORBIDDEN_CANARY_AREA: "CANARY-AREA",
    HOSTED_FORBIDDEN_CANARY_COMPANY: "CANARY-COMPANY",
    HOSTED_FORBIDDEN_CANARY_ROSTER: "CANARY-ROSTER",
    ...overrides,
  };
}

test("acepta sólo un origen HTTPS y SHAs completos idénticos", () => {
  assert.deepEqual(validateHostedPreflight(valid()), {
    baseUrl: "https://arcotex-workera-staging.vercel.app",
    candidateSha: sha,
    deployedSha: sha,
  });
});

test("falla cerrado sin aprobación exacta", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_EXECUTION_APPROVED: "blocked" })), /Ejecución bloqueada/);
});

test("falla cerrado ante SHA abreviado o despliegue distinto", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_CANDIDATE_SHA: "0123456" })), /SHA Git completo/);
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_DEPLOYED_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    /no coincide/,
  );
});

test("rechaza URL con secretos, rutas o parámetros", () => {
  for (const url of [
    "http://staging.example.test",
    "https://user:secret@staging.example.test",
    "https://staging.example.test/login",
    "https://staging.example.test/?token=secret",
  ]) {
    assert.throws(() => validateHostedPreflight(valid({ HOSTED_BASE_URL: url })), /origen HTTPS/);
  }
});

test("falla antes del navegador si faltan cuentas, fixtures o canarios únicos", () => {
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_RRHH_EMAIL: "" })), /HOSTED_RRHH_EMAIL/);
  assert.throws(() => validateHostedPreflight(valid({ HOSTED_OTHER_COMPANY_EMPLOYEE_ID: "no-uuid" })), /debe ser UUID/);
  assert.throws(
    () => validateHostedPreflight(valid({ HOSTED_FORBIDDEN_CANARY_ROSTER: "CANARY-AREA" })),
    /deben ser únicos/,
  );
});
