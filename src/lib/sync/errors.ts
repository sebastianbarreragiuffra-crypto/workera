import "server-only";
import {
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraTimeoutError,
  WorkeraNetworkError,
  WorkeraServerError,
  WorkeraValidationError,
  WorkeraConfigurationError,
} from "../workera/errors";

/**
 * Categorías estables de fallo (Fase 6B, PASO 27) — mismos valores que el
 * check constraint de `sync_runs.error_category` (migración
 * 20260819100000). Permiten a la capa de orquestación decidir "reintentar o
 * no" sin depender de texto libre, y a health checks agrupar fallos sin
 * exponer detalles internos.
 */
export type SyncErrorCategory =
  | "WORKERA_AUTH"
  | "WORKERA_RATE_LIMIT"
  | "WORKERA_TIMEOUT"
  | "WORKERA_NETWORK"
  | "WORKERA_SERVER"
  | "WORKERA_PAYLOAD"
  | "EMPLOYEE_RESOLUTION"
  | "DATABASE"
  | "CONCURRENCY"
  | "CONFIGURATION";

/**
 * Clasifica un error capturado durante un sync en una categoría estable.
 * Solo se llama sobre errores lanzados por `HttpWorkeraClient` (instancias
 * de `WorkeraError`) o errores de Supabase/Postgres (fallback "DATABASE") --
 * nunca se le pasa un error de "no autorizado" o de configuración de
 * negocio, esos ya tienen su propio status explícito
 * (BLOCKED_UNRESOLVED_EMPLOYEES/BLOCKED_RANGE_TOO_LARGE/ALREADY_RUNNING).
 */
export function classifySyncError(err: unknown): SyncErrorCategory {
  if (err instanceof WorkeraAuthenticationError || err instanceof WorkeraAuthorizationError) {
    return "WORKERA_AUTH";
  }
  if (err instanceof WorkeraRateLimitError) return "WORKERA_RATE_LIMIT";
  if (err instanceof WorkeraTimeoutError) return "WORKERA_TIMEOUT";
  if (err instanceof WorkeraNetworkError) return "WORKERA_NETWORK";
  if (err instanceof WorkeraServerError) return "WORKERA_SERVER";
  if (err instanceof WorkeraValidationError) return "WORKERA_PAYLOAD";
  if (err instanceof WorkeraConfigurationError) return "CONFIGURATION";
  return "DATABASE";
}

/**
 * Mismo criterio de retryable/no-retryable que
 * `src/lib/workera/errors.ts#isRetryableWorkeraError` (Fase 4/5), re-expresado
 * sobre la categoría persistida en `sync_runs.error_category` -- la capa de
 * orquestación (src/lib/sync/scheduler.ts) nunca ve la instancia de error
 * original (syncWorkeraAttendance la captura y devuelve un resultado plano),
 * así que necesita decidir "reintentar" a partir de esta categoría, no del
 * error en sí. Deliberadamente la MISMA política, no una segunda
 * contradictoria (Fase 6B, PASO 14).
 */
const RETRYABLE_CATEGORIES: ReadonlySet<SyncErrorCategory> = new Set([
  "WORKERA_RATE_LIMIT",
  "WORKERA_TIMEOUT",
  "WORKERA_NETWORK",
  "WORKERA_SERVER",
]);

export function isRetryableSyncErrorCategory(category: SyncErrorCategory | null | undefined): boolean {
  return category != null && RETRYABLE_CATEGORIES.has(category);
}
