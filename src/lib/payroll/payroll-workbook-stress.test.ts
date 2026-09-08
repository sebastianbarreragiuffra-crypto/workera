import assert from "node:assert/strict";
import test from "node:test";
import { runPayrollWorkbookStress } from "./payroll-workbook-stress";

test("estrés XLSX de pre-nómina usa sólo datos ficticios y aprueba cada límite", async (t) => {
  const report = await runPayrollWorkbookStress();

  assert.equal(report.syntheticDataOnly, true);
  assert.equal(report.usedSupabase, false);
  assert.equal(report.usedProduction, false);
  assert.equal(report.cases.length, 10);

  for (const result of report.cases) {
    await t.test(result.name, () => {
      assert.equal(
        result.status,
        "APROBADO",
        `${result.id}: ${result.error ?? JSON.stringify(result.actual)}`
      );
      assert.ok(result.elapsedMs < 60_000, `${result.id}: tardó ${result.elapsedMs} ms.`);
      assert.ok(
        Math.abs(result.rssDeltaBytes) < 1024 * 1024 * 1024,
        `${result.id}: variación RSS fuera de control (${result.rssDeltaBytes} bytes).`
      );
    });
  }

  assert.deepEqual(report.totals, {
    passed: 10,
    failed: 0,
    elapsedMs: report.totals.elapsedMs,
  });
});
