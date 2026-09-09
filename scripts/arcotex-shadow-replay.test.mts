import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256 } from "../src/lib/shared/arcotex-authorized-roster";
import {
  buildReplayReport,
  canonicalReplayArtifactJson,
  evaluateReplayFile,
  evaluateReplayText,
  replayArtifactSha256,
  serializeReplayReport,
  type SanitizedReplayArtifact,
} from "./arcotex-shadow-replay.mts";

type Mutable<T> = T extends readonly (infer Entry)[]
  ? Mutable<Entry>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

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

const SYNTHETIC_CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";

function consistentArtifact(): SanitizedReplayArtifact {
  const rawEvents = [60, 62, 61, 59, 58, 0, 0];
  const derivedRecords = [45, 45, 45, 45, 45, 0, 0];
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date("2024-01-01T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      syncStatus: "SUCCEEDED" as const,
      ruleEngineStatus: "SUCCEEDED" as const,
      inputFresh: true,
      employeesProcessed: 45,
      rawEvents: rawEvents[index],
      derivedRecords: derivedRecords[index],
      duplicateCurrentEvents: 0,
      outsideRosterEvents: 0,
      ambiguousIdentityMatches: 0,
      unresolvedSourceStatuses: 0,
      ruleFailures: 0,
      withoutSchedule: 0,
    };
  });
  return {
    schemaVersion: "ARCOTEX_SHADOW_REPLAY_V2",
    candidateSha: SYNTHETIC_CANDIDATE_SHA,
    scope: "ARCOTEX",
    mode: "OFFLINE_SANITIZED_AGGREGATES",
    workeraSyncEnabledDeclared: false,
    week: { start: "2024-01-01", end: "2024-01-07" },
    roster: {
      expectedEmployees: 45,
      observedEmployees: 45,
      observedScopeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
    },
    days,
    reconciliation: {
      employeesProcessed: 315,
      rawEvents: 300,
      derivedRecords: 225,
      duplicateCurrentEvents: 0,
      outsideRosterEvents: 0,
      ambiguousIdentityMatches: 0,
      unresolvedSourceStatuses: 0,
      ruleFailures: 0,
      withoutSchedule: 0,
    },
  };
}

function mutableConsistentArtifact(): Mutable<SanitizedReplayArtifact> {
  return structuredClone(consistentArtifact()) as Mutable<SanitizedReplayArtifact>;
}

function reconcile(artifact: Mutable<SanitizedReplayArtifact>): void {
  for (const key of RECONCILIATION_KEYS) {
    artifact.reconciliation[key] = artifact.days.reduce((total, day) => total + day[key], 0);
  }
}

function inheritedTypescriptRuntimeArguments(): string[] {
  const result: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if (argument === "--import" || argument === "--require") {
      result.push(argument, process.execArgv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--import=") || argument.startsWith("--require=")) {
      result.push(argument);
    }
  }
  return result;
}

test("declara consistente únicamente evidencia agregada 45/45 y 7/7 conciliada", () => {
  const report = buildReplayReport(consistentArtifact());

  assert.equal(report.outcome, "CONSISTENT_OFFLINE_EVIDENCE");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.evidence, {
    candidateSha: SYNTHETIC_CANDIDATE_SHA,
    week: { start: "2024-01-01", end: "2024-01-07" },
    artifactSha256: replayArtifactSha256(consistentArtifact()),
  });
  assert.deepEqual(report.metrics, {
    authorizedRosterExpected: 45,
    authorizedRosterObserved: 45,
    daysExpected: 7,
    daysObserved: 7,
    syncSucceededDays: 7,
    ruleEngineSucceededDays: 7,
    freshRuleEngineDays: 7,
    employeesProcessed: 315,
    rawEvents: 300,
    derivedRecords: 225,
    duplicateCurrentEvents: 0,
    outsideRosterEvents: 0,
    ambiguousIdentityMatches: 0,
    unresolvedSourceStatuses: 0,
    ruleFailures: 0,
    withoutSchedule: 0,
    reconciliationMismatches: 0,
  });
  assert.ok(report.checks && Object.values(report.checks).every(Boolean));
  assert.doesNotMatch(serializeReplayReport(report), new RegExp(ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256));
});

