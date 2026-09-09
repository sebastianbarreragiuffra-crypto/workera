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

test("el padrón ARCOTEX se resuelve antes de contar y excluye marcaciones externas sin borrar fuentes", () => {
  const rosterResolution = source.indexOf("resolveArcotexAuthorizedEmployeeIds()");
  const firstMetric = source.indexOf("const activeEmployees");
  const missingPunchQuery = source.indexOf('client.from("attendance_missing_punch_flags")');

  assert.ok(rosterResolution >= 0 && rosterResolution < firstMetric);
  assert.ok(firstMetric < missingPunchQuery);
  assert.ok(
    (source.match(/\.in\("employee_id", authorizedEmployeeIds\)/g) ?? []).length >= 12,
    "cada métrica por persona debe quedar limitada al padrón autorizado",
  );

  const missingPunchScope = source.slice(missingPunchQuery, source.indexOf("const reviewQueue", missingPunchQuery));
  assert.match(missingPunchScope, /\.in\("employee_id", authorizedEmployeeIds\)/);
  assert.doesNotMatch(missingPunchScope, /\.(?:insert|update|upsert|delete)\(/);
});

test("la cola del preflight conserva exactamente sus nueve conteos tenant-aware en el orden esperado", () => {
  const queueStart = source.indexOf("const [\n      lateTotal");
  const queueEnd = source.indexOf("const reviewQueue", queueStart);
  const queueQueries = source.slice(queueStart, queueEnd);

  assert.ok(queueStart >= 0 && queueEnd > queueStart);
  assert.equal((queueQueries.match(/requireCount\(/g) ?? []).length, 9);
  assert.equal((queueQueries.match(/employees!inner\(company_id\)/g) ?? []).length, 9);
  assert.equal((queueQueries.match(/\.eq\("employees\.company_id", companyId\)/g) ?? []).length, 9);
  assert.equal((queueQueries.match(/\.from\("late_arrival_records"\)/g) ?? []).length, 2);
  assert.equal((queueQueries.match(/\.from\("early_departure_records"\)/g) ?? []).length, 2);
  assert.equal((queueQueries.match(/\.from\("overtime_records"\)/g) ?? []).length, 2);
  assert.equal((queueQueries.match(/\.from\("absence_records"\)/g) ?? []).length, 2);
  assert.equal((queueQueries.match(/\.from\("attendance_missing_punch_flags"\)/g) ?? []).length, 1);
});
