import "server-only";
import type { WorkeraClient, GetAttendanceParams, GetAbsencesParams } from "./client";
import type { WorkeraListOptions, WorkeraListResult } from "./types/common";
import type { NormalizedEmployee, NormalizedAttendance, NormalizedAbsence } from "./types/normalized";
import type { NormalizedWorkeraAttendancePage } from "./types/attendance-event";
import { rawWorkeraAttendanceDataResponseSchema } from "./schemas/attendance-event";
import { validateWorkeraPayload } from "./schemas/validate";
import { mapWorkeraAttendanceEvent } from "./mappers/attendance-event";
import {
  WorkeraConfigurationError,
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraValidationError,
  WorkeraNetworkError,
  WorkeraTimeoutError,
  WorkeraServerError,
} from "./errors";
import { createCorrelationId, logWorkeraEvent } from "./logging";

export interface HttpWorkeraClientConfig {
  /** Ej. "https://workera.com/apiClient/v1" (sin slash final). */
  baseUrl: string;
  /** Header HTTP "API_USER" — nunca loguear. */
  apiUser: string;
  /** Header HTTP "API_KEY" — nunca loguear. */
  apiKey: string;
  requestTimeoutMs: number;
}

export interface GetAttendanceEventsParams {
  /** yyyy-MM-dd, requerido (confirmado por el manual). */
  start: string;
  /** yyyy-MM-dd, requerido (confirmado por el manual). */
  end: string;
  /** Default 1 si se omite. */
  page?: number;
  /** Opcional — el manual confirma que NO es requerido para /attendanceData. */
  branchOffice?: string;
  /** Opcional. */
  department?: string;
  /** Opcional, códigos ficha separados por coma. */
  employees?: string[];
  /** Opcional, valores documentados: RELOJ, MOVIL, SISTEMA, PORTAL, DESKTOP. */
  attTypes?: string[];
}

/**
 * Implementación real de `WorkeraClient` contra la API pública documentada
 * en help.workera.com (Fase 5C). `import "server-only"` arriba hace que
 * Next.js falle el build si algún Client Component intentara importar este
 * módulo — nunca debe llegar al bundle del browser.
 *
 * Alcance deliberado de esta fase: SOLO lectura de `/attendanceData`, a
 * nivel de evento individual, sin colapsar a clock_in/clock_out (regla 16
 * del encargo Fase 5C — esa responsabilidad es de una futura capa de
 * sincronización/reglas de negocio, no de este adapter). Por eso
 * `getEmployees`/`getAttendance`/`getAbsences` (la interfaz `WorkeraClient`
 * "colapsada", pensada para cuando exista esa capa) lanzan explícitamente
 * "no implementado en esta fase" en vez de inventar un comportamiento no
 * confirmado — el método real y probado es `getAttendanceEvents`.
 */
export class HttpWorkeraClient implements WorkeraClient {
  constructor(private readonly config: HttpWorkeraClientConfig) {}

  async getEmployees(_options?: WorkeraListOptions): Promise<WorkeraListResult<NormalizedEmployee>> {
    void _options;
    throw new WorkeraConfigurationError(
      "HttpWorkeraClient.getEmployees no está implementado todavía — fuera de alcance de Fase 5C (solo attendanceData de solo lectura)."
    );
  }

  async getAttendance(_params: GetAttendanceParams): Promise<WorkeraListResult<NormalizedAttendance>> {
    void _params;
    throw new WorkeraConfigurationError(
      "HttpWorkeraClient.getAttendance (forma colapsada clock_in/clock_out) no está implementado todavía — " +
        "Fase 5C solo expone getAttendanceEvents() a nivel de evento individual, sin colapsar (regla 16 del encargo)."
    );
  }

  async getAbsences(_params: GetAbsencesParams): Promise<WorkeraListResult<NormalizedAbsence>> {
    void _params;
    throw new WorkeraConfigurationError(
      "HttpWorkeraClient.getAbsences no está implementado todavía — fuera de alcance de Fase 5C."
    );
  }