test("falla cerrado si el padrón no es 45/45 o no coincide con la constante autorizada", () => {
  const artifact = mutableConsistentArtifact();
  artifact.roster.observedEmployees = 44;
  artifact.roster.observedScopeSha256 = "b".repeat(64);
  artifact.days[0].employeesProcessed = 44;
  reconcile(artifact);

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("ROSTER_NOT_45_OF_45"));
  assert.ok(report.blockers.includes("AUTHORIZED_ROSTER_DIGEST_MISMATCH"));
  assert.ok(report.blockers.includes("EMPLOYEE_SCOPE_INCOMPLETE"));

  const selfAttested = structuredClone(consistentArtifact()) as unknown as Record<string, unknown>;
  const roster = selfAttested.roster as Record<string, unknown>;
  roster.expectedScopeSha256 = "b".repeat(64);
  roster.observedScopeSha256 = "b".repeat(64);
  assert.deepEqual(evaluateReplayText(JSON.stringify(selfAttested)).blockers, ["UNEXPECTED_FIELD"]);
});

test("rechaza una semana incompleta, con fecha duplicada o fuera de lunes a domingo", () => {
  const incomplete = mutableConsistentArtifact();
  incomplete.days.pop();
  reconcile(incomplete);
  assert.ok(buildReplayReport(incomplete).blockers.includes("WEEK_NOT_7_OF_7"));

  const duplicate = mutableConsistentArtifact();
  duplicate.days[6].date = duplicate.days[5].date;
  assert.ok(buildReplayReport(duplicate).blockers.includes("WEEK_NOT_7_OF_7"));

  const wrongBoundary = mutableConsistentArtifact();
  wrongBoundary.week.start = "2024-01-02";
  wrongBoundary.week.end = "2024-01-08";
  assert.ok(buildReplayReport(wrongBoundary).blockers.includes("WEEK_NOT_7_OF_7"));
});

test("la declaración de sync y estados parciales, fallidos u obsoletos bloquean", () => {
  const artifact = mutableConsistentArtifact();
  artifact.workeraSyncEnabledDeclared = true;
  artifact.days[0].syncStatus = "PARTIAL";
  artifact.days[1].ruleEngineStatus = "FAILED";
  artifact.days[2].inputFresh = false;

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("SYNC_DISABLED_NOT_DECLARED"));
  assert.ok(report.blockers.includes("SYNC_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_INPUT_NOT_FRESH"));
});

test("la foto agregada ya documentada permanece BLOCKED sin reejecutar el motor", () => {
  const artifact = mutableConsistentArtifact();
  artifact.candidateSha = "1f9d214c8639e301b6700813b48a3996de3970b3";
  artifact.week = { start: "2026-08-24", end: "2026-08-30" };
  const rawEvents = [60, 60, 60, 60, 60, 48, 48];
  const derivedRecords = [30, 30, 30, 30, 30, 23, 22];
  const ruleFailures = [38, 37, 37, 37, 37, 0, 0];
  artifact.days.forEach((day, index) => {
    day.date = new Date(Date.UTC(2026, 7, 24 + index)).toISOString().slice(0, 10);
    day.rawEvents = rawEvents[index];
    day.derivedRecords = derivedRecords[index];
    day.ruleFailures = ruleFailures[index];
    day.ruleEngineStatus = index < 5 ? "PARTIAL" : "SUCCEEDED";
  });
  reconcile(artifact);

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(report.metrics?.rawEvents, 396);
  assert.equal(report.metrics?.derivedRecords, 195);
  assert.equal(report.metrics?.ruleEngineSucceededDays, 2);
  assert.equal(report.metrics?.ruleFailures, 186);
  assert.equal(report.evidence?.candidateSha, "1f9d214c8639e301b6700813b48a3996de3970b3");
  assert.deepEqual(report.evidence?.week, { start: "2026-08-24", end: "2026-08-30" });
  assert.match(report.evidence?.artifactSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(report.blockers.includes("RULE_ENGINE_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_FAILURES"));
});

test("la conciliación independiente debe coincidir campo por campo", () => {
  const artifact = mutableConsistentArtifact();
  artifact.reconciliation.rawEvents += 1;
  artifact.reconciliation.derivedRecords += 2;

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(report.metrics?.reconciliationMismatches, 2);
  assert.ok(report.blockers.includes("RECONCILIATION_MISMATCH"));
});

test("duplicados, eventos fuera de roster y ambigüedades bloquean aun conciliados", () => {
  const artifact = mutableConsistentArtifact();
  artifact.days[0].duplicateCurrentEvents = 1;
  artifact.days[1].outsideRosterEvents = 2;
  artifact.days[2].ambiguousIdentityMatches = 3;
  reconcile(artifact);

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("DUPLICATE_CURRENT_EVENTS"));
  assert.ok(report.blockers.includes("OUTSIDE_ROSTER_EVENTS"));
  assert.ok(report.blockers.includes("AMBIGUOUS_IDENTITIES"));
  assert.equal(report.metrics?.duplicateCurrentEvents, 1);
  assert.equal(report.metrics?.outsideRosterEvents, 2);
  assert.equal(report.metrics?.ambiguousIdentityMatches, 3);
});

