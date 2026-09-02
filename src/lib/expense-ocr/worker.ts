import "server-only";
import { randomUUID } from "node:crypto";
import type { Json } from "@/lib/supabase/database.types";
import type { AzureAnalysisState } from "./azure-document-intelligence";
import { safeOcrError } from "./errors";
import { normalizeAzureReceipt } from "./normalize";
import type { ClaimedExpenseOcrJob, ExpenseOcrRepository } from "./repository";

export interface ExpenseOcrProvider {
  startReceiptAnalysis(bytes: ArrayBuffer, mimeType: string): Promise<AzureAnalysisState>;
  pollReceiptAnalysis(operationUrl: string): Promise<AzureAnalysisState>;
}

export interface ExpenseOcrWorkerSummary {
  reclaimed: number;
  claimed: number;
  completed: number;
  deferred: number;
  failed: number;
  retried: number;
}

export async function runExpenseOcrWorker(
  repository: ExpenseOcrRepository,
  provider: ExpenseOcrProvider,
  options: { workerId?: string; limit?: number; staleAfterSeconds?: number; pollDelaySeconds?: number } = {}
): Promise<ExpenseOcrWorkerSummary> {
  const workerId = options.workerId ?? randomUUID();
  const reclaimed = await repository.reclaim(options.staleAfterSeconds ?? 300);
  const jobs = await repository.claim(workerId, options.limit ?? 3);
  const summary: ExpenseOcrWorkerSummary = { reclaimed, claimed: jobs.length, completed: 0, deferred: 0, failed: 0, retried: 0 };

  for (const job of jobs) {
    try {
      const state = await analyzeJob(repository, provider, job);
      if (state.state === "pending") {
        await repository.defer(job.jobId, workerId, state.operationUrl, options.pollDelaySeconds ?? 5);
        summary.deferred += 1;
      } else {
        const extraction = normalizeAzureReceipt(state.result, {
          expenseDate: job.expenseDate,
          merchantName: job.merchantName,
          netAmount: job.netAmount,
          taxAmount: job.taxAmount,
          totalAmount: job.totalAmount,
          currencyCode: job.currencyCode,
        });
        await repository.complete(job.jobId, workerId, extraction as unknown as Json);
        summary.completed += 1;
      }
    } catch (cause) {
      const error = safeOcrError(cause);
      const retried = await repository.fail(job.jobId, workerId, error.category, error.message, error.retryable);
      summary.failed += 1;
      if (retried) summary.retried += 1;
    }
  }
  return summary;
}

async function analyzeJob(
  repository: ExpenseOcrRepository,
  provider: ExpenseOcrProvider,
  job: ClaimedExpenseOcrJob
): Promise<AzureAnalysisState> {
  if (job.providerOperationUrl) return provider.pollReceiptAnalysis(job.providerOperationUrl);
  const bytes = await repository.downloadPrivateReceipt(job.storagePath);
  return provider.startReceiptAnalysis(bytes, job.mimeType);
}
