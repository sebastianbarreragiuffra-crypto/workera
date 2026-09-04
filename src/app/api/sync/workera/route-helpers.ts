import type { NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";

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
    .filter(([, result]) => result.status === "SUCCEEDED")
    .map(([date]) => date);
}
