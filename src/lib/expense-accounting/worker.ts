import "server-only";
import { ExpenseAccountingProviderError, type ExpenseAccountingAdapter } from "./adapter";
import type { ExpenseAccountingRepository } from "./repository";

export interface ExpenseAccountingWorkerSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export interface ExpenseAccountingWorkerOptions {
  deadlineAtMs?: number;
  jobTimeoutMs?: number;
}

const COMPLETION_RESERVE_MS = 1_000;
const DEFAULT_JOB_TIMEOUT_MS = 30_000;
const SAFE_AUTOMATIC_RETRY_CODES = new Set(["RATE_LIMIT"]);

export function isSafeAutomaticExpenseAccountingRetry(code: string): boolean {
  return SAFE_AUTOMATIC_RETRY_CODES.has(code);
}

async function exportWithTimeout(
  adapter: ExpenseAccountingAdapter,
  job: Parameters<ExpenseAccountingAdapter["export"]>[0],
  timeoutMs: number
): Promise<Awaited<ReturnType<ExpenseAccountingAdapter["export"]>>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Un timeout no demuestra que el proveedor no haya creado el asiento.
      // Falla cerrado y exige reconciliación humana para evitar duplicarlo.
      reject(new ExpenseAccountingProviderError("ADAPTER_TIMEOUT", false));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([adapter.export(job, { signal: controller.signal }), timeout]);
  } catch (error) {
    // El adapter puede reaccionar al abort rechazando con su propio error
    // retryable. El timeout manda: el resultado externo sigue siendo incierto.
    if (controller.signal.aborted) {
      throw new ExpenseAccountingProviderError("ADAPTER_TIMEOUT", false);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runExpenseAccountingWorker(
  repository: ExpenseAccountingRepository,
  adapter: ExpenseAccountingAdapter,
  limit = 10,
  options: ExpenseAccountingWorkerOptions = {}
): Promise<ExpenseAccountingWorkerSummary> {
  const summary = { claimed: 0, succeeded: 0, retried: 0, failed: 0 };
  const configuredTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  while (summary.claimed < limit) {
    if (
      options.deadlineAtMs !== undefined
      && options.deadlineAtMs - Date.now() < configuredTimeoutMs + COMPLETION_RESERVE_MS
    ) break;

    // Reclamar de a uno evita dejar el resto de un lote retenido cuando la
    // función se acerca a su deadline. El lease sigue protegido por fencing.
    const jobs = await repository.claim(1);
    if (jobs.length === 0) break;
    const job = jobs[0];
    summary.claimed += 1;
    const timeoutMs = options.deadlineAtMs === undefined
      ? configuredTimeoutMs
      : Math.max(1, Math.min(
          configuredTimeoutMs,
          options.deadlineAtMs - Date.now() - COMPLETION_RESERVE_MS
        ));
    let result: Awaited<ReturnType<ExpenseAccountingAdapter["export"]>>;
    try {
      result = await exportWithTimeout(adapter, job, timeoutMs);
    } catch (error) {
      const providerError = error instanceof ExpenseAccountingProviderError ? error : null;
      const completionStatus = await repository.complete({
        exportId: job.exportId,
        leaseToken: job.leaseToken,
        succeeded: false,
        errorCode: providerError?.code ?? "UNEXPECTED_ADAPTER_ERROR",
        errorSummary: providerError?.message ?? "El adapter contable falló sin exponer detalles internos.",
        retryable: providerError
          ? providerError.retryable && isSafeAutomaticExpenseAccountingRetry(providerError.code)
          : false,
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
