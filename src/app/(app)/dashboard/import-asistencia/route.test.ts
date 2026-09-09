import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePayrollMultipart, payrollWorkbookPreviewToken, requestWithLimitedBody, resolveSubmittedWorkbookPeriod } from "./route-utils";

const change = {
  sheet: "RESUMEN_NOMINA",
  cell: "R6",
  stableKey: "11111111-1111-4111-8111-111111111111|Ajuste HH50 (minutos)",
  previous: 0,
  next: 30,
  kind: "VALUE" as const,
  consequence: "AJUSTE_EMPRESARIAL" as const,
};

test("vista previa de pre-nómina: el token liga base, hash y conjunto completo de cambios", () => {
  const input = {
    baseVersionId: "11111111-1111-4111-8111-111111111111",
    sourceRevision: 17,
    uploadedSha256: "a".repeat(64),
    changes: [change],
  };
  const token = payrollWorkbookPreviewToken(input, "s".repeat(32), "actor-1", 1234);

  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(token, payrollWorkbookPreviewToken(input, "s".repeat(32), "actor-1", 1234), "la misma vista previa es determinista");
  assert.notEqual(token, payrollWorkbookPreviewToken({ ...input, uploadedSha256: "b".repeat(64) }, "s".repeat(32), "actor-1", 1234));
  assert.notEqual(token, payrollWorkbookPreviewToken({ ...input, baseVersionId: null }, "s".repeat(32), "actor-1", 1234));
  assert.notEqual(token, payrollWorkbookPreviewToken({ ...input, sourceRevision: 18 }, "s".repeat(32), "actor-1", 1234));
  assert.notEqual(token, payrollWorkbookPreviewToken({ ...input, changes: [{ ...change, next: 31 }] }, "s".repeat(32), "actor-1", 1234));
  assert.notEqual(token, payrollWorkbookPreviewToken(input, "s".repeat(32), "actor-2", 1234));
  assert.notEqual(token, payrollWorkbookPreviewToken(input, "s".repeat(32), "actor-1", 1235));
});

test("subida de pre-nómina: limita el stream antes de parsear multipart sin Content-Length", async () => {
  const request = new Request("http://local.test/upload", {
    method: "POST",
    body: new Uint8Array(11),
  });
  await assert.rejects(() => requestWithLimitedBody(request, 10), /PAYROLL_MULTIPART_TOO_LARGE/);
});

test("subida de pre-nómina: multipart truncado se clasifica como entrada inválida", async () => {
  const request = new Request("http://local.test/upload", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=workera-boundary" },
    body: "--workera-boundary\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\ntruncado",
  });

  assert.equal(await parsePayrollMultipart(request), null);
});

test("subida de pre-nómina: acepta las cuatro frecuencias y rechaza rangos arbitrarios", () => {
  assert.equal(resolveSubmittedWorkbookPeriod({ periodType: "DIARIO", periodStart: "2026-09-06", periodEnd: "2026-09-06" }).type, "DIARIO");
  assert.equal(resolveSubmittedWorkbookPeriod({ periodType: "SEMANAL", periodStart: "2026-08-17", periodEnd: "2026-08-23" }).type, "SEMANAL");
  assert.equal(resolveSubmittedWorkbookPeriod({ periodType: "QUINCENAL", periodStart: "2026-08-16", periodEnd: "2026-08-31" }).type, "QUINCENAL");
  assert.equal(resolveSubmittedWorkbookPeriod({ periodType: "PAGO", periodStart: "2026-08-16", periodEnd: "2026-09-15" }).type, "PAGO");
  assert.throws(() => resolveSubmittedWorkbookPeriod({ periodType: "SEMANAL", periodStart: "2026-08-18", periodEnd: "2026-08-24" }), /no coinciden/i);
});

test("confirmación XLSX: la sesión exige MFA y nunca ejecuta directamente el commit privilegiado", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /resolvePayrollCompanyRole[\s\S]*?\["ADMIN_RRHH"\]/);
  assert.doesNotMatch(source, /profile\.role\s*!==\s*"ADMIN_RRHH"/);
  assert.match(source, /await assertSecondFactorForPrivileged\(supabase\)/);
  assert.match(source, /await acceptTrustedPayrollWorkbook\(\{/);
  assert.match(source, /await removeUnregisteredPayrollWorkbook\(\{/);
  assert.doesNotMatch(source, /supabase\.storage\.from\("payroll-workbooks"\)\.remove/);
  assert.doesNotMatch(source, /\.rpc\(["']register_accepted_payroll_workbook["']/);
});

test("subida XLSX: consume cuota antes de leer el cuerpo y conserva respuesta fail-closed", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const postHandler = source.slice(source.indexOf("export async function POST"), source.indexOf("export async function GET"));
  const quota = postHandler.indexOf('enforceWorkforceActionRateLimit(supabase, "workforce.payroll.manage")');
  const bodyRead = postHandler.indexOf("requestWithLimitedBody(request");

  assert.ok(quota >= 0 && bodyRead > quota, "la cuota debe consumirse antes de leer el multipart costoso");
  assert.match(postHandler, /status:\s*429[\s\S]*?Retry-After/);
  assert.match(postHandler, /status:\s*error\.decision\.status === "DENIED" \? 403 : 503/);
});

test("versiones ARCOTEX: subida y descarga histórica exigen la misma atestación del padrón de 45", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const getHandler = source.slice(source.indexOf("export async function GET"));
  assert.match(source, /uploaded\.identity\.rosterCount[\s\S]*?uploaded\.identity\.rosterSha256/);
  assert.match(getHandler, /authorizedRosterForCompany\(companyId, process\.env\.ARCOTEX_PILOT_EMPLOYEE_IDS\)/);
  assert.match(getHandler, /downloadTrustedPayrollWorkbook\(\{/);
  assert.doesNotMatch(getHandler, /supabase\.storage\.from\("payroll-workbooks"\)\.download/);
  assert.match(getHandler, /parsePayrollWorkbook\(bytes\)[\s\S]*?identity\.rosterCount[\s\S]*?identity\.rosterSha256/);
  assert.match(getHandler, /La versión no acredita el padrón autorizado de 45 personas/);
});
