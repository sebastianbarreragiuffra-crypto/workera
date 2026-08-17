import "server-only";
import type { LocalDateRange, WorkeraListOptions, WorkeraListResult } from "./types/common";
import type { NormalizedEmployee, NormalizedAttendance, NormalizedAbsence } from "./types/normalized";
import { getWorkeraConfig } from "./config";
import { WorkeraConfigurationError } from "./errors";
import { MockWorkeraClient } from "./mock-client";

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

  // provider === "http": todavía no implementado — no existe documentación
  // ni credenciales reales de Workera verificadas en este repositorio
  // (WAITING_FOR_WORKERA_DOCUMENTATION). Se implementa en Fase 5.
  throw new WorkeraConfigurationError(
    "HttpWorkeraClient no está implementado todavía — pendiente de documentación/credenciales reales de Workera (Fase 5)."
  );
}
