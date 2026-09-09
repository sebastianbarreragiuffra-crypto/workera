import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INPUT_SCHEMA_VERSION = "ARCOTEX_SHADOW_REPLAY_V1";
const OUTPUT_SCHEMA_VERSION = 1;
const ARCOTEX_AUTHORIZED_ROSTER_SIZE = 45;
const EXPECTED_DAYS = 7;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_AGGREGATE_COUNT = 1_000_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const RUN_STATUSES = new Set([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "RUNNING",
  "MISSING",
  "OTHER",
] as const);

type RunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED" | "RUNNING" | "MISSING" | "OTHER";

const INPUT_ERROR_CODES = [
  "INVALID_ARGUMENTS",
  "INPUT_NOT_JSON",
  "INPUT_NOT_REGULAR_FILE",
  "INPUT_TOO_LARGE",
  "INPUT_UNREADABLE",
  "INVALID_JSON",
  "INVALID_SCHEMA",
  "UNEXPECTED_FIELD",
  "PII_FIELD_PRESENT",
  "INVALID_VALUE",
] as const;

const BUSINESS_BLOCKER_CODES = [
  "SYNC_NOT_DISABLED",
  "ROSTER_NOT_45_OF_45",
  "ROSTER_ATTESTATION_MISMATCH",
  "WEEK_NOT_7_OF_7",
  "SYNC_STATUS_NOT_SUCCEEDED",
  "RULE_ENGINE_STATUS_NOT_SUCCEEDED",
  "RULE_ENGINE_INPUT_NOT_FRESH",
  "EMPLOYEE_SCOPE_INCOMPLETE",
  "RECONCILIATION_MISMATCH",
  "DUPLICATE_CURRENT_EVENTS",
  "OUTSIDE_ROSTER_EVENTS",
  "AMBIGUOUS_IDENTITIES",
  "UNRESOLVED_SOURCE_STATUSES",
  "RULE_ENGINE_FAILURES",
  "MISSING_SCHEDULES",
  "NO_CAPTURED_ATTENDANCE",
  "NO_DERIVED_ATTENDANCE",
] as const;

const INTERNAL_BLOCKER_CODES = ["OUTPUT_SANITIZATION_FAILED", "INTERNAL_VALIDATION_ERROR"] as const;

export type ReplayBlockerCode =
  | (typeof INPUT_ERROR_CODES)[number]
  | (typeof BUSINESS_BLOCKER_CODES)[number]
  | (typeof INTERNAL_BLOCKER_CODES)[number];

const REPLAY_BLOCKER_CODES = new Set<ReplayBlockerCode>([
  ...INPUT_ERROR_CODES,
  ...BUSINESS_BLOCKER_CODES,
  ...INTERNAL_BLOCKER_CODES,
]);

const FORBIDDEN_INPUT_KEYS = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "rut",
  "email",
  "phone",
  "telephone",
  "mobile",
  "address",
  "employeeid",
  "externalemployeeid",
  "externalworkeraid",
  "companyid",
  "userid",
  "profileid",
  "documentid",
  "payload",
  "rawpayload",
  "token",
  "secret",
  "password",
  "cookie",
  "authorization",
]);

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "scope",
  "mode",
  "workeraSyncEnabled",
  "week",
  "roster",
  "days",
  "reconciliation",
] as const;

const WEEK_KEYS = ["start", "end"] as const;
const ROSTER_KEYS = [
  "expectedEmployees",
  "observedEmployees",
  "expectedScopeSha256",
  "observedScopeSha256",
] as const;
const DAY_KEYS = [
  "date",
  "syncStatus",
  "ruleEngineStatus",
  "inputFresh",
  "employeesProcessed",
  "rawEvents",
  "derivedRecords",
  "duplicateCurrentEvents",
  "outsideRosterEvents",
  "ambiguousIdentityMatches",
  "unresolvedSourceStatuses",
  "ruleFailures",
  "withoutSchedule",
] as const;
const RECONCILIATION_KEYS = [
  "employeesProcessed",
  "rawEvents",
  "derivedRecords",
  "duplicateCurrentEvents",
  "outsideRosterEvents",
  "ambiguousIdentityMatches",
  "unresolvedSourceStatuses",
  "ruleFailures",
  "withoutSchedule",
] as const;

