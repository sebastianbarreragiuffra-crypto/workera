import "server-only";

export type ExpenseOcrErrorCategory =
  | "CONFIGURATION"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_AUTH"
  | "PROVIDER_REJECTED_DOCUMENT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "STORAGE_DOWNLOAD"
  | "UNEXPECTED";

export class ExpenseOcrError extends Error {
  constructor(
    public readonly category: ExpenseOcrErrorCategory,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExpenseOcrError";
  }
}

export function safeOcrError(error: unknown): ExpenseOcrError {
  if (error instanceof ExpenseOcrError) return error;
  return new ExpenseOcrError("UNEXPECTED", "Fallo inesperado procesando el comprobante.", false, {
    cause: error,
  });
}
