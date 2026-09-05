import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { ExpenseFileScanError } from "./errors";
import type { ExpenseFileScanVerdict } from "./scanner";

const RECEIPT_BUCKET = "expense-receipts";

export interface ClaimedExpenseFileScan {
  captureId: string;
  companyId: string;
  storagePath: string;
  mimeType: string;
  checksumSha256: string;
  source: string;
  attempt: number;
}

export interface ExpenseFileScanRepository {
  reclaim(staleAfterSeconds: number): Promise<number>;
  claim(workerId: string, limit: number): Promise<ClaimedExpenseFileScan[]>;
  download(storagePath: string): Promise<ArrayBuffer>;
  complete(
    captureId: string,
    workerId: string,
    scanner: string,
    verdict: ExpenseFileScanVerdict,
  ): Promise<void>;
  fail(
    captureId: string,
    workerId: string,
    scanner: string,
    resultCode: string,
    retryable: boolean,
  ): Promise<boolean>;
}

function assertNoError(error: { message: string } | null, message: string): void {
  if (error) throw new ExpenseFileScanError("SCANNER_FAILURE", message, true);
}

export class SupabaseExpenseFileScanRepository implements ExpenseFileScanRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async reclaim(staleAfterSeconds: number): Promise<number> {
    const { data, error } = await this.supabase.rpc("reclaim_stale_expense_file_scans", {
      p_stale_after_seconds: staleAfterSeconds,
    });
    assertNoError(error, "No se pudieron recuperar leases de escaneo vencidas.");
    return Number(data ?? 0);
  }

  async claim(workerId: string, limit: number): Promise<ClaimedExpenseFileScan[]> {
    const { data, error } = await this.supabase.rpc("claim_expense_file_scans", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    assertNoError(error, "No se pudo reclamar la cola de escaneo.");
    return (data ?? []).map((job) => ({
      captureId: job.capture_id,
      companyId: job.company_id,
      storagePath: job.storage_path,
      mimeType: job.mime_type,
      checksumSha256: job.checksum_sha256,
      source: job.source,
      attempt: job.attempt,
    }));
  }

  async download(storagePath: string): Promise<ArrayBuffer> {
    const { data, error } = await this.supabase.storage.from(RECEIPT_BUCKET).download(storagePath);
    if (error || !data) {
      throw new ExpenseFileScanError(
        "STORAGE_DOWNLOAD",
        "No se pudo leer el archivo en cuarentena.",
        true,
      );
    }
    return data.arrayBuffer();
  }

  async complete(
    captureId: string,
    workerId: string,
    scanner: string,
    verdict: ExpenseFileScanVerdict,
  ): Promise<void> {
    const { error } = await this.supabase.rpc("complete_expense_file_scan", {
      p_capture_id: captureId,
      p_worker_id: workerId,
      p_verdict: verdict.verdict,
      p_scanner: scanner,
      p_result_code: verdict.resultCode,
    });
    assertNoError(error, "No se pudo guardar el veredicto de seguridad.");
  }

  async fail(
    captureId: string,
    workerId: string,
    scanner: string,
    resultCode: string,
    retryable: boolean,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("fail_expense_file_scan", {
      p_capture_id: captureId,
      p_worker_id: workerId,
      p_scanner: scanner,
      p_result_code: resultCode,
      p_retryable: retryable,
      p_retry_delay_seconds: 30,
    });
    assertNoError(error, "No se pudo cerrar el escaneo fallido.");
    return Boolean(data);
  }
}