type ReconciliationMetric = (typeof RECONCILIATION_KEYS)[number];
type JsonRecord = Record<string, unknown>;

export interface SanitizedReplayDay {
  readonly date: string;
  readonly syncStatus: RunStatus;
  readonly ruleEngineStatus: RunStatus;
  readonly inputFresh: boolean;
  readonly employeesProcessed: number;
  readonly rawEvents: number;
  readonly derivedRecords: number;
  readonly duplicateCurrentEvents: number;
  readonly outsideRosterEvents: number;
  readonly ambiguousIdentityMatches: number;
  readonly unresolvedSourceStatuses: number;
  readonly ruleFailures: number;
  readonly withoutSchedule: number;
}

export interface SanitizedReplayArtifact {
  readonly schemaVersion: typeof INPUT_SCHEMA_VERSION;
  readonly scope: "ARCOTEX";
  readonly mode: "OFFLINE_SANITIZED_AGGREGATES";
  readonly workeraSyncEnabled: boolean;
  readonly week: { readonly start: string; readonly end: string };
  readonly roster: {
    readonly expectedEmployees: number;
    readonly observedEmployees: number;
    readonly expectedScopeSha256: string;
    readonly observedScopeSha256: string;
  };
  readonly days: readonly SanitizedReplayDay[];
  readonly reconciliation: Readonly<Record<ReconciliationMetric, number>>;
}

export interface ReplayMetrics {
  readonly authorizedRosterExpected: number;
  readonly authorizedRosterObserved: number;
  readonly daysExpected: number;
  readonly daysObserved: number;
  readonly syncSucceededDays: number;
  readonly ruleEngineSucceededDays: number;
  readonly freshRuleEngineDays: number;
  readonly employeesProcessed: number;
  readonly rawEvents: number;
  readonly derivedRecords: number;
  readonly duplicateCurrentEvents: number;
  readonly outsideRosterEvents: number;
  readonly ambiguousIdentityMatches: number;
  readonly unresolvedSourceStatuses: number;
  readonly ruleFailures: number;
  readonly withoutSchedule: number;
  readonly reconciliationMismatches: number;
}

export interface ReplayChecks {
  readonly syncDisabled: boolean;
  readonly roster45Of45: boolean;
  readonly rosterAttestationMatches: boolean;
  readonly week7Of7: boolean;
  readonly syncStatesSucceeded: boolean;
  readonly ruleEngineStatesSucceeded: boolean;
  readonly ruleEngineInputsFresh: boolean;
  readonly employeeScopeComplete: boolean;
  readonly reconciliationMatches: boolean;
  readonly noDuplicateCurrentEvents: boolean;
  readonly noOutsideRosterEvents: boolean;
  readonly noAmbiguousIdentities: boolean;
  readonly noUnresolvedSourceStatuses: boolean;
  readonly noRuleFailures: boolean;
  readonly noMissingSchedules: boolean;
  readonly capturedAttendancePresent: boolean;
  readonly derivedAttendancePresent: boolean;
}

export interface ReplayReport {
  readonly schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  readonly readOnly: true;
  readonly source: "SANITIZED_AGGREGATES";
  readonly outcome: "READY_FOR_SHADOW_REVIEW" | "BLOCKED";
  readonly metrics: ReplayMetrics | null;
  readonly checks: ReplayChecks | null;
  readonly blockers: readonly ReplayBlockerCode[];
}

class ReplayValidationError extends Error {
  constructor(readonly code: (typeof INPUT_ERROR_CODES)[number]) {
    super(code);
    this.name = "ReplayValidationError";
  }
}

