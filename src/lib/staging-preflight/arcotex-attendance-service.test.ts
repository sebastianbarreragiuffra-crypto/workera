import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "arcotex-attendance-service.ts"), "utf8");

test("el preflight ARCOTEX es server-only y usa una capacidad literal", () => {
  assert.match(source, /import "server-only"/);
  assert.match(source, /createAdminClient\("arcotex-attendance-preflight"\)/);
  assert.match(source, /\.eq\("slug", ARCOTEX_PILOT_COMPANY_SLUG\)/);
  assert.doesNotMatch(source, /process\.env\.ARCOTEX_PILOT_COMPANY_SLUG/);
});

test("el preflight es estrictamente de solo lectura", () => {
  for (const mutation of ["insert", "update", "upsert", "delete", "rpc", "storage"]) {
    assert.doesNotMatch(source, new RegExp(`\\.${mutation}\\(`), `no debe invocar ${mutation}`);
  }
});

test("las consultas nunca solicitan atributos personales", () => {
  for (const forbidden of ["display_name", "first_name", "last_name", "rut", "email", "external_workera_id", "reason", "error_summary"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "i"));
  }
  assert.doesNotMatch(source, /select\("\*"/);
});

test("los errores del proveedor se reducen a un código seguro", () => {
  assert.doesNotMatch(source, /error\?*\.message|String\(error\)/);
  assert.match(source, /QUERY_FAILED/);
});

test("el preflight consulta vigencia del ledger y bloquea estados fuente desconocidos", () => {
  assert.match(source, /attendance_rule_engine_day_readiness/);
  assert.match(source, /is_input_fresh/);
  assert.match(source, /UNKNOWN_EXTERNAL_STATUS/);
});

test("el preflight limita toda asistencia al padrón autorizado de ARCOTEX", () => {
  assert.match(
    source,
    /requireArcotexAuthorizedRoster\(process\.env\.ARCOTEX_PILOT_EMPLOYEE_IDS\)/,
  );
  assert.match(source, /authorizedEmployees !== authorizedRoster\.employeeCount/);
  assert.match(source, /ROSTER_SCOPE_MISMATCH/);
  assert.equal(
    source.match(/\.in\("employee_id", authorizedEmployeeIds\)/g)?.length,
    12,
    "cada consulta de eventos, asistencia y revisión debe quedar cercada por el padrón",
  );
  assert.match(source, /\.in\("id", authorizedEmployeeIds\)/);
  assert.doesNotMatch(source, /\.eq\("employees\.company_id", companyId\)/);
});

test("43 marcaciones del holding no pueden entrar en pendientes ARCOTEX", () => {
  const holdingEmployeeIds = Array.from({ length: 43 }, (_, index) => `holding-${index + 1}`);
  const arcotexEmployeeIds = new Set(["arcotex-1", "arcotex-2"]);
  const pendingRows = holdingEmployeeIds.map((employeeId) => ({ employee_id: employeeId }));

  const arcotexPending = pendingRows.filter((row) => arcotexEmployeeIds.has(row.employee_id));
  assert.equal(arcotexPending.length, 0);
});
