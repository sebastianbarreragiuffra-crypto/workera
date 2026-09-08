import "server-only";

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPayrollWorkbookStress } from "../src/lib/payroll/payroll-workbook-stress";

const outputPath = resolve(
  process.argv[2] ?? "outputs/payroll-audit-stress/payroll-workbook-stress.json"
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const report = await runPayrollWorkbookStress();
const payload = {
  ...report,
  commit,
  command:
    "node --conditions=react-server --import=tsx scripts/run-payroll-workbook-stress.mts",
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  outputPath,
  commit,
  executedAt: report.executedAt,
  totals: report.totals,
  memory: report.memory,
  cases: report.cases.map((item) => ({
    id: item.id,
    status: item.status,
    elapsedMs: item.elapsedMs,
    heapDeltaBytes: item.heapDeltaBytes,
    rssDeltaBytes: item.rssDeltaBytes,
    error: item.error,
  })),
}, null, 2));

if (report.totals.failed > 0) process.exitCode = 1;