function validationFailure(code: (typeof INPUT_ERROR_CODES)[number]): never {
  throw new ReplayValidationError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenInputKey(value: string): boolean {
  const normalized = normalizedKey(value);
  return [...FORBIDDEN_INPUT_KEYS].some(
    (forbidden) => normalized === forbidden || normalized.endsWith(forbidden),
  );
}

function rejectPotentialPiiFields(value: unknown, depth = 0): void {
  if (depth > 16) validationFailure("INVALID_SCHEMA");
  if (Array.isArray(value)) {
    for (const entry of value) rejectPotentialPiiFields(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (isForbiddenInputKey(key)) validationFailure("PII_FIELD_PRESENT");
    rejectPotentialPiiFields(entry, depth + 1);
  }
}

function exactKeys(record: JsonRecord, expected: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    validationFailure("UNEXPECTED_FIELD");
  }
}

function recordValue(value: unknown): JsonRecord {
  if (!isRecord(value)) validationFailure("INVALID_SCHEMA");
  return value;
}

function fixedString(value: unknown, expected: string): string {
  if (value !== expected) validationFailure("INVALID_VALUE");
  return expected;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") validationFailure("INVALID_VALUE");
  return value;
}

function countValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_AGGREGATE_COUNT) {
    validationFailure("INVALID_VALUE");
  }
  return value as number;
}

function digestValue(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) validationFailure("INVALID_VALUE");
  return value;
}

function isoDateValue(value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) validationFailure("INVALID_VALUE");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    validationFailure("INVALID_VALUE");
  }
  return value;
}

function runStatusValue(value: unknown): RunStatus {
  if (typeof value !== "string" || !RUN_STATUSES.has(value as RunStatus)) {
    validationFailure("INVALID_VALUE");
  }
  return value as RunStatus;
}

function parseDay(value: unknown): SanitizedReplayDay {
  const day = recordValue(value);
  exactKeys(day, DAY_KEYS);
  return {
    date: isoDateValue(day.date),
    syncStatus: runStatusValue(day.syncStatus),
    ruleEngineStatus: runStatusValue(day.ruleEngineStatus),
    inputFresh: booleanValue(day.inputFresh),
    employeesProcessed: countValue(day.employeesProcessed),
    rawEvents: countValue(day.rawEvents),
    derivedRecords: countValue(day.derivedRecords),
    duplicateCurrentEvents: countValue(day.duplicateCurrentEvents),
    outsideRosterEvents: countValue(day.outsideRosterEvents),
    ambiguousIdentityMatches: countValue(day.ambiguousIdentityMatches),
    unresolvedSourceStatuses: countValue(day.unresolvedSourceStatuses),
    ruleFailures: countValue(day.ruleFailures),
    withoutSchedule: countValue(day.withoutSchedule),
  };
}

export function parseSanitizedReplayArtifact(value: unknown): SanitizedReplayArtifact {
  rejectPotentialPiiFields(value);
  const artifact = recordValue(value);
  exactKeys(artifact, TOP_LEVEL_KEYS);

  const week = recordValue(artifact.week);
  exactKeys(week, WEEK_KEYS);
  const roster = recordValue(artifact.roster);
  exactKeys(roster, ROSTER_KEYS);
  const reconciliation = recordValue(artifact.reconciliation);
  exactKeys(reconciliation, RECONCILIATION_KEYS);
  if (!Array.isArray(artifact.days) || artifact.days.length > 31) validationFailure("INVALID_VALUE");

  return {
    schemaVersion: fixedString(artifact.schemaVersion, INPUT_SCHEMA_VERSION) as typeof INPUT_SCHEMA_VERSION,
    scope: fixedString(artifact.scope, "ARCOTEX") as "ARCOTEX",
    mode: fixedString(artifact.mode, "OFFLINE_SANITIZED_AGGREGATES") as "OFFLINE_SANITIZED_AGGREGATES",
    workeraSyncEnabled: booleanValue(artifact.workeraSyncEnabled),
    week: {
      start: isoDateValue(week.start),
      end: isoDateValue(week.end),
    },
    roster: {
      expectedEmployees: countValue(roster.expectedEmployees),
      observedEmployees: countValue(roster.observedEmployees),
      expectedScopeSha256: digestValue(roster.expectedScopeSha256),
      observedScopeSha256: digestValue(roster.observedScopeSha256),
    },
    days: artifact.days.map(parseDay),
    reconciliation: Object.fromEntries(
      RECONCILIATION_KEYS.map((key) => [key, countValue(reconciliation[key])]),
    ) as Record<ReconciliationMetric, number>,
  };
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function completeMondayToSundayWeek(artifact: SanitizedReplayArtifact): boolean {
  const expectedDates = Array.from({ length: EXPECTED_DAYS }, (_, index) => shiftDate(artifact.week.start, index));
  const actualDates = new Set(artifact.days.map((day) => day.date));
  return new Date(`${artifact.week.start}T00:00:00Z`).getUTCDay() === 1
    && artifact.week.end === expectedDates[EXPECTED_DAYS - 1]
    && artifact.days.length === EXPECTED_DAYS
    && actualDates.size === EXPECTED_DAYS
    && expectedDates.every((date) => actualDates.has(date));
}

function totalsForDays(days: readonly SanitizedReplayDay[]): Record<ReconciliationMetric, number> {
  return Object.fromEntries(
    RECONCILIATION_KEYS.map((key) => [key, days.reduce((total, day) => total + day[key], 0)]),
  ) as Record<ReconciliationMetric, number>;
}

function blockedReport(code: ReplayBlockerCode): ReplayReport {
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    readOnly: true,
    source: "SANITIZED_AGGREGATES",
    outcome: "BLOCKED",
    metrics: null,
    checks: null,
    blockers: [code],
  };
}

