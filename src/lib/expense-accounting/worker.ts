import "server-only";
import { ExpenseAccountingProviderError, type ExpenseAccountingAdapter } from "./adapter";
import type { ExpenseAccountingRepository } from "./repository";

export interface ExpenseAccountingWorkerSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export async function runExpenseAccountingWorker(
  repository: ExpenseAccountingRepository,
  adapter: ExpenseAccountingAdapter,
  limit = 10
): Promise<ExpenseAccountingWorkerSummary> {
  const jobs = await repository.claim(limit);
  const summary = { claimed: jobs.length, succeeded: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    let result: Awaited<ReturnType<ExpenseAccountingAdapter["export"]>>;
    try {
      result = await adapter.export(job);
    } catch (error) {
      const providerError = error instanceof ExpenseAccountingProviderError ? error : null;
      const completionStatus = await repository.complete({
        exportId: job.exportId,
        leaseToken: job.leaseToken,
        succeeded: false,
        errorCode: providerError?.code ?? "UNEXPECTED_ADAPTER_ERROR",
        errorSummary: providerError?.message ?? "El adapter contable falló sin exponer detalles internos.",
        retryable: providerError?.retryable ?? false,
      });
      if (completionStatus === "RETRY") summary.retried += 1;
      else summary.failed += 1;
      continue;
    }

    // El proveedor ya pudo haber creado el asiento. Si persistir el éxito
    // falla, no lo reclasifiques como fallo del proveedor: deja vencer el
    // lease y reintenta con la misma clave idempotente.
    const completionStatus = await repository.complete({
      exportId: job.exportId,
      leaseToken: job.leaseToken,
      succeeded: true,
      externalReference: result.externalReference,
    });
    if (completionStatus !== "SUCCEEDED") {
      throw new Error("El cierre exitoso de la salida contable quedó inconsistente.");
    }
    summary.succeeded += 1;
  }
  return summary;
}
