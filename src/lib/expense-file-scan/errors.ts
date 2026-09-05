import "server-only";

export type ExpenseFileScanErrorCode =
  | "CHECKSUM_MISMATCH"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_MIME"
  | "STORAGE_DOWNLOAD"
  | "SCANNER_CONFIGURATION"
  | "SCANNER_FAILURE";

export class ExpenseFileScanError extends Error {
  constructor(
    readonly code: ExpenseFileScanErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExpenseFileScanError";
  }
}

export function safeExpenseFileScanError(cause: unknown): ExpenseFileScanError {
  if (cause instanceof ExpenseFileScanError) return cause;
  return new ExpenseFileScanError("SCANNER_FAILURE", "El escáner no pudo emitir un veredicto.", true);
}
