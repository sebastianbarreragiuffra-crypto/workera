import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json, Database } from "@/lib/supabase/database.types";
import { ExpenseOcrError } from "./errors";

export interface ClaimedExpenseOcrJob {
  jobId: string;
  companyId: string;
  receiptId: string;
  storagePath: string;
  mimeType: string;
  attempt: number;
  providerOperationUrl: string | null;
  expenseDate: string;
  merchantName: string | null;
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
  currencyCode: string;
}

export interface ExpenseOcrRepository {
  reclaim(staleAfterSeconds: number): Promise<number>;
  claim(workerId: string, limit: number): Promise<ClaimedExpenseOcrJob[]>;
  downloadPrivateReceipt(storagePath: string): Promise<ArrayBuffer>;
  defer(jobId: string, workerId: string, operationUrl: string, delaySeconds: number): Promise<void>;
  complete(jobId: string, workerId: string, extraction: Json): Promise<void>;
  fail(jobId: string, workerId: string, category: string, summary: string, retryable: boolean): Promise<boolean>;
}

function assertNoError(error: { message: string } | null, safeMessage: string): void {
  if (error) throw new ExpenseOcrError("UNEXPECTED", safeMessage, false);
}

export class SupabaseExpenseOcrRepository implements ExpenseOcrRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async reclaim(staleAfterSeconds: number): Promise<number> {
    const { data, error } = await this.supabase.rpc("reclaim_stale_expense_ocr_jobs", {
      p_stale_after_seconds: staleAfterSeconds,
    });
    assertNoError(error, "No se pudieron recuperar leases OCR vencidos.");
    return Number(data ?? 0);
  }

  async claim(workerId: string, limit: number): Promise<ClaimedExpenseOcrJob[]> {
    const { data, error } = await this.supabase.rpc("claim_expense_ocr_jobs", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    assertNoError(error, "No se pudo reclamar la cola OCR.");
    return (data ?? []).map((job) => ({
      jobId: job.job_id,
      companyId: job.company_id,
      receiptId: job.receipt_id,
      storagePath: job.storage_path,
      mimeType: job.mime_type,
      attempt: job.attempt,
      providerOperationUrl: job.provider_operation_url,
      expenseDate: job.expense_date,
      merchantName: job.merchant_name,
      netAmount: Number(job.net_amount),
      taxAmount: Number(job.tax_amount),
      totalAmount: Number(job.total_amount),
      currencyCode: job.currency_code,
    }));
  }

  async downloadPrivateReceipt(storagePath: string): Promise<ArrayBuffer> {
    const { data, error } = await this.supabase.storage.from("expense-receipts").download(storagePath);
    if (error || !data) throw new ExpenseOcrError("STORAGE_DOWNLOAD", "No se pudo descargar el comprobante privado.", true);
    return data.arrayBuffer();
  }

  async defer(jobId: string, workerId: string, operationUrl: string, delaySeconds: number): Promise<void> {
    const { error } = await this.supabase.rpc("defer_expense_ocr_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_provider_operation_url: operationUrl,
      p_delay_seconds: delaySeconds,
    });
    assertNoError(error, "No se pudo diferir el trabajo OCR.");
  }

  async complete(jobId: string, workerId: string, extraction: Json): Promise<void> {
    const { error } = await this.supabase.rpc("complete_expense_ocr_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_extraction: extraction,
    });
    assertNoError(error, "No se pudo completar el trabajo OCR.");
  }

  async fail(jobId: string, workerId: string, category: string, summary: string, retryable: boolean): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("fail_expense_ocr_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_error_category: category,
      p_error_summary: summary,
      p_retryable: retryable,
      p_retry_delay_seconds: 30,
    });
    assertNoError(error, "No se pudo cerrar el trabajo OCR fallido.");
    return Boolean(data);
  }
}
