import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePayrollMultipart, payrollWorkbookPreviewToken, requestWithLimitedBody } from "./route";

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