export function buildReplayReport(artifact: SanitizedReplayArtifact): ReplayReport {
  const totals = totalsForDays(artifact.days);
  const reconciliationMismatches = RECONCILIATION_KEYS.filter(
    (key) => artifact.reconciliation[key] !== totals[key],
  ).length;
  const metrics: ReplayMetrics = {
    authorizedRosterExpected: artifact.roster.expectedEmployees,
    authorizedRosterObserved: artifact.roster.observedEmployees,
    daysExpected: EXPECTED_DAYS,
    daysObserved: artifact.days.length,
    syncSucceededDays: artifact.days.filter((day) => day.syncStatus === "SUCCEEDED").length,
    ruleEngineSucceededDays: artifact.days.filter((day) => day.ruleEngineStatus === "SUCCEEDED").length,
    freshRuleEngineDays: artifact.days.filter((day) => day.inputFresh).length,
    employeesProcessed: totals.employeesProcessed,
    rawEvents: totals.rawEvents,
    derivedRecords: totals.derivedRecords,
    duplicateCurrentEvents: totals.duplicateCurrentEvents,
    outsideRosterEvents: totals.outsideRosterEvents,
    ambiguousIdentityMatches: totals.ambiguousIdentityMatches,
    unresolvedSourceStatuses: totals.unresolvedSourceStatuses,
    ruleFailures: totals.ruleFailures,
    withoutSchedule: totals.withoutSchedule,
    reconciliationMismatches,
  };
  const checks: ReplayChecks = {
    syncDisabled: artifact.workeraSyncEnabled === false,
    roster45Of45: artifact.roster.expectedEmployees === ARCOTEX_AUTHORIZED_ROSTER_SIZE
      && artifact.roster.observedEmployees === ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterAttestationMatches: artifact.roster.expectedScopeSha256 === artifact.roster.observedScopeSha256,
    week7Of7: completeMondayToSundayWeek(artifact),
    syncStatesSucceeded: metrics.syncSucceededDays === EXPECTED_DAYS,
    ruleEngineStatesSucceeded: metrics.ruleEngineSucceededDays === EXPECTED_DAYS,
    ruleEngineInputsFresh: metrics.freshRuleEngineDays === EXPECTED_DAYS,
    employeeScopeComplete: artifact.days.length === EXPECTED_DAYS
      && artifact.days.every((day) => day.employeesProcessed === ARCOTEX_AUTHORIZED_ROSTER_SIZE),
    reconciliationMatches: reconciliationMismatches === 0,
    noDuplicateCurrentEvents: totals.duplicateCurrentEvents === 0,
    noOutsideRosterEvents: totals.outsideRosterEvents === 0,
    noAmbiguousIdentities: totals.ambiguousIdentityMatches === 0,
    noUnresolvedSourceStatuses: totals.unresolvedSourceStatuses === 0,
    noRuleFailures: totals.ruleFailures === 0,
    noMissingSchedules: totals.withoutSchedule === 0,
    capturedAttendancePresent: totals.rawEvents > 0,
    derivedAttendancePresent: totals.derivedRecords > 0,
  };

  const blockers: ReplayBlockerCode[] = [];
  if (!checks.syncDisabled) blockers.push("SYNC_NOT_DISABLED");
  if (!checks.roster45Of45) blockers.push("ROSTER_NOT_45_OF_45");
  if (!checks.rosterAttestationMatches) blockers.push("ROSTER_ATTESTATION_MISMATCH");
  if (!checks.week7Of7) blockers.push("WEEK_NOT_7_OF_7");
  if (!checks.syncStatesSucceeded) blockers.push("SYNC_STATUS_NOT_SUCCEEDED");
  if (!checks.ruleEngineStatesSucceeded) blockers.push("RULE_ENGINE_STATUS_NOT_SUCCEEDED");
  if (!checks.ruleEngineInputsFresh) blockers.push("RULE_ENGINE_INPUT_NOT_FRESH");
  if (!checks.employeeScopeComplete) blockers.push("EMPLOYEE_SCOPE_INCOMPLETE");
  if (!checks.reconciliationMatches) blockers.push("RECONCILIATION_MISMATCH");
  if (!checks.noDuplicateCurrentEvents) blockers.push("DUPLICATE_CURRENT_EVENTS");
  if (!checks.noOutsideRosterEvents) blockers.push("OUTSIDE_ROSTER_EVENTS");
  if (!checks.noAmbiguousIdentities) blockers.push("AMBIGUOUS_IDENTITIES");
  if (!checks.noUnresolvedSourceStatuses) blockers.push("UNRESOLVED_SOURCE_STATUSES");
  if (!checks.noRuleFailures) blockers.push("RULE_ENGINE_FAILURES");
  if (!checks.noMissingSchedules) blockers.push("MISSING_SCHEDULES");
  if (!checks.capturedAttendancePresent) blockers.push("NO_CAPTURED_ATTENDANCE");
  if (!checks.derivedAttendancePresent) blockers.push("NO_DERIVED_ATTENDANCE");

  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    readOnly: true,
    source: "SANITIZED_AGGREGATES",
    outcome: blockers.length === 0 ? "READY_FOR_SHADOW_REVIEW" : "BLOCKED",
    metrics,
    checks,
    blockers,
  };
}

