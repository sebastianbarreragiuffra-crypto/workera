import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_CRON_PATHS,
  evaluateHostingRuntime,
  renderHostingRuntimeReport,
} from "./hosting-runtime-readiness";

const readyEnvironment = {
  APP_PUBLIC_ORIGIN: "https://workera.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  MFA_ENFORCEMENT_ENABLED: "true",
  CRON_SECRET: "a".repeat(48),
  WORKERA_SYNC_ENABLED: "false",
  EXPENSE_OCR_ENABLED: "false",
  EXPENSE_FILE_SCAN_ENABLED: "false",
  EXPENSE_ACCOUNTING_EXPORT_ENABLED: "false",
  SUPPORTING_DOCUMENT_CLEANUP_ENABLED: "false",
};

test("el hosting base puede estar listo manteniendo integraciones peligrosas apagadas", () => {
  const report = evaluateHostingRuntime(readyEnvironment, EXPECTED_CRON_PATHS);

  assert.equal(report.decision, "READY");
  assert.equal(report.checks.filter((item) => item.status === "SAFE_DISABLED").length, 5);
  assert.doesNotMatch(renderHostingRuntimeReport(report), /service-role-test-value/);
});

test("sin secreto de cron la automatización nunca se declara lista", () => {
  const report = evaluateHostingRuntime({ ...readyEnvironment, CRON_SECRET: undefined }, EXPECTED_CRON_PATHS);

  assert.equal(report.decision, "NOT_READY");
  assert.equal(report.checks.find((item) => item.id === "cron_secret")?.status, "FAIL");
});

test("un secreto de cron compuesto por espacios o con espacios exteriores se rechaza", () => {
  for (const CRON_SECRET of [" ".repeat(48), ` ${"a".repeat(48)}`]) {
    const report = evaluateHostingRuntime({ ...readyEnvironment, CRON_SECRET }, EXPECTED_CRON_PATHS);
    assert.equal(report.decision, "NOT_READY");
    assert.equal(report.checks.find((item) => item.id === "cron_secret")?.status, "FAIL");
  }
});

test("un manifiesto incompleto o duplicado no se acepta", () => {
  const incomplete = evaluateHostingRuntime(readyEnvironment, EXPECTED_CRON_PATHS.slice(1));
  const duplicate = evaluateHostingRuntime(
    readyEnvironment,
    [...EXPECTED_CRON_PATHS, EXPECTED_CRON_PATHS[0]],
  );

  assert.equal(incomplete.decision, "NOT_READY");
  assert.equal(duplicate.decision, "NOT_READY", "un duplicado puede provocar una segunda invocación");
});

test("habilitar Workera exige adaptador real, HTTPS y ambas credenciales", () => {
  const broken = evaluateHostingRuntime(
    { ...readyEnvironment, WORKERA_SYNC_ENABLED: "true", WORKERA_PROVIDER: "mock" },
    EXPECTED_CRON_PATHS,
  );
  assert.equal(broken.decision, "NOT_READY");

  const valid = evaluateHostingRuntime({
    ...readyEnvironment,
    WORKERA_SYNC_ENABLED: "true",
    WORKERA_PROVIDER: "http",
    WORKERA_BASE_URL: "https://workera.example.com/api",
    WORKERA_API_USER: "service@example.com",
    WORKERA_API_KEY: "key-value",
  }, EXPECTED_CRON_PATHS);
  assert.equal(valid.decision, "READY");
});

test("valores secretos redactados por una exportación no cuentan como evidencia", () => {
  const report = evaluateHostingRuntime({
    ...readyEnvironment,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "[SENSITIVE]",
    SUPABASE_SERVICE_ROLE_KEY: "[SENSITIVE]",
    CRON_SECRET: "[SENSITIVE]",
  }, EXPECTED_CRON_PATHS);

  assert.equal(report.decision, "NOT_READY");
  assert.equal(report.checks.find((item) => item.id === "supabase_public_client")?.status, "FAIL");
  assert.equal(report.checks.find((item) => item.id === "supabase_server_client")?.status, "FAIL");
});

test("un origen con ruta, credenciales o HTTP se rechaza", () => {
  for (const APP_PUBLIC_ORIGIN of [
    "http://workera.example.com",
    "https://workera.example.com/dashboard",
    "https://user:secret@workera.example.com",
  ]) {
    const report = evaluateHostingRuntime({ ...readyEnvironment, APP_PUBLIC_ORIGIN }, EXPECTED_CRON_PATHS);
    assert.equal(report.decision, "NOT_READY", APP_PUBLIC_ORIGIN);
  }
});
