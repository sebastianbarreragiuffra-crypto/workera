import "server-only";
import type { NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";

export const MAX_MANUAL_RERUN_BODY_BYTES = 1024;

/**
 * La comparación vive en `@/lib/auth/cron-secret` porque el middleware necesita
 * exactamente la misma decisión. El handler la revalida por su cuenta: es la
 * autoridad, y nunca confía en que el middleware ya la hizo.
 */
export function isValidCronSecret(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

/** Peor status entre los resultados de una tanda de fechas, para el código HTTP de la respuesta. */
export function worstHttpStatus(statuses: string[]): number {
  if (statuses.some((s) => s === "FAILED")) return 500;
  if (statuses.some((s) => s === "PARTIAL")) return 500;
  if (statuses.some((s) => s === "ALREADY_RUNNING")) return 409;
  if (statuses.some((s) => s.startsWith("BLOCKED_"))) return 422;
  return 200;
}

/**
 * Fechas sobre las que tiene sentido correr el motor de reglas: solo aquellas
 * cuya sincronización terminó SUCCEEDED. Un DRY_RUN no escribió eventos, un
 * FAILED no dejó datos confiables, y un ALREADY_RUNNING significa que otro
 * proceso está ocupándose de esa fecha.
 */
export function datesReadyForRuleEngine(results: Record<string, { status: string }>): string[] {
  return Object.entries(results)
    .filter(([, r]) => r.status === "SUCCEEDED")
    .map(([date]) => date);
}

export async function readManualRerunBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_MANUAL_RERUN_BODY_BYTES)) {
    throw new RangeError("request_too_large");
  }
  if (!request.body) throw new SyntaxError("empty_body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANUAL_RERUN_BODY_BYTES) {
        await reader.cancel("manual-rerun-body-too-large");
        throw new RangeError("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
