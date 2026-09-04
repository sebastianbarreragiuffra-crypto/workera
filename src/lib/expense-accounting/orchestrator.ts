import "server-only";
import type { ExpenseAccountingAdapter } from "./adapter";
import type {
  ExpenseAccountingOperationsRepository,
  ExpenseAccountingRunTrigger,
  ExpenseAccountingWorkerHealthSnapshot,
} from "./repository";
import { expenseAccountingOperationalErrorCode } from "./repository";
import { runExpenseAccountingWorker, type ExpenseAccountingWorkerSummary } from "./worker";

export type ExpenseAccountingHealthStatus = "HEALTHY" | "DEGRADED" | "CRITICAL";

export interface ExpenseAccountingOperationsHealth extends ExpenseAccountingWorkerHealthSnapshot {
  status: ExpenseAccountingHealthStatus;
}

export interface ExpenseAccountingCatchUpOptions {
  batchSize: number;
  maxBatches: number;
  maxRuntimeMs: number;
  jobTimeoutMs: number;
  watchdogStaleSeconds: number;
}

export interface ExpenseAccountingCatchUpResult {
  skipped: boolean;
  runId: string | null;
  batches: number;
  summary: ExpenseAccountingWorkerSummary;
  health: ExpenseAccountingOperationsHealth;
}

const emptySummary = (): ExpenseAccountingWorkerSummary => ({
  claimed: 0,
  succeeded: 0,
  retried: 0,
  failed: 0,
});

function addSummary(target: ExpenseAccountingWorkerSummary, batch: ExpenseAccountingWorkerSummary): void {
  target.claimed += batch.claimed;
  target.succeeded += batch.succeeded;
  target.retried += batch.retried;
  target.failed += batch.failed;
}

export function classifyExpenseAccountingHealth(
  snapshot: ExpenseAccountingWorkerHealthSnapshot
): ExpenseAccountingOperationsHealth {
  const readyCount = snapshot.queuedCount + snapshot.retryCount;
  const status: ExpenseAccountingHealthStatus =
    snapshot.failedCount > 0
    || snapshot.staleProcessingCount > 0
    || snapshot.lastRunStatus === "FAILED"
    || snapshot.schedulerStale
      ? "CRITICAL"
      : readyCount > 0 || snapshot.processingCount > 0
        ? "DEGRADED"
        : "HEALTHY";
  return { ...snapshot, status };
}

export async function runExpenseAccountingCatchUp(
  repository: ExpenseAccountingOperationsRepository,
  adapter: ExpenseAccountingAdapter,
  trigger: ExpenseAccountingRunTrigger,
  options: ExpenseAccountingCatchUpOptions
): Promise<ExpenseAccountingCatchUpResult> {
  const lease = await repository.startRun(trigger);
  if (!lease.acquired || !lease.runId || !lease.runToken) {
    return {
      skipped: true,
      runId: null,
      batches: 0,
      summary: emptySummary(),
      health: classifyExpenseAccountingHealth(await repository.getHealth(options.watchdogStaleSeconds)),
    };
  }

  const startedAt = Date.now();
  const deadlineAtMs = startedAt + options.maxRuntimeMs;
  const summary = emptySummary();
  let batches = 0;
  try {
    while (
      batches < options.maxBatches
      && deadlineAtMs - Date.now() >= options.jobTimeoutMs + 1_000
    ) {
      const batch = await runExpenseAccountingWorker(repository, adapter, options.batchSize, {
        deadlineAtMs,
        jobTimeoutMs: options.jobTimeoutMs,
      });
      batches += 1;
      addSummary(summary, batch);
      if (batch.claimed < options.batchSize) break;
    }

    await repository.completeRun({
      runId: lease.runId,
      runToken: lease.runToken,
      succeeded: true,
      claimedCount: summary.claimed,
      succeededCount: summary.succeeded,
      retriedCount: summary.retried,
      failedCount: summary.failed,
    });
    return {
      skipped: false,
      runId: lease.runId,
      batches,
      summary,
      health: classifyExpenseAccountingHealth(await repository.getHealth(options.watchdogStaleSeconds)),
    };
  } catch (error) {
    try {
      await repository.completeRun({
        runId: lease.runId,
        runToken: lease.runToken,
        succeeded: false,
        claimedCount: summary.claimed,
        succeededCount: summary.succeeded,
        retriedCount: summary.retried,
        failedCount: summary.failed,
        errorCode: expenseAccountingOperationalErrorCode(error),
      });
    } catch {
      console.error("[expense-accounting] no se pudo persistir el fallo del run");
    }
    throw error;
  }
}
