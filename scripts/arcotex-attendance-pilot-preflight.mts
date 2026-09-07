import {
  buildArcotexAttendancePilotReport,
  renderArcotexAttendancePilotReport,
} from "../src/lib/staging-preflight/arcotex-attendance";
import { collectArcotexAttendancePilot } from "../src/lib/staging-preflight/arcotex-attendance-service";

const nowArgument = process.argv.find((argument) => argument.startsWith("--now="));
const now = nowArgument ? new Date(nowArgument.slice("--now=".length)) : new Date();
if (Number.isNaN(now.getTime())) {
  process.stderr.write("El valor de --now debe ser una fecha ISO válida.\n");
  process.exit(2);
}

const collection = await collectArcotexAttendancePilot(now);
const report = buildArcotexAttendancePilotReport(collection);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${renderArcotexAttendancePilotReport(report)}\n`);
}

if (report.outcome !== "READY_FOR_SHADOW_REVIEW") process.exitCode = 1;
