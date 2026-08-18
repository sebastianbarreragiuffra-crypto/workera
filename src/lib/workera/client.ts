import "server-only";
import type { LocalDateRange, WorkeraListOptions, WorkeraListResult } from "./types/common";
import type { NormalizedEmployee, NormalizedAttendance, NormalizedAbsence } from "./types/normalized";
import { getWorkeraConfig } from "./config";
import { WorkeraConfigurationError } from "./errors";
import { MockWorkeraClient } from "./mock-client";
import { HttpWorkeraClient } from "./http-client";

export interface GetAttendanceParams {
  range: LocalDateRange;
  options?: WorkeraListOptions;
}

export interface GetAbsencesParams {
  range: LocalDateRange;
  options?: WorkeraListOptions;
}

/**
 * Contrato interno estable. Solo declara las 3 operaciones para las que
 * tenemos una necesidad funcional clara y confirmada por NUESTRO lado
 * (necesitamos trabajadores, marcaciones y ausencias sin importar cómo
 * Workera termine exponiéndolos) — no una lista de endpoints que afirmemos
 * que Workera tiene.
 *
 * Deliberadamente NO incluye: overtime, supervisors, ni ningún método de
 * escritura (approveOvertime, etc.) — su disponibilidad real en Workera es
 * UNCONFIRMED_WORKERA_CAPABILITY (ver capabilities.ts). Horas extra es
 * además dominio de negocio nuestro, no de Workera (secciones 25-27 del
 * encargo). Si Fase 5 confirma una capacidad de escritura, se agrega como
 * método adicional gateado por `capabilities.writeOvertimeApproval`, de
 * forma aditiva — no rompe implementaciones existentes de esta interfaz.
 */
export interface WorkeraClient {
  getEmployees(options?: WorkeraListOptions): Promise<WorkeraListResult<NormalizedEmployee>>;
  getAttendance(params: GetAttendanceParams): Promise<WorkeraListResult<NormalizedAttendance>>;
  getAbsences(params: GetAbsencesParams): Promise<WorkeraListResult<NormalizedAbsence>>;
}

/**
 * Punto único de creación del cliente. Decide mock vs. http según
 * configuración (fail-closed en producción, ver config.ts). El resto de la
 * aplicación llama a `createWorkeraClient()` y programa contra
 * `WorkeraClient`, nunca importa `MockWorkeraClient`/`HttpWorkeraClient`
 * directamente.
 */
export function createWorkeraClient(): WorkeraClient {
  const config = getWorkeraConfig();

  if (config.provider === "mock") {
    return new MockWorkeraClient();
  }

  // provider === "http": implementación real (Fase 5C), contra la API
  // pública documentada en help.workera.com. getWorkeraConfig() ya validó
  // que baseUrl/apiUser/apiKey estén presentes para este provider.
  if (!config.baseUrl || !config.apiUser || !config.apiKey) {
    throw new WorkeraConfigurationError(
      "WORKERA_PROVIDER=http requiere WORKERA_BASE_URL, WORKERA_API_USER y WORKERA_API_KEY configurados."
    );
  }

  return new HttpWorkeraClient({
    baseUrl: config.baseUrl,
    apiUser: config.apiUser,
    apiKey: config.apiKey,
    requestTimeoutMs: config.requestTimeoutMs,
  });
}
