import "server-only";
import { getWorkeraConfig } from "../src/lib/workera/config";
import { WorkeraConfigurationError, WorkeraValidationError } from "../src/lib/workera/errors";
import { HttpWorkeraClient } from "../src/lib/workera/http-client";
import { collectArcotexLocalRosterStatusRows } from "../src/lib/staging-preflight/workera-roster-status-service";
import {
  buildWorkeraRosterStatusAudit,
  type WorkeraRosterAuditRow,
} from "./audit-workera-roster-status-lib";

type AuditFailureCode =
  | "INVALID_ARGUMENTS"
  | "MISSING_DATABASE_CONFIGURATION"
  | "MISSING_WORKERA_CONFIGURATION"
  | "LOCAL_ROSTER_READ_FAILED"
  | "WORKERA_REQUEST_FAILED"
  | "WORKERA_RESPONSE_INVALID"
  | "UNEXPECTED_FAILURE";

class AuditFailure extends Error {
  constructor(readonly code: AuditFailureCode) {
    super(code);
  }
}

interface AuditArguments {
  branchOffice?: string;
  department?: string;
}

function parseArguments(argv: readonly string[]): AuditArguments {
  const values = new Map<string, string>();
  const allowed = new Set(["branch-office", "department"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new AuditFailure("INVALID_ARGUMENTS");

    const equalsIndex = argument.indexOf("=");
    const key = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!allowed.has(key) || values.has(key)) throw new AuditFailure("INVALID_ARGUMENTS");

    const value = equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1);
    if (!value || (equalsIndex === -1 && value.startsWith("--"))) {
      throw new AuditFailure("INVALID_ARGUMENTS");
    }
    values.set(key, value.trim());
    if (equalsIndex === -1) index += 1;
  }

  const branchOffice = values.get("branch-office") ?? process.env.WORKERA_ROSTER_AUDIT_BRANCH_OFFICE?.trim();
  const department = values.get("department") ?? process.env.WORKERA_ROSTER_AUDIT_DEPARTMENT?.trim();
  return {
    ...(branchOffice ? { branchOffice } : {}),
    ...(department ? { department } : {}),
  };
}

async function readLocalRoster() {
  try {
    return await collectArcotexLocalRosterStatusRows();
  } catch {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new AuditFailure("MISSING_DATABASE_CONFIGURATION");
    }
    throw new AuditFailure("LOCAL_ROSTER_READ_FAILED");
  }
}

async function readWorkeraRoster(filters: AuditArguments): Promise<WorkeraRosterAuditRow[]> {
  let workeraConfig: ReturnType<typeof getWorkeraConfig>;
  try {
    workeraConfig = getWorkeraConfig();
  } catch {
    throw new AuditFailure("MISSING_WORKERA_CONFIGURATION");
  }
  if (
    workeraConfig.provider !== "http" ||
    !workeraConfig.baseUrl ||
    !workeraConfig.apiUser ||
    !workeraConfig.apiKey
  ) {
    throw new AuditFailure("MISSING_WORKERA_CONFIGURATION");
  }

  const client = new HttpWorkeraClient({
    baseUrl: workeraConfig.baseUrl,
    apiUser: workeraConfig.apiUser,
    apiKey: workeraConfig.apiKey,
    requestTimeoutMs: workeraConfig.requestTimeoutMs,
  });

  try {
    const result = await client.getAllEmployeeRoster(filters);
    return result.employees.map((employee) => ({
      code: employee.code,
      employeeStatus: employee.employeeStatus,
    }));
  } catch (error) {
    if (error instanceof WorkeraConfigurationError) throw new AuditFailure("MISSING_WORKERA_CONFIGURATION");
    if (error instanceof WorkeraValidationError) throw new AuditFailure("WORKERA_RESPONSE_INVALID");
    throw new AuditFailure("WORKERA_REQUEST_FAILED");
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const [workeraRows, localRows] = await Promise.all([
    readWorkeraRoster(args),
    readLocalRoster(),
  ]);
  const report = buildWorkeraRosterStatusAudit(workeraRows, localRows);

  process.stdout.write(
    `${JSON.stringify(
      {
        ...report,
        scope: {
          fixedArcotexWorkforceTenant: true,
          branchOfficeFilterApplied: Boolean(args.branchOffice),
          departmentFilterApplied: Boolean(args.department),
        },
      },
      null,
      2,
    )}\n`,
  );
}

try {
  await main();
} catch (error) {
  const code: AuditFailureCode = error instanceof AuditFailure ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(`${JSON.stringify({ readOnly: true, outcome: "ERROR", code })}\n`);
  process.exitCode = 1;
}
