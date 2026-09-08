import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
} from "../src/lib/employees/arcotex-pilot-roster";
import { reconcileArcotexAuthoritativeRoster } from "../src/lib/employees/arcotex-authorized-roster-reconciliation";
import { readArcotexExistingEmployeesForRosterPreview } from "../src/lib/staging-preflight/arcotex-authorized-roster-config";
import { resolveSafeArcotexEnvironmentPath } from "../src/lib/staging-preflight/arcotex-local-file-safety";

const ROSTER_ENV_KEY = "ARCOTEX_PILOT_EMPLOYEE_IDS";
const PREVIEW_SECRET_ENV_KEY = "PAYROLL_WORKBOOK_PREVIEW_SECRET";
const MFA_ENV_KEY = "MFA_ENFORCEMENT_ENABLED";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environmentValue(lines: readonly string[], key: string): string | undefined {
  const matches = lines.filter((line) => line.startsWith(`${key}=`));
  if (matches.length > 1) throw new Error(`${key} está repetida en el archivo de entorno.`);
  return matches[0]?.slice(key.length + 1);
}

function updateEnvironment(
  environmentPath: string,
  employeeIds: readonly string[],
  secureStaging: boolean,
): { previewSecretConfigured: boolean; mfaEnforced: boolean } {
  const original = fs.readFileSync(environmentPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  const currentPreviewSecret = environmentValue(lines, PREVIEW_SECRET_ENV_KEY) ?? "";
  const values = new Map<string, string>([
    [ROSTER_ENV_KEY, [...employeeIds].sort().join(",")],
  ]);
  if (secureStaging) {
    values.set(
      PREVIEW_SECRET_ENV_KEY,
      currentPreviewSecret.length >= 32 ? currentPreviewSecret : randomBytes(48).toString("base64url"),
    );
    values.set(MFA_ENV_KEY, "true");
  }

  for (const [key, configuredValue] of values) {
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith(`${key}=`));
    if (matches.length > 1) throw new Error(`${key} está repetida en el archivo de entorno.`);
    const value = `${key}=${configuredValue}`;
    if (matches.length === 1) {
      lines[matches[0].index] = value;
    } else {
      const insertionIndex = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      lines.splice(insertionIndex, 0, value);
    }
  }
  fs.writeFileSync(environmentPath, lines.join(newline), "utf8");
  return {
    previewSecretConfigured: (values.get(PREVIEW_SECRET_ENV_KEY) ?? currentPreviewSecret).length >= 32,
    mfaEnforced: (values.get(MFA_ENV_KEY) ?? environmentValue(lines, MFA_ENV_KEY)) === "true",
  };
}

function rosterMatchesEnvironment(lines: readonly string[], employeeIds: readonly string[]): boolean {
  const configuredIds = (environmentValue(lines, ROSTER_ENV_KEY) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const expectedIds = new Set(employeeIds);
  return configuredIds.length === ARCOTEX_AUTHORIZED_ROSTER_SIZE
    && new Set(configuredIds).size === ARCOTEX_AUTHORIZED_ROSTER_SIZE
    && configuredIds.every((employeeId) => expectedIds.has(employeeId));
}

const [sourcePath, environmentPath, mode] = process.argv.slice(2);
const secureStaging = process.argv.slice(2).includes("--secure-staging");
const approveAuthoritativeRoster = process.argv.slice(2).includes("--approve-authoritative-roster");
if (!sourcePath || !environmentPath || (mode !== "--check" && mode !== "--apply")) {
  throw new Error("Uso: configure-arcotex-authorized-roster <libro-autoritativo.xls[x]> <archivo.env> <--check|--apply> [--secure-staging] [--approve-authoritative-roster]");
}
if (mode === "--apply" && !secureStaging) {
  throw new Error("--apply exige --secure-staging para configurar también MFA y el secreto de previsualización.");
}
const safeEnvironmentPath = resolveSafeArcotexEnvironmentPath(environmentPath, REPOSITORY_ROOT);
if (fs.lstatSync(safeEnvironmentPath).isSymbolicLink()) {
  throw new Error("El archivo de entorno no puede ser un enlace simbólico.");
}
const employees = await readArcotexExistingEmployeesForRosterPreview();
const reconciliation = reconcileArcotexAuthoritativeRoster(
  fs.readFileSync(path.resolve(sourcePath)),
  employees,
  { approveAuthoritativeRoster },
);
const employeeIds = reconciliation.employeeIds;
if (!employeeIds || !reconciliation.workeraCodes) {
  throw new Error(
    `La conciliación no está completa: ambiguas=${reconciliation.preview.ambiguousCount}, sin identidad=${reconciliation.preview.missingIdentityCount}.`,
  );
}

const environmentLines = fs.readFileSync(safeEnvironmentPath, "utf8").replace(/\r\n/g, "\n").split("\n");
const environmentStatus = mode === "--apply"
  ? updateEnvironment(safeEnvironmentPath, employeeIds, secureStaging)
  : {
      previewSecretConfigured: (environmentValue(environmentLines, PREVIEW_SECRET_ENV_KEY) ?? "").length >= 32,
      mfaEnforced: environmentValue(environmentLines, MFA_ENV_KEY) === "true",
    };
const finalEnvironmentLines = fs.readFileSync(safeEnvironmentPath, "utf8").replace(/\r\n/g, "\n").split("\n");
const rosterConfigured = rosterMatchesEnvironment(finalEnvironmentLines, employeeIds);
const environmentReady = rosterConfigured
  && environmentStatus.previewSecretConfigured
  && environmentStatus.mfaEnforced;

console.log(JSON.stringify({
  authorizedWorkbookWorkers: reconciliation.workeraCodes.length,
  authorizedRosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  stagingMatches: employeeIds.length,
  approvedCandidateMatches: reconciliation.approvedCandidateMatches,
  rosterConfigured,
  environmentReady,
  previewSecretConfigured: environmentStatus.previewSecretConfigured,
  mfaEnforced: environmentStatus.mfaEnforced,
  databaseWritePerformed: false,
  workbookWritePerformed: false,
}, null, 2));
