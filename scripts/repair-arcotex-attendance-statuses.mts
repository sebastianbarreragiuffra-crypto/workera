import { repairArcotexAttendanceStatusesForDate } from "../src/lib/staging-preflight/arcotex-attendance-status-repair-service";

const dateArgument = process.argv.find((argument) => argument.startsWith("--date="));
const date = dateArgument?.slice("--date=".length) ?? "";
const apply = process.argv.includes("--apply");
const result = await repairArcotexAttendanceStatusesForDate(date, apply);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (
  result.kind === "INVALID_DATE" ||
  result.kind === "COMPANY_NOT_FOUND" ||
  result.kind === "QUERY_FAILED" ||
  result.kind === "BLOCKED_UNRECOGNIZED_STATUS" ||
  result.kind === "BLOCKED_ACTIVE_RUN" ||
  result.kind === "FAILED"
) {
  process.exitCode = 1;
}