export function evaluateReplayText(text: string): ReplayReport {
  try {
    return buildReplayReport(parseSanitizedReplayArtifact(JSON.parse(text) as unknown));
  } catch (error) {
    if (error instanceof SyntaxError) return blockedReport("INVALID_JSON");
    if (error instanceof ReplayValidationError) return blockedReport(error.code);
    return blockedReport("INTERNAL_VALIDATION_ERROR");
  }
}

const OUTPUT_TOP_LEVEL_KEYS = ["schemaVersion", "readOnly", "source", "outcome", "metrics", "checks", "blockers"];
const OUTPUT_METRIC_KEYS = [
  "authorizedRosterExpected",
  "authorizedRosterObserved",
  "daysExpected",
  "daysObserved",
  "syncSucceededDays",
  "ruleEngineSucceededDays",
  "freshRuleEngineDays",
  "employeesProcessed",
  "rawEvents",
  "derivedRecords",
  "duplicateCurrentEvents",
  "outsideRosterEvents",
  "ambiguousIdentityMatches",
  "unresolvedSourceStatuses",
  "ruleFailures",
  "withoutSchedule",
  "reconciliationMismatches",
] as const;
const OUTPUT_CHECK_KEYS = [
  "syncDisabled",
  "roster45Of45",
  "rosterAttestationMatches",
  "week7Of7",
  "syncStatesSucceeded",
  "ruleEngineStatesSucceeded",
  "ruleEngineInputsFresh",
  "employeeScopeComplete",
  "reconciliationMatches",
  "noDuplicateCurrentEvents",
  "noOutsideRosterEvents",
  "noAmbiguousIdentities",
  "noUnresolvedSourceStatuses",
  "noRuleFailures",
  "noMissingSchedules",
  "capturedAttendancePresent",
  "derivedAttendancePresent",
] as const;

