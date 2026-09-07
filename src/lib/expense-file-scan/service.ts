import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { CloudmersiveAdvancedScanner } from "./cloudmersive";
import { readExpenseFileScanConfig } from "./config";
import { SupabaseExpenseFileScanRepository, type ExpenseFileScanRepository } from "./repository";
import { FixtureExpenseFileScanner, type ExpenseFileScanner } from "./scanner";
import { runExpenseFileScanWorker, type ExpenseFileScanWorkerSummary } from "./worker";

const EMPTY_SUMMARY: ExpenseFileScanWorkerSummary = {
  reclaimed: 0,
  claimed: 0,
  clean: 0,
  rejected: 0,
  failed: 0,
  retried: 0,
};

type WorkerRunner = typeof runExpenseFileScanWorker;

function addSummary(
  total: ExpenseFileScanWorkerSummary,
  current: ExpenseFileScanWorkerSummary,
): ExpenseFileScanWorkerSummary {
  return {
    reclaimed: total.reclaimed + current.reclaimed,
    claimed: total.claimed + current.claimed,
    clean: total.clean + current.clean,
    rejected: total.rejected + current.rejected,
    failed: total.failed + current.failed,
    retried: total.retried + current.retried,
  };
}

/**
 * Reclama de a uno para no dejar leases varadas ante una caída global, pero
 * sigue drenando archivos sanos dentro del presupuesto de una sola Function.
 */
export async function runExpenseFileScanSequentialBatch(
  repository: ExpenseFileScanRepository,
  scanner: ExpenseFileScanner,
  options: {
    maxFiles: number;
    maxRuntimeMs: number;
    requestTimeoutMs: number;
    now?: () => number;
  },
  runWorker: WorkerRunner = runExpenseFileScanWorker,
): Promise<ExpenseFileScanWorkerSummary> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.maxRuntimeMs;
  let total = { ...EMPTY_SUMMARY };
  while (
    total.claimed < options.maxFiles
    && deadline - now() >= options.requestTimeoutMs + 1_000
  ) {
    const current = await runWorker(repository, scanner, { limit: 1 });
    total = addSummary(total, current);
    if (current.claimed === 0 || current.failed > 0) break;
  }
  return total;
}

export async function runExpenseFileScanWorkerWithServiceRole(): Promise<ExpenseFileScanWorkerSummary> {
  const config = readExpenseFileScanConfig();
  if (!config.enabled) return EMPTY_SUMMARY;

  const repository = new SupabaseExpenseFileScanRepository(
    createAdminClient("expense-file-scan-worker"),
  );
  const scanner = config.provider === "fixture"
    ? new FixtureExpenseFileScanner()
    : new CloudmersiveAdvancedScanner(config);
  if (config.provider === "fixture") {
    return runExpenseFileScanWorker(repository, scanner, { limit: 3 });
  }
  return runExpenseFileScanSequentialBatch(repository, scanner, {
    maxFiles: config.maxFilesPerRun,
    maxRuntimeMs: config.maxRuntimeMs,
    requestTimeoutMs: config.timeoutMs,
  });
}
