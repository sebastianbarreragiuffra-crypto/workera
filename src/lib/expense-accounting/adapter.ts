import "server-only";
import type { ExpenseAccountingPayload } from "./payload";

export interface ExpenseAccountingExportJob {
  exportId: string;
  companyId: string;
  idempotencyKey: string;
  payload: ExpenseAccountingPayload;
  attemptCount: number;
  leaseToken: string;
}

export interface ExpenseAccountingAdapterResult {
  externalReference: string;
}

export interface ExpenseAccountingAdapter {
  readonly providerCode: "LEDGER_CSV_V1";
  export(job: ExpenseAccountingExportJob): Promise<ExpenseAccountingAdapterResult>;
}

export class ExpenseAccountingProviderError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super("El proveedor contable no pudo procesar la salida.");
    this.name = "ExpenseAccountingProviderError";
  }
}

/**
 * Adapter seguro de marcha blanca: valida el contrato y ensaya idempotencia,
 * pero nunca llama una API ni crea un asiento real.
 */
export class DryRunLedgerAdapter implements ExpenseAccountingAdapter {
  readonly providerCode = "LEDGER_CSV_V1" as const;

  async export(job: ExpenseAccountingExportJob): Promise<ExpenseAccountingAdapterResult> {
    if (job.payload.provider !== this.providerCode) {
      throw new ExpenseAccountingProviderError("PROVIDER_MISMATCH", false);
    }
    return { externalReference: `DRYRUN-${job.idempotencyKey.slice(0, 16).toUpperCase()}` };
  }
}
