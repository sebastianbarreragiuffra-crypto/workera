import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./ReviewDetailPanel.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const ruleEngineService = readFileSync(
  new URL("../../../lib/rule-engine/service.ts", import.meta.url),
  "utf8",
);
const replacementMigration = readFileSync(
  new URL("../../../../supabase/migrations/20260906190000_rrhh_atomic_decision_replacement.sql", import.meta.url),
  "utf8",
);

test("solo ADMIN_RRHH recibe los controles de veredicto final", () => {
  assert.match(page, /resolvePayrollCompanyRole\([\s\S]*?\["ADMIN_RRHH", "SUPER_ADMIN", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"\]/);
  assert.match(page, /canOverrideDecisions=\{workforceRole === "ADMIN_RRHH"\}/);
  assert.match(panel, /canOverrideDecisions &&/);
  assert.match(panel, /Veredicto final de RR\. HH\./);
});

test("el reproceso manual conserva la identidad de quien corrigió", () => {
  assert.match(actions, /const profile = await requireActiveProfile\(\)[\s\S]*?reprocessEmployeeDay\([\s\S]*?profile\.id/);
  assert.match(ruleEngineService, /triggeredBy: "MANUAL",[\s\S]*?triggeredByProfile/);
});

test("RR. HH. puede reemplazar atraso, horas extra y salida sin borrar historial", () => {
  assert.match(panel, /action=\{decideLateArrivalAction\}[\s\S]*Motivo obligatorio del reemplazo/);
  assert.match(panel, /action=\{decideOvertimeAction\}[\s\S]*Invalidar horas/);
  assert.match(panel, /action=\{decideEarlyDepartureOtherAction\}[\s\S]*Reemplaza la decisión vigente sin borrar su historial/);
  assert.match(replacementMigration, /for update/);
  assert.match(replacementMigration, /has_company_app_role\(v_company_id, 'ADMIN_RRHH'\)/);
  assert.match(replacementMigration, /set is_current = false/g);
  assert.doesNotMatch(replacementMigration, /is_admin_rrhh\(\)|is_privileged_admin\(\)/);
});

test("CommentField conecta htmlFor/id con inputId y no usa id fija", () => {
  const commentFieldMatch = panel.match(
    /function CommentField\([\s\S]*?\)[\s\S]*?return \([\s\S]*?<div>[\s\S]*?<\/div>\n\s*\);\n\s*\}/,
  );
  assert.ok(commentFieldMatch);
  const commentFieldBlock = commentFieldMatch![0];

  assert.match(commentFieldBlock, /inputId,/);
  assert.match(commentFieldBlock, /label htmlFor={inputId}/);
  assert.match(commentFieldBlock, /<textarea[\s\S]*?id={inputId}/);
  assert.doesNotMatch(commentFieldBlock, /htmlFor="reason"/);
  assert.doesNotMatch(commentFieldBlock, /id="reason"/);
});