  /**
   * Único método real de esta fase: GET /attendanceData. Solo lectura,
   * timeout explícito, validación Zod estricta (unknown -> Zod -> DTO
   * validado -> mapper -> DTO normalizado), sin retries agresivos, sin
   * loguear PII ni credenciales.
   */
  async getAttendanceEvents(params: GetAttendanceEventsParams): Promise<NormalizedWorkeraAttendancePage> {
    const correlationId = createCorrelationId();
    const operation = "getAttendanceEvents";
    const startedAt = Date.now();

    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, "")}/attendanceData`);
    url.searchParams.set("start", params.start);
    url.searchParams.set("end", params.end);
    url.searchParams.set("page", String(params.page ?? 1));
    if (params.branchOffice) url.searchParams.set("branchOffice", params.branchOffice);
    if (params.department) url.searchParams.set("department", params.department);
    if (params.employees?.length) url.searchParams.set("employees", params.employees.join(","));
    if (params.attTypes?.length) url.searchParams.set("attTypes", params.attTypes.join(","));

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          API_USER: this.config.apiUser,
          API_KEY: this.config.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (err instanceof Error && err.name === "AbortError") {
        logWorkeraEvent({
          correlationId,
          operation,
          durationMs,
          outcome: "error",
          errorCode: "WORKERA_TIMEOUT_ERROR",
        });
        throw new WorkeraTimeoutError(
          `Timeout tras ${this.config.requestTimeoutMs}ms consultando ${operation}`,
          { correlationId }
        );
      }
      logWorkeraEvent({
        correlationId,
        operation,
        durationMs,
        outcome: "error",
        errorCode: "WORKERA_NETWORK_ERROR",
      });
      throw new WorkeraNetworkError(
        `Fallo de red consultando ${operation}: ${err instanceof Error ? err.message : "desconocido"}`,
        { correlationId }
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    const durationMs = Date.now() - startedAt;

    if (response.status === 401) {
      logWorkeraEvent({ correlationId, operation, statusCode: 401, durationMs, outcome: "error", errorCode: "WORKERA_AUTHENTICATION_ERROR" });
      throw new WorkeraAuthenticationError("Workera rechazó las credenciales (401).", { correlationId });
    }
    if (response.status === 403) {
      logWorkeraEvent({ correlationId, operation, statusCode: 403, durationMs, outcome: "error", errorCode: "WORKERA_AUTHORIZATION_ERROR" });
      throw new WorkeraAuthorizationError("Credenciales válidas pero sin permiso para esta operación (403).", { correlationId });
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      logWorkeraEvent({ correlationId, operation, statusCode: 429, durationMs, outcome: "error", errorCode: "WORKERA_RATE_LIMIT_ERROR" });
      throw new WorkeraRateLimitError("Rate limit de Workera alcanzado (429).", retryAfterMs, { correlationId });
    }
    if (response.status >= 500) {
      logWorkeraEvent({ correlationId, operation, statusCode: response.status, durationMs, outcome: "error", errorCode: "WORKERA_SERVER_ERROR" });
      throw new WorkeraServerError(`Error de servidor de Workera (${response.status}).`, response.status, { correlationId });
    }
    if (!response.ok) {
      logWorkeraEvent({ correlationId, operation, statusCode: response.status, durationMs, outcome: "error", errorCode: "WORKERA_SERVER_ERROR" });
      throw new WorkeraServerError(`Respuesta HTTP inesperada de Workera (${response.status}).`, response.status, { correlationId });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      logWorkeraEvent({ correlationId, operation, statusCode: response.status, durationMs, outcome: "error", errorCode: "WORKERA_VALIDATION_ERROR" });
      throw new WorkeraValidationError(`Respuesta de Workera no es JSON válido para ${operation}.`, [], { correlationId });
    }

    const validated = validateWorkeraPayload(rawWorkeraAttendanceDataResponseSchema, json, { operation });

    logWorkeraEvent({
      correlationId,
      operation,
      statusCode: response.status,
      durationMs,
      outcome: "success",
    });

    return {
      page: validated.page,
      totalPages: validated.totalPages,
      pageResult: validated.pageResult,
      totalResult: validated.totalResult,
      events: validated.data.map(mapWorkeraAttendanceEvent),
    };
  }
}
