import fs from "node:fs";
import { reconcileArcotexAuthoritativeRoster } from "../src/lib/employees/arcotex-authorized-roster-reconciliation";
import { readArcotexExistingEmployeesForRosterPreview } from "../src/lib/staging-preflight/arcotex-authorized-roster-config";

const sourcePath = process.argv[2];
const approveAuthoritativeRoster = process.argv.slice(3).includes("--approve-authoritative-roster");
if (!sourcePath) {
  throw new Error("Uso: preview-arcotex-attendance-roster <origen.xls> [--approve-authoritative-roster]");
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Falta la configuración de staging para una lectura de empleados.");
}

const employees = await readArcotexExistingEmployeesForRosterPreview();
const reconciliation = reconcileArcotexAuthoritativeRoster(
  fs.readFileSync(sourcePath),
  employees,
  { approveAuthoritativeRoster },
);
const { parsed, preview, employeeIds: approvedEmployeeIds } = reconciliation;
const configuredEmployeeIdList = (process.env.ARCOTEX_PILOT_EMPLOYEE_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const configuredEmployeeIds = new Set(configuredEmployeeIdList);
const configuredRosterMatches = configuredEmployeeIdList.length === 0 || approvedEmployeeIds === null
  ? null
  : configuredEmployeeIdList.length === approvedEmployeeIds.length
    && configuredEmployeeIds.size === approvedEmployeeIds.length
    && [...configuredEmployeeIds].every((employeeId) => approvedEmployeeIds.includes(employeeId));

console.log(JSON.stringify({
  rosterNames: parsed.rosterCount,
  duplicateRowsWithinSheet: parsed.duplicateRowsWithinSheet.length,
  parseBlockingIssues: parsed.issues.filter((issue) => issue.blocking).length,
  linked: preview.linkedCount,
  possibleNew: preview.possibleNewCount,
  ambiguous: preview.ambiguousCount,
  missingIdentity: preview.missingIdentityCount,
  okToApply: preview.okToApply,
  approvedCandidateMatches: reconciliation.approvedCandidateMatches,
  authorizedCodesMatch: reconciliation.workeraCodes === null ? null : true,
  configuredRosterMatches,
  stagingWritePerformed: false,
}, null, 2));
