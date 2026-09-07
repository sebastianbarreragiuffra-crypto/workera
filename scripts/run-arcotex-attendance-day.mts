import { runRuleEngineWithServiceRole } from "../src/lib/rule-engine/service";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../src/lib/shared/workforce-constants";
import { isIsoCalendarDate } from "../src/lib/staging-preflight/arcotex-attendance-status-repair";

const dateArgument = process.argv.find((argument) => argument.startsWith("--date="));
const date = dateArgument?.slice("--date=".length) ?? "";
if (!isIsoCalendarDate(date)) {
  process.stderr.write("Se requiere --date=YYYY-MM-DD con una fecha calendario válida.\n");
  process.exit(2);
}

const outcome = await runRuleEngineWithServiceRole(date, {
  companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
  triggeredBy: "MANUAL",
});

process.stdout.write(`${JSON.stringify({
  date,
  status: outcome.status,
  employeesProcessed: outcome.result?.employeesProcessed ?? 0,
  attendanceDerived: outcome.result?.attendanceDerived ?? 0,
  attendanceUnchanged: outcome.result?.attendanceUnchanged ?? 0,
  withoutSchedule: outcome.result?.withoutSchedule ?? 0,
  lateCandidates: outcome.result?.lateCandidates ?? 0,
  earlyDepartureCandidates: outcome.result?.earlyDepartureCandidates ?? 0,
  overtimeCandidates: outcome.result?.overtimeCandidates ?? 0,
  failureCount: outcome.result?.failures.length ?? 0,
}, null, 2)}\n`);

if (outcome.status !== "SUCCEEDED") process.exitCode = 1;
