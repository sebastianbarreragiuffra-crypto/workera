import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const ROOT = process.cwd();
const actions = readFileSync(join(ROOT, "src/app/(app)/periodos/actions.ts"), "utf8");
const page = readFileSync(join(ROOT, "src/app/(app)/periodos/page.tsx"), "utf8");
const client = readFileSync(join(ROOT, "src/app/(app)/periodos/PeriodsClient.tsx"), "utf8");

test("períodos: la aprobación final y reapertura son exclusivas de ADMIN_RRHH", () => {
  assert.match(actions, /resolvePayrollCompanyRole\([\s\S]*?\["ADMIN_RRHH"\]/);
  assert.match(actions, /payrollRole !== "ADMIN_RRHH"/);
  assert.doesNotMatch(actions, /profile\.role !== "ADMIN_RRHH"/);
  assert.match(page, /resolvePayrollCompanyRole\([\s\S]*?\["ADMIN_RRHH", "SUPER_ADMIN"\]/);
  assert.match(page, /canManage=\{payrollRole === "ADMIN_RRHH"\}/);
  assert.match(client, /Vista técnica de solo lectura/);
  assert.match(client, /\{canManage && ALLOWED_TRANSITIONS/);
});

test("períodos: READY_TO_CLOSE usa el gate conciliado y no la transición genérica", () => {
  assert.match(actions, /assertSecondFactorForPrivileged\(supabase\)/);
  assert.match(actions, /else if \(to === "READY_TO_CLOSE"\)/);
  assert.match(actions, /approvePayrollPeriodReady\(supabase/);
  const approvalBranch = actions.slice(
    actions.indexOf('else if (to === "READY_TO_CLOSE")'),
    actions.indexOf("} else {", actions.indexOf('else if (to === "READY_TO_CLOSE")')),
  );
  assert.doesNotMatch(approvalBranch, /transitionReportingPeriod/);
});
