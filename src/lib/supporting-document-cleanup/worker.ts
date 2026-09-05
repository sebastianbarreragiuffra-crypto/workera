import "server-only";
import { randomUUID } from "node:crypto";
import {
  SupportingDocumentCleanupError,
  type SupportingDocumentCleanupRepository,
} from "./repository";

export interface SupportingDocumentCleanupSummary {
  reclaimed: number;
  claimed: number;
  cleaned: number;
  failed: number;
  retried: number;
}

export async function runSupportingDocumentCleanupWorker(
  repository: SupportingDocumentCleanupRepository,
  options: {
    workerId?: string;
    limit?: number;
    graceSeconds?: number;
    staleAfterSeconds?: number;
  } = {},
): Promise<SupportingDocumentCleanupSummary> {
  const workerId = options.workerId ?? randomUUID();
  const reclaimed = await repository.reclaim(options.staleAfterSeconds ?? 300);
  const jobs = await repository.claim(
    workerId,
    options.limit ?? 20,
    options.graceSeconds ?? 300,
  );
  const summary: SupportingDocumentCleanupSummary = {
    reclaimed,
    claimed: jobs.length,
    cleaned: 0,
    failed: 0,
    retried: 0,
  };

  for (const job of jobs) {
    try {
      await repository.remove(job.storagePath);
      await repository.complete(job.intentId, workerId);
      summary.cleaned += 1;
    } catch (cause) {
      const safeFailure = cause instanceof SupportingDocumentCleanupError
        ? cause
        : { code: "CLEANUP_FAILURE", retryable: true } as const;
      const retried = await repository.fail(
        job.intentId,
        workerId,
        safeFailure.code,
        safeFailure.retryable,
      );
      summary.failed += 1;
      if (retried) summary.retried += 1;
    }
  }
  return summary;
}
