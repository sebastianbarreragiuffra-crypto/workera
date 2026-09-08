import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(import.meta.dirname, "..", "shared", "arcotex-authorized-employee-scope.ts"),
  "utf8",
);

test("el alcance común ARCOTEX valida empresa, 45 IDs y huella antes de devolver fichas", () => {
  assert.match(source, /authorizedRosterForCompany\(normalizedCompanyId, process\.env\.ARCOTEX_PILOT_EMPLOYEE_IDS\)/);
  assert.match(source, /\.eq\("company_id", normalizedCompanyId\)/);
  assert.match(source, /\.in\("id", \[\.\.\.roster\.employeeIds\]\)/);
  assert.match(source, /employees\.length !== roster\.employeeCount/);
  assert.match(source, /canonicalRosterSha256\(externalWorkeraIds\) !== roster\.expectedEmployeeCodeSha256/);
});

test("el alcance común es server-only y nunca modifica ni elimina fichas o marcaciones", () => {
  assert.match(source, /import "server-only"/);
  for (const mutation of ["insert", "update", "upsert", "delete", "rpc", "storage"]) {
    assert.doesNotMatch(source, new RegExp(`\\.${mutation}\\(`), `no debe invocar ${mutation}`);
  }
});