test("estados fuente sin resolver, fallos y faltas de horario bloquean", () => {
  const artifact = mutableConsistentArtifact();
  artifact.days[0].unresolvedSourceStatuses = 1;
  artifact.days[1].ruleFailures = 2;
  artifact.days[2].withoutSchedule = 3;
  reconcile(artifact);

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("UNRESOLVED_SOURCE_STATUSES"));
  assert.ok(report.blockers.includes("RULE_ENGINE_FAILURES"));
  assert.ok(report.blockers.includes("MISSING_SCHEDULES"));
});

test("el esquema cerrado rechaza PII y la salida nunca refleja el dato", () => {
  const artifact = structuredClone(consistentArtifact()) as unknown as Record<string, unknown>;
  const sensitiveEmail = "persona.sensible@example.test";
  const sensitiveUuid = "c87be2bb-70c0-4e74-9658-3dc83fbf7057";
  artifact.operatorEmail = sensitiveEmail;
  (artifact.days as Array<Record<string, unknown>>)[0].employeeId = sensitiveUuid;

  const report = evaluateReplayText(JSON.stringify(artifact));
  const output = serializeReplayReport(report);
  assert.deepEqual(report.blockers, ["PII_FIELD_PRESENT"]);
  assert.doesNotMatch(output, /persona\.sensible|example\.test|c87be2bb|employeeId/i);
});

test("JSON inválido y campos inesperados fallan con códigos estáticos", () => {
  assert.deepEqual(evaluateReplayText("{dato sensible"), {
    schemaVersion: 2,
    readOnly: true,
    source: "SANITIZED_AGGREGATES",
    outcome: "BLOCKED",
    evidence: null,
    metrics: null,
    checks: null,
    blockers: ["INVALID_JSON"],
  });

  const artifact = structuredClone(consistentArtifact()) as unknown as Record<string, unknown>;
  artifact.notes = "texto libre";
  assert.deepEqual(evaluateReplayText(JSON.stringify(artifact)).blockers, ["UNEXPECTED_FIELD"]);

  const abbreviatedCandidate = mutableConsistentArtifact();
  abbreviatedCandidate.candidateSha = "1f9d214";
  assert.deepEqual(evaluateReplayText(JSON.stringify(abbreviatedCandidate)).blockers, ["INVALID_VALUE"]);
});

test("el serializador reemplaza cualquier forma de salida ampliada o sensible", () => {
  const valid = buildReplayReport(consistentArtifact());
  const forged = {
    ...valid,
    operatorEmail: "filtracion@example.test",
  } as unknown as typeof valid;
  const output = serializeReplayReport(forged);

  assert.match(output, /OUTPUT_SANITIZATION_FAILED/);
  assert.doesNotMatch(output, /filtracion|example\.test|operatorEmail/);
});

