import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReplayReport,
  evaluateReplayFile,
  evaluateReplayText,
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

function readyArtifact(): SanitizedReplayArtifact {
  const rawEvents = [60, 62, 61, 59, 58, 0, 0];
  const derivedRecords = [45, 45, 45, 45, 45, 0, 0];
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date("2097-02-04T00:00:00Z");
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
    schemaVersion: "ARCOTEX_SHADOW_REPLAY_V1",
    scope: "ARCOTEX",
    mode: "OFFLINE_SANITIZED_AGGREGATES",
    workeraSyncEnabled: false,
    week: { start: "2097-02-04", end: "2097-02-10" },
    roster: {
      expectedEmployees: 45,
      observedEmployees: 45,
      expectedScopeSha256: "a".repeat(64),
      observedScopeSha256: "a".repeat(64),
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

function mutableReadyArtifact(): Mutable<SanitizedReplayArtifact> {
  return structuredClone(readyArtifact()) as Mutable<SanitizedReplayArtifact>;
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

test("aprueba únicamente un replay agregado 45/45 y 7/7 completamente conciliado", () => {
  const report = buildReplayReport(readyArtifact());

  assert.equal(report.outcome, "READY_FOR_SHADOW_REVIEW");
  assert.deepEqual(report.blockers, []);
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
});

test("falla cerrado si el padrón no es 45/45 o su atestación no coincide", () => {
  const artifact = mutableReadyArtifact();
  artifact.roster.observedEmployees = 44;
  artifact.roster.observedScopeSha256 = "b".repeat(64);
  artifact.days[0].employeesProcessed = 44;
  reconcile(artifact);

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("ROSTER_NOT_45_OF_45"));
  assert.ok(report.blockers.includes("ROSTER_ATTESTATION_MISMATCH"));
  assert.ok(report.blockers.includes("EMPLOYEE_SCOPE_INCOMPLETE"));
});

test("rechaza una semana incompleta, con fecha duplicada o fuera de lunes a domingo", () => {
  const incomplete = mutableReadyArtifact();
  incomplete.days.pop();
  reconcile(incomplete);
  assert.ok(buildReplayReport(incomplete).blockers.includes("WEEK_NOT_7_OF_7"));

  const duplicate = mutableReadyArtifact();
  duplicate.days[6].date = duplicate.days[5].date;
  assert.ok(buildReplayReport(duplicate).blockers.includes("WEEK_NOT_7_OF_7"));

  const wrongBoundary = mutableReadyArtifact();
  wrongBoundary.week.start = "2097-02-05";
  wrongBoundary.week.end = "2097-02-11";
  assert.ok(buildReplayReport(wrongBoundary).blockers.includes("WEEK_NOT_7_OF_7"));
});

test("sync habilitado y estados parciales, fallidos u obsoletos nunca producen READY", () => {
  const artifact = mutableReadyArtifact();
  artifact.workeraSyncEnabled = true;
  artifact.days[0].syncStatus = "PARTIAL";
  artifact.days[1].ruleEngineStatus = "FAILED";
  artifact.days[2].inputFresh = false;

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.ok(report.blockers.includes("SYNC_NOT_DISABLED"));
  assert.ok(report.blockers.includes("SYNC_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_INPUT_NOT_FRESH"));
});

test("la foto agregada ya documentada permanece BLOCKED sin reejecutar el motor", () => {
  const artifact = mutableReadyArtifact();
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
  assert.ok(report.blockers.includes("RULE_ENGINE_STATUS_NOT_SUCCEEDED"));
  assert.ok(report.blockers.includes("RULE_ENGINE_FAILURES"));
});

test("la conciliación independiente debe coincidir campo por campo", () => {
  const artifact = mutableReadyArtifact();
  artifact.reconciliation.rawEvents += 1;
  artifact.reconciliation.derivedRecords += 2;

  const report = buildReplayReport(artifact);
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(report.metrics?.reconciliationMismatches, 2);
  assert.ok(report.blockers.includes("RECONCILIATION_MISMATCH"));
});

test("duplicados, eventos fuera de roster y ambigüedades bloquean aun conciliados", () => {
  const artifact = mutableReadyArtifact();
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
  const artifact = mutableReadyArtifact();
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
  const artifact = structuredClone(readyArtifact()) as unknown as Record<string, unknown>;
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
    schemaVersion: 1,
    readOnly: true,
    source: "SANITIZED_AGGREGATES",
    outcome: "BLOCKED",
    metrics: null,
    checks: null,
    blockers: ["INVALID_JSON"],
  });

  const artifact = structuredClone(readyArtifact()) as unknown as Record<string, unknown>;
  artifact.notes = "texto libre";
  assert.deepEqual(evaluateReplayText(JSON.stringify(artifact)).blockers, ["UNEXPECTED_FIELD"]);
});

test("el serializador reemplaza cualquier forma de salida ampliada o sensible", () => {
  const valid = buildReplayReport(readyArtifact());
  const forged = {
    ...valid,
    operatorEmail: "filtracion@example.test",
  } as unknown as typeof valid;
  const output = serializeReplayReport(forged);

  assert.match(output, /OUTPUT_SANITIZATION_FAILED/);
  assert.doesNotMatch(output, /filtracion|example\.test|operatorEmail/);
});

test("el comando sólo importa lectura local y no contiene fronteras de red, DB o escritura", () => {
  const source = readFileSync(new URL("./arcotex-shadow-replay.mts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:@\/|\.\.\/src\/)/);
  assert.doesNotMatch(source, /node:(?:http|https|net|tls)|\bfetch\s*\(/);
  assert.doesNotMatch(source, /create(?:Admin)?Client|supabase\.|from\(["'][a-z_]+["']\)/i);
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|createWriteStream|unlink|rename|rm)\s*\(/);
});

test("el entrypoint devuelve códigos correctos y sólo JSON sanitizado", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arcotex-shadow-replay-test-"));
  const input = path.join(directory, "week.aggregate.json");
  const script = fileURLToPath(new URL("./arcotex-shadow-replay.mts", import.meta.url));
  const runtimeArguments = inheritedTypescriptRuntimeArguments();
  try {
    await writeFile(input, JSON.stringify(readyArtifact()), { encoding: "utf8", flag: "wx" });
    const success = spawnSync(process.execPath, [...runtimeArguments, script, "--input", input], {
      cwd: path.dirname(script),
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).outcome, "READY_FOR_SHADOW_REVIEW");
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
    await writeFile(target, JSON.stringify(readyArtifact()), { encoding: "utf8", flag: "wx" });
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
  const first = mutableReadyArtifact();
  const second = mutableReadyArtifact();
  second.days.reverse();
  assert.equal(
    serializeReplayReport(buildReplayReport(first)),
    serializeReplayReport(buildReplayReport(second)),
  );
});
