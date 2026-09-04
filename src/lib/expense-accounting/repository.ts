import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { parseExpenseAccountingPayload } from "./payload";
import type { ExpenseAccountingExportJob } from "./adapter";

export interface CompleteAccountingJobInput {
  exportId: string;
  leaseToken: string;
  succeeded: boolean;
  externalReference?: string;
  errorCode?: string;
  errorSummary?: string;
  retryable?: boolean;
}

export type ExpenseAccountingCompletionStatus = "SUCCEEDED" | "RETRY" | "FAILED";
export type ExpenseAccountingRunTrigger = "CRON" | "AFTER_RESPONSE" | "MANUAL";
export type ExpenseAccountingRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type ExpenseAccountingRepositoryErrorCode =
  | "QUEUE_CLAIM_FAILED"
  | "CLAIM_PAYLOAD_INVALID"
  | "JOB_COMPLETION_FAILED"
  | "JOB_COMPLETION_INVALID"
  | "RUN_START_FAILED"
  | "RUN_COMPLETION_FAILED"
  | "HEALTH_READ_FAILED";

export class ExpenseAccountingRepositoryError extends Error {
  constructor(readonly code: ExpenseAccountingRepositoryErrorCode) {
    super("La operación contable no pudo completarse.");
    this.name = "ExpenseAccountingRepositoryError";
  }
}

export function expenseAccountingOperationalErrorCode(error: unknown): string {
  return error instanceof ExpenseAccountingRepositoryError
    ? error.code
    : "WORKER_EXECUTION_FAILED";
}

export interface ExpenseAccountingRunLease {
  runId: string | null;
  runToken: string | null;
  acquired: boolean;
}

export interface ExpenseAccountingWorkerHealthSnapshot {
  queuedCount: number;
  retryCount: number;
  processingCount: number;
  failedCount: number;
  staleProcessingCount: number;
  oldestReadyAt: string | null;
  lastRunStatus: ExpenseAccountingRunStatus | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastSuccessCompletedAt: string | null;
  schedulerStale: boolean;
}

export interface CompleteAccountingRunInput {
  runId: string;
  runToken: string;
  succeeded: boolean;
  claimedCount: number;
  succeededCount: number;
  retriedCount: number;
  failedCount: number;
  errorCode?: string;
}

export interface ExpenseAccountingRepository {
  claim(limit: number): Promise<ExpenseAccountingExportJob[]>;
  complete(input: CompleteAccountingJobInput): Promise<ExpenseAccountingCompletionStatus>;
}

export interface ExpenseAccountingOperationsRepository extends ExpenseAccountingRepository {
  startRun(trigger: ExpenseAccountingRunTrigger): Promise<ExpenseAccountingRunLease>;
  completeRun(input: CompleteAccountingRunInput): Promise<void>;
  getHealth(staleAfterSeconds: number): Promise<ExpenseAccountingWorkerHealthSnapshot>;
}

export class SupabaseExpenseAccountingRepository implements ExpenseAccountingRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async claim(limit: number): Promise<ExpenseAccountingExportJob[]> {
    const { data, error } = await this.client.rpc("claim_expense_accounting_exports", { p_limit: limit });
    if (error) throw new ExpenseAccountingRepositoryError("QUEUE_CLAIM_FAILED");
    try {
      return (data ?? []).map((job) => ({
        exportId: job.export_id,
        companyId: job.company_id,
        idempotencyKey: job.idempotency_key,
        payload: parseExpenseAccountingPayload(job.payload as Json),
        attemptCount: job.attempt_count,
        leaseToken: job.lease_token,
      }));
    } catch {
      throw new ExpenseAccountingRepositoryError("CLAIM_PAYLOAD_INVALID");
    }
  }

  async complete(input: CompleteAccountingJobInput): Promise<ExpenseAccountingCompletionStatus> {
    const { data, error } = await this.client.rpc("complete_expense_accounting_export", {
      p_export_id: input.exportId,
      p_lease_token: input.leaseToken,
      p_succeeded: input.succeeded,
      p_external_reference: input.externalReference,
      p_error_code: input.errorCode,
      p_error_summary: input.errorSummary,
      p_retryable: input.retryable ?? false,
    });
    if (error) throw new ExpenseAccountingRepositoryError("JOB_COMPLETION_FAILED");
    if (data !== "SUCCEEDED" && data !== "RETRY" && data !== "FAILED") {
      throw new ExpenseAccountingRepositoryError("JOB_COMPLETION_INVALID");
    }
    return data;
  }

  async startRun(trigger: ExpenseAccountingRunTrigger): Promise<ExpenseAccountingRunLease> {
    const { data, error } = await this.client.rpc("start_expense_accounting_worker_run", {
      p_trigger_source: trigger,
    });
    if (error || !data || data.length !== 1) {
      throw new ExpenseAccountingRepositoryError("RUN_START_FAILED");
    }
    return {
      runId: data[0].run_id,
      runToken: data[0].run_token,
      acquired: data[0].acquired,
    };
  }

  async completeRun(input: CompleteAccountingRunInput): Promise<void> {
    const { error } = await this.client.rpc("complete_expense_accounting_worker_run", {
      p_run_id: input.runId,
      p_run_token: input.runToken,
      p_succeeded: input.succeeded,
      p_claimed_count: input.claimedCount,
      p_succeeded_count: input.succeededCount,
      p_retried_count: input.retriedCount,
      p_failed_count: input.failedCount,
      p_error_code: input.errorCode,
    });
    if (error) throw new ExpenseAccountingRepositoryError("RUN_COMPLETION_FAILED");
  }

  async getHealth(staleAfterSeconds: number): Promise<ExpenseAccountingWorkerHealthSnapshot> {
    const { data, error } = await this.client.rpc("get_expense_accounting_worker_health", {
      p_stale_after_seconds: staleAfterSeconds,
    });
    if (error || !data || data.length !== 1) {
      throw new ExpenseAccountingRepositoryError("HEALTH_READ_FAILED");
    }
    const health = data[0];
    return {
      queuedCount: Number(health.queued_count),
      retryCount: Number(health.retry_count),
      processingCount: Number(health.processing_count),
      failedCount: Number(health.failed_count),
      staleProcessingCount: Number(health.stale_processing_count),
      oldestReadyAt: health.oldest_ready_at,
      lastRunStatus: health.last_run_status,
      lastRunStartedAt: health.last_run_started_at,
      lastRunCompletedAt: health.last_run_completed_at,
      lastSuccessCompletedAt: health.last_success_completed_at,
      schedulerStale: health.scheduler_stale,
    };
  }
}
