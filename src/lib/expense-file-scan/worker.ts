import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ExpenseFileScanError, safeExpenseFileScanError } from "./errors";
import type { ExpenseFileScanRepository } from "./repository";
import type { ExpenseFileScanner } from "./scanner";

const MAX_QUARANTINED_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const SAFE_RESULT_CODE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export interface ExpenseFileScanWorkerSummary {
  reclaimed: number;
  claimed: number;
  clean: number;
  rejected: number;
  failed: number;
  retried: number;
}

function checksumSha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

export async function runExpenseFileScanWorker(
  repository: ExpenseFileScanRepository,
  scanner: ExpenseFileScanner,
  options: { workerId?: string; limit?: number; staleAfterSeconds?: number } = {},
): Promise<ExpenseFileScanWorkerSummary> {
  if (!SAFE_RESULT_CODE.test(scanner.name)) {
    throw new ExpenseFileScanError(
      "SCANNER_CONFIGURATION",
      "El identificador del scanner no es seguro.",
      false,
    );
  }
  const workerId = options.workerId ?? randomUUID();
  const reclaimed = await repository.reclaim(options.staleAfterSeconds ?? 300);
  const jobs = await repository.claim(workerId, options.limit ?? 3);
  const summary: ExpenseFileScanWorkerSummary = {
    reclaimed,
    claimed: jobs.length,
    clean: 0,
    rejected: 0,
    failed: 0,
    retried: 0,
  };

  for (const job of jobs) {
    try {
      const bytes = await repository.download(job.storagePath);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_QUARANTINED_FILE_BYTES) {
        throw new ExpenseFileScanError(
          "FILE_TOO_LARGE",
          "El objeto almacenado no respeta el tamaño registrado.",
          false,
        );
      }
      if (!ALLOWED_MIME_TYPES.has(job.mimeType)) {
        throw new ExpenseFileScanError(
          "UNSUPPORTED_MIME",
          "El tipo del objeto no pertenece a la allowlist.",
          false,
        );
      }
      if (checksumSha256(bytes) !== job.checksumSha256.toLowerCase()) {
        throw new ExpenseFileScanError(
          "CHECKSUM_MISMATCH",
          "El archivo no coincide con la huella registrada.",
          false,
        );
      }
      const verdict = await scanner.scan({
        bytes,
        mimeType: job.mimeType,
        checksumSha256: job.checksumSha256,
      });
      if (
        (verdict.verdict !== "CLEAN" && verdict.verdict !== "REJECTED")
        || !SAFE_RESULT_CODE.test(verdict.resultCode)
      ) {
        throw new ExpenseFileScanError(
          "SCANNER_FAILURE",
          "El scanner devolvió un contrato inválido.",
          false,
        );
      }
      await repository.complete(job.captureId, workerId, scanner.name, verdict);
      if (verdict.verdict === "CLEAN") summary.clean += 1;
      else summary.rejected += 1;
    } catch (cause) {
      const failure = safeExpenseFileScanError(cause);
      const retried = await repository.fail(
        job.captureId,
        workerId,
        scanner.name,
        failure.code,
        failure.retryable,
      );
      summary.failed += 1;
      if (retried) summary.retried += 1;
    }
  }
  return summary;
}
