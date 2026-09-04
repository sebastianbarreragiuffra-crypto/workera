import "server-only";
import assert from "node:assert/strict";
import test from "node:test";
import { DryRunLedgerAdapter, type ExpenseAccountingExportJob } from "./adapter";
import { validAccountingPayload } from "./fixture";
import {
  classifyExpenseAccountingHealth,
  runExpenseAccountingCatchUp,
  type ExpenseAccountingCatchUpOptions,
} from "./orchestrator";
import { parseExpenseAccountingPayload } from "./payload";
import type {
  CompleteAccountingJobInput,
  CompleteAccountingRunInput,
  ExpenseAccountingCompletionStatus,
  ExpenseAccountingOperationsRepository,
  ExpenseAccountingRunLease,
  ExpenseAccountingWorkerHealthSnapshot,
} from "./repository";

const options: ExpenseAccountingCatchUpOptions = {
  batchSize: 2,
  maxBatches: 4,
  maxRuntimeMs: 45_000,
  jobTimeoutMs: 10_000,
  watchdogStaleSeconds: 93_600,
};

function job(sequence: number): ExpenseAccountingExportJob {
  return {
    exportId: `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    companyId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: sequence.toString(16).padStart(64, "0"),
    payload: parseExpenseAccountingPayload(validAccountingPayload),
    attemptCount: 1,
    leaseToken: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  };
}

function health(overrides: Partial<ExpenseAccountingWorkerHealthSnapshot> = {}): ExpenseAccountingWorkerHealthSnapshot {
  return {
    queuedCount: 0,
    retryCount: 0,
    processingCount: 0,
    failedCount: 0,
    staleProcessingCount: 0,
    oldestReadyAt: null,
    lastRunStatus: "SUCCEEDED",
    lastRunStartedAt: "2026-09-04T10:00:00.000Z",
    lastRunCompletedAt: "2026-09-04T10:00:01.000Z",
    lastSuccessCompletedAt: "2026-09-04T10:00:01.000Z",
    schedulerStale: false,
    ...overrides,
  };
}

class FakeOperationsRepository implements ExpenseAccountingOperationsRepository {
  claimCalls = 0;
  completedJobs: CompleteAccountingJobInput[] = [];
  completedRuns: CompleteAccountingRunInput[] = [];

  constructor(
    private readonly batches: ExpenseAccountingExportJob[][],
    private readonly snapshot = health(),
    private readonly runLease: ExpenseAccountingRunLease = {
      acquired: true,
      runId: "40000000-0000-4000-8000-000000000001",
      runToken: "40000000-0000-4000-8000-000000000002",
    },
    private readonly claimError: Error | null = null
  ) {}

  async claim(limit: number): Promise<ExpenseAccountingExportJob[]> {
    this.claimCalls += 1;
    if (this.claimError) throw this.claimError;
    const batch = this.batches[0];
    if (!batch) return [];
    const claimed = batch.splice(0, limit);
    if (batch.length === 0) this.batches.shift();
    return claimed;
  }

  async complete(input: CompleteAccountingJobInput): Promise<ExpenseAccountingCompletionStatus> {
    this.completedJobs.push(input);
    return input.succeeded ? "SUCCEEDED" : "FAILED";
  }

  async startRun(): Promise<ExpenseAccountingRunLease> {
    return this.runLease;
  }

  async completeRun(input: CompleteAccountingRunInput): Promise<void> {
    this.completedRuns.push(input);
  }

  async getHealth(): Promise<ExpenseAccountingWorkerHealthSnapshot> {
    return this.snapshot;
  }
}

test("catch-up drena varios lotes hasta encontrar uno parcial", async () => {
  const repository = new FakeOperationsRepository([
    [job(1), job(2)],
    [job(3), job(4)],
    [job(5)],
  ]);
  const result = await runExpenseAccountingCatchUp(repository, new DryRunLedgerAdapter(), "CRON", options);
  assert.equal(result.skipped, false);
  assert.equal(result.batches, 3);
  assert.deepEqual(result.summary, { claimed: 5, succeeded: 5, retried: 0, failed: 0 });
  assert.equal(repository.completedJobs.length, 5);
  assert.deepEqual(repository.completedRuns[0], {
    runId: "40000000-0000-4000-8000-000000000001",
    runToken: "40000000-0000-4000-8000-000000000002",
    succeeded: true,
    claimedCount: 5,
    succeededCount: 5,
    retriedCount: 0,
    failedCount: 0,
  });
});

test("una ejecución concurrente se omite sin reclamar ni recibir token", async () => {
  const repository = new FakeOperationsRepository(
    [[job(1)]],
    health({ processingCount: 1 }),
    { acquired: false, runId: null, runToken: null }
  );
  const result = await runExpenseAccountingCatchUp(repository, new DryRunLedgerAdapter(), "AFTER_RESPONSE", options);
  assert.equal(result.skipped, true);
  assert.equal(repository.claimCalls, 0);
  assert.equal(repository.completedRuns.length, 0);
  assert.equal(result.health.status, "DEGRADED");
});

test("maxBatches acota el catch-up aunque continúe el backlog", async () => {
  const repository = new FakeOperationsRepository(
    [[job(1), job(2)], [job(3), job(4)], [job(5), job(6)]],
    health({ queuedCount: 2 })
  );
  const result = await runExpenseAccountingCatchUp(
    repository,
    new DryRunLedgerAdapter(),
    "CRON",
    { ...options, maxBatches: 2 }
  );
  assert.equal(result.batches, 2);
  assert.equal(result.summary.claimed, 4);
  assert.equal(repository.claimCalls, 4);
  assert.equal(result.health.status, "DEGRADED");
});

test("un fallo del repositorio cierra el heartbeat con código estable", async () => {
  const repository = new FakeOperationsRepository([], health(), undefined, new Error("secreto de base"));
  await assert.rejects(
    runExpenseAccountingCatchUp(repository, new DryRunLedgerAdapter(), "CRON", options),
    /secreto de base/
  );
  assert.equal(repository.completedRuns.length, 1);
  assert.equal(repository.completedRuns[0].succeeded, false);
  assert.equal(repository.completedRuns[0].errorCode, "WORKER_EXECUTION_FAILED");
  assert.doesNotMatch(repository.completedRuns[0].errorCode ?? "", /secreto/);
});

test("clasificación del watchdog distingue sano, backlog y condición crítica", () => {
  assert.equal(classifyExpenseAccountingHealth(health()).status, "HEALTHY");
  assert.equal(classifyExpenseAccountingHealth(health({ queuedCount: 1 })).status, "DEGRADED");
  assert.equal(classifyExpenseAccountingHealth(health({ failedCount: 1 })).status, "CRITICAL");
  assert.equal(classifyExpenseAccountingHealth(health({ staleProcessingCount: 1 })).status, "CRITICAL");
  assert.equal(classifyExpenseAccountingHealth(health({ lastRunStatus: "FAILED" })).status, "CRITICAL");
  assert.equal(
    classifyExpenseAccountingHealth(health({ schedulerStale: true })).status,
    "CRITICAL",
    "un cron vencido es fallo de liveness aunque la cola esté vacía"
  );
  assert.equal(
    classifyExpenseAccountingHealth(health({ queuedCount: 1, schedulerStale: true })).status,
    "CRITICAL"
  );
});