test("el entrypoint devuelve códigos correctos y sólo JSON sanitizado", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arcotex-shadow-replay-test-"));
  const input = path.join(directory, "week.aggregate.json");
  const script = fileURLToPath(new URL("./arcotex-shadow-replay.mts", import.meta.url));
  const runtimeArguments = inheritedTypescriptRuntimeArguments();
  try {
    const inputText = JSON.stringify(consistentArtifact());
    await writeFile(input, inputText, { encoding: "utf8", flag: "wx" });
    const success = spawnSync(process.execPath, [...runtimeArguments, script, "--input", input], {
      cwd: path.dirname(script),
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    const output = JSON.parse(success.stdout);
    assert.equal(output.outcome, "CONSISTENT_OFFLINE_EVIDENCE");
    assert.equal(output.evidence.candidateSha, SYNTHETIC_CANDIDATE_SHA);
    assert.deepEqual(output.evidence.week, { start: "2024-01-01", end: "2024-01-07" });
    assert.equal(output.evidence.artifactSha256, replayArtifactSha256(consistentArtifact()));
    assert.equal(await readFile(input, "utf8"), inputText);
    assert.equal(success.stderr, "");

    const missing = spawnSync(
      process.execPath,
      [...runtimeArguments, script, "--input", path.join(directory, "missing.json")],
      { cwd: path.dirname(script), encoding: "utf8" },
    );
    assert.equal(missing.status, 1);
    assert.deepEqual(JSON.parse(missing.stdout).blockers, ["INPUT_UNREADABLE"]);
    assert.doesNotMatch(missing.stdout, /missing\.json|arcotex-shadow-replay-test/i);
    assert.equal(missing.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rechaza archivos sobredimensionados antes de parsearlos", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arcotex-shadow-replay-size-"));
  const input = path.join(directory, "oversized.json");
  try {
    await writeFile(input, "x".repeat(128 * 1024 + 1), { encoding: "utf8", flag: "wx" });
    assert.deepEqual((await evaluateReplayFile(input)).blockers, ["INPUT_TOO_LARGE"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rechaza enlaces simbólicos aunque apunten a un JSON válido", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arcotex-shadow-replay-link-"));
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "linked.json");
  try {
    await writeFile(target, JSON.stringify(consistentArtifact()), { encoding: "utf8", flag: "wx" });
    try {
      await symlink(target, link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        context.skip(`Windows no permite crear symlink en este host (${code})`);
        return;
      }
      throw error;
    }
    assert.deepEqual((await evaluateReplayFile(link)).blockers, ["INPUT_NOT_REGULAR_FILE"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("el reporte es determinista y no incorpora reloj, ruta ni orden de entrada", () => {
  const first = mutableConsistentArtifact();
  const second = mutableConsistentArtifact();
  second.days.reverse();
  assert.equal(canonicalReplayArtifactJson(first), canonicalReplayArtifactJson(second));
  assert.equal(replayArtifactSha256(first), replayArtifactSha256(second));
  assert.equal(
    replayArtifactSha256(first),
    "8845cef0e26dd5494698243a7cc4cfbfbddb031c44deb08884ca2b037fbbad8d",
  );
  assert.equal(
    serializeReplayReport(buildReplayReport(first)),
    serializeReplayReport(buildReplayReport(second)),
  );

  const reversedKeys = Object.fromEntries(Object.entries(consistentArtifact()).reverse());
  assert.equal(
    evaluateReplayText(JSON.stringify(reversedKeys, null, 4)).evidence?.artifactSha256,
    replayArtifactSha256(first),
  );

  second.candidateSha = "abcdef0123456789abcdef0123456789abcdef01";
  assert.notEqual(replayArtifactSha256(first), replayArtifactSha256(second));
  assert.notEqual(
    buildReplayReport(first).evidence?.artifactSha256,
    buildReplayReport(second).evidence?.artifactSha256,
  );

  const changedWeek = mutableConsistentArtifact();
  changedWeek.week.end = "2024-01-08";
  assert.notEqual(replayArtifactSha256(first), replayArtifactSha256(changedWeek));
});
