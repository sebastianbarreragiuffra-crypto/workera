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

export interface ExpenseAccountingRepository {
  claim(limit: number): Promise<ExpenseAccountingExportJob[]>;
  complete(input: CompleteAccountingJobInput): Promise<ExpenseAccountingCompletionStatus>;
}

export class SupabaseExpenseAccountingRepository implements ExpenseAccountingRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async claim(limit: number): Promise<ExpenseAccountingExportJob[]> {
    const { data, error } = await this.client.rpc("claim_expense_accounting_exports", { p_limit: limit });
    if (error) throw new Error("No se pudo reclamar la cola contable.");
    return (data ?? []).map((job) => ({
      exportId: job.export_id,
      companyId: job.company_id,
      idempotencyKey: job.idempotency_key,
      payload: parseExpenseAccountingPayload(job.payload as Json),
      attemptCount: job.attempt_count,
      leaseToken: job.lease_token,
    }));
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
    if (error) throw new Error("No se pudo cerrar el intento contable.");
    if (data !== "SUCCEEDED" && data !== "RETRY" && data !== "FAILED") {
      throw new Error("El cierre contable devolvió un estado inválido.");
    }
    return data;
  }
}