function hasExactOutputKeys(record: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function hasSafeOutputShape(value: unknown): value is ReplayReport {
  if (!isRecord(value) || !hasExactOutputKeys(value, OUTPUT_TOP_LEVEL_KEYS)) return false;
  if (value.schemaVersion !== OUTPUT_SCHEMA_VERSION || value.readOnly !== true || value.source !== "SANITIZED_AGGREGATES") {
    return false;
  }
  if (value.outcome !== "READY_FOR_SHADOW_REVIEW" && value.outcome !== "BLOCKED") return false;
  if (!Array.isArray(value.blockers) || value.blockers.some((code) => !REPLAY_BLOCKER_CODES.has(code as ReplayBlockerCode))) {
    return false;
  }
  if (value.metrics === null || value.checks === null) {
    return value.outcome === "BLOCKED" && value.metrics === null && value.checks === null && value.blockers.length === 1;
  }
  const metrics = value.metrics;
  if (!isRecord(metrics) || !hasExactOutputKeys(metrics, OUTPUT_METRIC_KEYS)) return false;
  if (OUTPUT_METRIC_KEYS.some((key) => !Number.isSafeInteger(metrics[key]) || (metrics[key] as number) < 0)) {
    return false;
  }
  const checks = value.checks;
  if (!isRecord(checks) || !hasExactOutputKeys(checks, OUTPUT_CHECK_KEYS)) return false;
  if (OUTPUT_CHECK_KEYS.some((key) => typeof checks[key] !== "boolean")) return false;
  return value.outcome === (value.blockers.length === 0 ? "READY_FOR_SHADOW_REVIEW" : "BLOCKED");
}

function serializedOutputContainsPii(serialized: string): boolean {
  const patterns = [
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dk]\b/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    /\bbearer\s+[a-z0-9._~-]+/i,
    /"(?:first[_-]?name|last[_-]?name|display[_-]?name|full[_-]?name|rut|email|phone|employee[_-]?id|company[_-]?id|token|secret|password|cookie|payload)"\s*:/i,
  ];
  return patterns.some((pattern) => pattern.test(serialized));
}

export function serializeReplayReport(report: ReplayReport): string {
  if (!hasSafeOutputShape(report)) return JSON.stringify(blockedReport("OUTPUT_SANITIZATION_FAILED"), null, 2);
  const serialized = JSON.stringify(report, null, 2);
  if (serializedOutputContainsPii(serialized)) {
    return JSON.stringify(blockedReport("OUTPUT_SANITIZATION_FAILED"), null, 2);
  }
  return serialized;
}

export async function evaluateReplayFile(inputPath: string): Promise<ReplayReport> {
  if (path.extname(inputPath).toLowerCase() !== ".json") return blockedReport("INPUT_NOT_JSON");
  try {
    const metadata = await lstat(inputPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return blockedReport("INPUT_NOT_REGULAR_FILE");
    if (metadata.size > MAX_INPUT_BYTES) return blockedReport("INPUT_TOO_LARGE");
    return evaluateReplayText(await readFile(inputPath, "utf8"));
  } catch {
    return blockedReport("INPUT_UNREADABLE");
  }
}

function inputArgument(arguments_: readonly string[]): string | null {
  if (arguments_.length === 1 && arguments_[0].startsWith("--input=")) {
    return arguments_[0].slice("--input=".length).trim() || null;
  }
  if (arguments_.length === 2 && arguments_[0] === "--input") return arguments_[1].trim() || null;
  return null;
}

async function runCli(): Promise<void> {
  const inputPath = inputArgument(process.argv.slice(2));
  const report = inputPath ? await evaluateReplayFile(inputPath) : blockedReport("INVALID_ARGUMENTS");
  process.stdout.write(`${serializeReplayReport(report)}\n`);
  if (report.outcome !== "READY_FOR_SHADOW_REVIEW") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await runCli();
