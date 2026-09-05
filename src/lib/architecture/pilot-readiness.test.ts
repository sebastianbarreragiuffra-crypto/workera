import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKER_GATE_MAP,
  READINESS_GATES,
  READINESS_STAGES,
  buildReadinessReport,
  collectSurfaceBlockers,
  evaluateReadiness,
  renderReadinessReport,
  type ReadinessGateId,
} from "./pilot-readiness";

test("cada blocker inventariado resuelve a un gate declarado", () => {
  const gates = new Set<ReadinessGateId>(READINESS_GATES.map((gate) => gate.id));
  const occurrences = collectSurfaceBlockers();
  assert.ok(occurrences.length > 0);
  for (const occurrence of occurrences) {
    assert.equal(occurrence.gateId, BLOCKER_GATE_MAP[occurrence.blocker]);
    assert.ok(gates.has(occurrence.gateId), `${occurrence.surface}: ${occurrence.blocker}`);
  }
});

test("los IDs de gates y etapas son únicos", () => {
  assert.equal(new Set(READINESS_GATES.map((gate) => gate.id)).size, READINESS_GATES.length);
  assert.equal(new Set(READINESS_STAGES.map((stage) => stage.id)).size, READINESS_STAGES.length);
});

test("solo desarrollo local sintético está en GO hoy", () => {
  const report = buildReadinessReport();
  assert.equal(report.find((stage) => stage.id === "LOCAL_SYNTHETIC")?.decision, "GO");
  for (const stage of report.filter((item) => item.id !== "LOCAL_SYNTHETIC")) {
    assert.equal(stage.decision, "NO_GO", stage.id);
    assert.ok(stage.openGates.length > 0, stage.id);
  }
});

test("ningún alcance con datos reales omite MFA, backup, observabilidad o aceptación", () => {
  for (const stageId of ["ARCOTEX_LABOR_PILOT", "EXPENSES_PILOT", "MULTI_COMPANY_PRODUCTION"] as const) {
    const required = new Set(evaluateReadiness(stageId).requiredGates.map((gate) => gate.id));
    for (const gate of [
      "HOSTED_MFA_ROLLOUT",
      "BACKUP_RESTORE_DRILL",
      "HOSTED_OBSERVABILITY",
      "DAST_AND_PENTEST",
      "INCIDENT_RESPONSE",
      "PRIVACY_AND_LEGAL",
      "RESIDUAL_RISK_ACCEPTANCE",
    ] as const) {
      assert.ok(required.has(gate), `${stageId} omite ${gate}`);
    }
  }
});

test("la excepción ARCOTEX es de alcance y nunca habilita un segundo tenant laboral", () => {
  const arcotex = evaluateReadiness("ARCOTEX_LABOR_PILOT");
  assert.deepEqual(arcotex.excludedSurfaceBlockers, ["LABOR_MULTI_TENANCY"]);
  assert.ok(arcotex.hardConstraints.some((item) => item.includes("único workspace laboral")));
  assert.ok(arcotex.hardConstraints.some((item) => item.includes("No habilitar una segunda empresa")));

  const production = evaluateReadiness("MULTI_COMPANY_PRODUCTION");
  assert.deepEqual(production.excludedSurfaceBlockers, []);
  assert.ok(production.requiredGates.some((gate) => gate.id === "LABOR_MULTI_TENANCY"));
});

test("cada piloto incorpora automáticamente los blockers de sus dominios", () => {
  const occurrences = collectSurfaceBlockers();
  const expensesRequired = new Set(evaluateReadiness("EXPENSES_PILOT").requiredGates.map((gate) => gate.id));
  for (const occurrence of occurrences.filter((item) => ["identity", "expenses"].includes(item.domain))) {
    assert.ok(expensesRequired.has(occurrence.gateId), `${occurrence.surface}: ${occurrence.blocker}`);
  }

  const laborRequired = new Set(evaluateReadiness("ARCOTEX_LABOR_PILOT").requiredGates.map((gate) => gate.id));
  for (const occurrence of occurrences.filter((item) =>
    ["identity", "workforce"].includes(item.domain) && item.blocker !== "LABOR_MULTI_TENANCY"
  )) {
    assert.ok(laborRequired.has(occurrence.gateId), `${occurrence.surface}: ${occurrence.blocker}`);
  }
});

test("el reporte humano no disimula NO-GO ni confunde evidencia local con hosted", () => {
  const rendered = renderReadinessReport();
  assert.match(rendered, /LOCAL_SYNTHETIC: GO/);
  assert.match(rendered, /ARCOTEX_LABOR_PILOT: NO-GO/);
  assert.match(rendered, /EXPENSES_PILOT: NO-GO/);
  assert.match(rendered, /MULTI_COMPANY_PRODUCTION: NO-GO/);
  assert.match(rendered, /REQUIRES_HOSTED_EVIDENCE/);
  assert.doesNotMatch(rendered, /sb_secret|service_role|WORKERA_API_KEY/i);
});
