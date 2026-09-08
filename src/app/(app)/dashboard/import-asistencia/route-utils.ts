import { createHmac } from "node:crypto";
import type { PayrollWorkbookConflictPreview } from "../../../../lib/business-rules/attendance-export";
import {
  resolvePayrollPeriod,
  resolveWorkbookPeriodIdentity,
  type AttendanceExportPeriod,
} from "../../../../lib/business-rules/attendance-export-periods";
import type { PayrollWorkbookChange } from "../../../../lib/payroll/payroll-workbook-upload";

export function payrollWorkbookPreviewToken(input: {
  baseVersionId: string | null;
  sourceRevision: number;
  uploadedSha256: string;
  changes: PayrollWorkbookChange[];
  conflicts?: PayrollWorkbookConflictPreview[];
}, signingSecret: string, actorId: string, issuedAt: number): string {
  return createHmac("sha256", signingSecret)
    .update(JSON.stringify({ ...input, actorId, issuedAt }))
    .digest("hex");
}

export function resolveSubmittedWorkbookPeriod(input: {
  periodType: string;
  periodStart: string;
  periodEnd: string;
  legacyMonth?: string;
}): AttendanceExportPeriod {
  if (!input.periodType && /^\d{4}-(0[1-9]|1[0-2])$/.test(input.legacyMonth ?? "")) {
    return resolvePayrollPeriod(input.legacyMonth!);
  }
  if (!["DIARIO", "SEMANAL", "QUINCENAL", "PAGO"].includes(input.periodType)) {
    throw new Error("La frecuencia del archivo no es válida.");
  }
  return resolveWorkbookPeriodIdentity({
    periodType: input.periodType as "DIARIO" | "SEMANAL" | "QUINCENAL" | "PAGO",
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
}

/** Lee el stream con un límite antes de invocar formData(), incluso sin Content-Length. */
export async function requestWithLimitedBody(request: Request, maxBytes: number): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("PAYROLL_MULTIPART_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** Multipart inválido es una entrada de cliente, no una falla interna. */
export async function parsePayrollMultipart(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
