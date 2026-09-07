import { readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateHostingRuntime,
  renderHostingRuntimeReport,
} from "../src/lib/architecture/hosting-runtime-readiness";

const manifestPath = path.resolve(process.cwd(), "vercel.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  crons?: Array<{ path: string }>;
};
const report = evaluateHostingRuntime(
  process.env,
  (manifest.crons ?? []).map((cron) => cron.path),
);

process.stdout.write(`${renderHostingRuntimeReport(report)}\n`);
if (report.decision !== "READY") process.exitCode = 1;
