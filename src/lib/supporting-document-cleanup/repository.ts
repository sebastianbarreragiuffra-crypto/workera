import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const SUPPORTING_DOCUMENT_BUCKET = "supporting-documents";

export interface ClaimedSupportingDocumentCleanup {
  intentId: string;
  storagePath: string;
  attempt: number;
}

export interface SupportingDocumentCleanupRepository {
  reclaim(staleAfterSeconds: number): Promise<number>;
  claim(
    workerId: string,
    limit: number,
    graceSeconds: number,
  ): Promise<ClaimedSupportingDocumentCleanup[]>;
  remove(storagePath: string): Promise<void>;
  complete(intentId: string, workerId: string): Promise<void>;
  fail(intentId: string, workerId: string, errorCode: string, retryable: boolean): Promise<boolean>;
}

export class SupportingDocumentCleanupError extends Error {
  readonly code = "STORAGE_REMOVE_FAILED";
  readonly retryable = true;

  constructor() {
    super("No se pudo eliminar el objeto laboral huerfano.");
    this.name = "SupportingDocumentCleanupError";
  }
}

function assertRpc(error: { message: string } | null, message: string): void {
  if (error) throw new Error(message);
}

export class SupabaseSupportingDocumentCleanupRepository
implements SupportingDocumentCleanupRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async reclaim(staleAfterSeconds: number): Promise<number> {
    const { data, error } = await this.supabase.rpc(
      "reclaim_stale_supporting_document_cleanups",
      { p_stale_after_seconds: staleAfterSeconds },
    );
    assertRpc(error, "No se pudieron recuperar leases de limpieza vencidas.");
    return Number(data ?? 0);
  }

  async claim(
    workerId: string,
    limit: number,
    graceSeconds: number,
  ): Promise<ClaimedSupportingDocumentCleanup[]> {
    const { data, error } = await this.supabase.rpc(
      "claim_expired_supporting_document_uploads",
      {
        p_worker_id: workerId,
        p_limit: limit,
        p_grace_seconds: graceSeconds,
      },
    );
    assertRpc(error, "No se pudo reclamar la cola de limpieza laboral.");
    return (data ?? []).map((item) => ({
      intentId: item.intent_id,
      storagePath: item.storage_path,
      attempt: item.attempt,
    }));
  }

  async remove(storagePath: string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(SUPPORTING_DOCUMENT_BUCKET)
      .remove([storagePath]);
    if (error) throw new SupportingDocumentCleanupError();
  }

  async complete(intentId: string, workerId: string): Promise<void> {
    const { error } = await this.supabase.rpc(
      "complete_supporting_document_orphan_cleanup",
      {
        p_intent_id: intentId,
        p_worker_id: workerId,
        p_result: "REMOVED_OR_ABSENT",
      },
    );
    assertRpc(error, "No se pudo cerrar la limpieza laboral.");
  }

  async fail(
    intentId: string,
    workerId: string,
    errorCode: string,
    retryable: boolean,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc(
      "fail_supporting_document_orphan_cleanup",
      {
        p_intent_id: intentId,
        p_worker_id: workerId,
        p_error_code: errorCode,
        p_retryable: retryable,
        p_retry_delay_seconds: 30,
      },
    );
    assertRpc(error, "No se pudo registrar el fallo de limpieza laboral.");
    return Boolean(data);
  }
}
