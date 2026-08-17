/**
 * Errores tipados del adaptador Workera. El resto de la aplicación debe
 * poder distinguir "reintentar" de "alertar a un humano" de "detener la
 * sincronización" sin conocer códigos HTTP ni detalles de transporte.
 */

export type WorkeraErrorCode =
  | "WORKERA_CONFIGURATION_ERROR"
  | "WORKERA_AUTHENTICATION_ERROR"
  | "WORKERA_AUTHORIZATION_ERROR"
  | "WORKERA_RATE_LIMIT_ERROR"
  | "WORKERA_VALIDATION_ERROR"
  | "WORKERA_NETWORK_ERROR"
  | "WORKERA_TIMEOUT_ERROR"
  | "WORKERA_SERVER_ERROR";

export abstract class WorkeraError extends Error {
  abstract readonly code: WorkeraErrorCode;
  /** Contexto de diagnóstico seguro de loguear — nunca API keys, headers de auth, ni payloads completos (ver src/lib/workera/logging.ts). */
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

/** Configuración inválida o faltante (provider, base URL, credenciales). Nunca se intenta la llamada. */
export class WorkeraConfigurationError extends WorkeraError {
  readonly code = "WORKERA_CONFIGURATION_ERROR" as const;
}

/** Credenciales rechazadas por Workera (401 o equivalente). No reintentar sin corregir la config. */
export class WorkeraAuthenticationError extends WorkeraError {
  readonly code = "WORKERA_AUTHENTICATION_ERROR" as const;
}

/** Credenciales válidas pero sin permiso para la operación (403 o equivalente). No reintentar. */
export class WorkeraAuthorizationError extends WorkeraError {
  readonly code = "WORKERA_AUTHORIZATION_ERROR" as const;
}

/** 429 o equivalente. Retryable con backoff — ver retryAfterMs si Workera lo informa. */
export class WorkeraRateLimitError extends WorkeraError {
  readonly code = "WORKERA_RATE_LIMIT_ERROR" as const;
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number, context?: Record<string, unknown>) {
    super(message, context);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * El payload no cumple el schema esperado (WORKERA_PAYLOAD_VALIDATION_ERROR
 * del encargo). Nunca deja pasar el dato crudo hacia el mapper ni hacia
 * Postgres — falla explícito con el detalle de qué no calzó.
 */
export class WorkeraValidationError extends WorkeraError {
  readonly code = "WORKERA_VALIDATION_ERROR" as const;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(
    message: string,
    issues: ReadonlyArray<{ path: string; message: string }>,
    context?: Record<string, unknown>
  ) {
    super(message, context);
    this.issues = issues;
  }
}

/** Falla de red (DNS, conexión rechazada, etc). Retryable. */
export class WorkeraNetworkError extends WorkeraError {
  readonly code = "WORKERA_NETWORK_ERROR" as const;
}

/** La request excedió el timeout configurado. Retryable. */
export class WorkeraTimeoutError extends WorkeraError {
  readonly code = "WORKERA_TIMEOUT_ERROR" as const;
}

/** 5xx de Workera. Retryable con backoff. */
export class WorkeraServerError extends WorkeraError {
  readonly code = "WORKERA_SERVER_ERROR" as const;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, context?: Record<string, unknown>) {
    super(message, context);
    this.statusCode = statusCode;
  }
}

/**
 * Estrategia de reintento (diseño, no un sistema de colas — sección 14 del
 * encargo). El futuro HttpWorkeraClient debe consultar esto antes de
 * reintentar, no decidir caso a caso de forma dispersa.
 *
 * Retryable: timeout de red, 429 (rate limit), 5xx (error del servidor).
 * NO retryable: configuración inválida, 401/403, payload inválido — estos
 * nunca se arreglan reintentando la misma request.
 */
export function isRetryableWorkeraError(error: unknown): boolean {
  return (
    error instanceof WorkeraNetworkError ||
    error instanceof WorkeraTimeoutError ||
    error instanceof WorkeraRateLimitError ||
    error instanceof WorkeraServerError
  );
}
