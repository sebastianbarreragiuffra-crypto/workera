import "server-only";

export const EXPENSE_BANK_UPLOAD_CONTENT_TYPE = "text/csv";
export const EXPENSE_BANK_UPLOAD_TOTAL_TIMEOUT_MS = 30_000;
export const EXPENSE_BANK_UPLOAD_IDLE_TIMEOUT_MS = 5_000;

export class ExpenseBankUploadHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 408 | 413 | 415
  ) {
    super(message);
    this.name = "ExpenseBankUploadHttpError";
  }
}

type ExpenseBankUploadReadOptions = {
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
};

function uploadTimeoutError(): ExpenseBankUploadHttpError {
  return new ExpenseBankUploadHttpError(
    "La carga demoró demasiado. Revisa tu conexión e intenta nuevamente.",
    408
  );
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(uploadTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ExpenseBankUploadHttpError("La solicitud no proviene de GESTORA.", 403);
  }
}

export function assertExpenseBankUploadHeaders(request: Request, maxBytes: number): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== EXPENSE_BANK_UPLOAD_CONTENT_TYPE) {
    throw new ExpenseBankUploadHttpError("La cartola debe enviarse como CSV.", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new ExpenseBankUploadHttpError("El tamaño informado no es válido.", 400);
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
      throw new ExpenseBankUploadHttpError("La cartola está vacía.", 400);
    }
    if (declaredBytes > maxBytes) {
      throw new ExpenseBankUploadHttpError("La cartola supera el máximo de 2 MB.", 413);
    }
  }
}

/**
 * Lee el cuerpo crudo con corte durante el streaming. Nunca usa formData(),
 * arrayBuffer() ni text() sobre el Request completo.
 */
export async function readRequestBodyWithLimit(
  request: Request,
  maxBytes: number,
  options: ExpenseBankUploadReadOptions = {}
): Promise<Uint8Array> {
  if (!request.body) throw new ExpenseBankUploadHttpError("La cartola está vacía.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  const totalTimeoutMs = options.totalTimeoutMs ?? EXPENSE_BANK_UPLOAD_TOTAL_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? EXPENSE_BANK_UPLOAD_IDLE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let total = 0;

  try {
    while (true) {
      const remainingMs = totalTimeoutMs - (now() - startedAt);
      if (remainingMs <= 0) throw uploadTimeoutError();
      const { done, value } = await readChunkWithTimeout(reader, Math.min(idleTimeoutMs, remainingMs));
      if (done) break;
      if (now() - startedAt >= totalTimeoutMs) throw uploadTimeoutError();
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("expense-bank-upload-too-large");
        throw new ExpenseBankUploadHttpError("La cartola supera el máximo de 2 MB.", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExpenseBankUploadHttpError && error.status === 408) {
      await reader.cancel("expense-bank-upload-timeout").catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw new ExpenseBankUploadHttpError("La cartola está vacía.", 400);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
