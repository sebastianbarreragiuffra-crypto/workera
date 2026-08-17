/**
 * Modelo interno normalizado — lo que NUESTRA aplicación necesita, no lo que
 * Workera necesariamente devuelve (sección 6 del encargo). Estable aunque
 * Workera cambie su forma de JSON; el resto de la app (route handlers, la
 * futura capa de sync, Postgres) solo conoce estos tipos, nunca los de
 * `types/raw.ts`.
 */

import type { EmployeeGroupCode } from "./employee-group";
import type { NormalizedAttendanceStatusCode } from "./attendance-status";

/** Instante normalizado: se conserva el valor original recibido junto al parseo, para poder auditar/depurar sin volver a pedirle el dato a Workera. */
export interface NormalizedInstant {
  /** ISO 8601 UTC, ej. "2026-08-10T23:00:00.000Z". */
  utc: string;
  /** Representación original tal como la entregó Workera, sin modificar. */
  raw: string;
}

/**
 * Resultado del mapeo de grupo — nunca se asigna un grupo "al azar" cuando
 * no hay mapping configurado (sección 10 del encargo): el estado UNMAPPED es
 * explícito y debe generar revisión, no una asignación silenciosa.
 */
export type EmployeeGroupMappingResult =
  | { status: "MAPPED"; group: EmployeeGroupCode }
  | { status: "UNMAPPED"; externalGroup: string | null };

export interface NormalizedEmployee {
  externalId: string;
  rut: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  active: boolean;
  /** Valor crudo de Workera, sin interpretar — para diagnóstico cuando employeeGroup.status === "UNMAPPED". */
  externalGroup: string | null;
  employeeGroup: EmployeeGroupMappingResult;
}

export interface NormalizedAttendance {
  employeeExternalId: string;
  /** Fecha calendario del turno tal como la entrega Workera — NO se reinterpreta a America/Santiago dentro del adapter (sección 18: esa conversión, si es necesaria, es responsabilidad de la capa de sincronización que conoce el contrato real). */
  workDate: string;
  clockIn: NormalizedInstant | null;
  clockOut: NormalizedInstant | null;
  /** Id de registro individual de Workera si existe; null si solo tenemos (empleado, fecha) como clave — ver docs/PRE_FASE2_WORKERA_VALIDATION.md sección 8. */
  externalRecordId: string | null;
  sourceUpdatedAt: NormalizedInstant | null;
}

/**
 * Código diario interno (P/F/F-P/...). Deliberadamente separado de
 * NormalizedAbsence: P, R y "?" no son ausencias (ver
 * docs/DATA_MODEL_PHASE2B.md sección 5) y no sabemos todavía si Workera
 * expone un concepto análogo a este código en absoluto — este tipo existe
 * para cuando/si eso se confirme.
 */
export interface NormalizedAttendanceStatus {
  employeeExternalId: string;
  workDate: string;
  code: NormalizedAttendanceStatusCode;
  /** Valor crudo de Workera para diagnóstico cuando code === "UNKNOWN_EXTERNAL_STATUS". */
  externalCode: string;
}

export type NormalizedAbsenceType =
  | "VACATION"
  | "MEDICAL_LEAVE"
  | "MUTUAL"
  | "PERMISSION"
  | "ABSENCE"
  | "UNKNOWN_EXTERNAL_STATUS";

export interface NormalizedAbsence {
  employeeExternalId: string;
  type: NormalizedAbsenceType;
  /** Valor crudo de Workera para diagnóstico cuando type === "UNKNOWN_EXTERNAL_STATUS". Nunca se descarta el original. */
  externalType: string;
  startDate: string;
  endDate: string;
  externalRecordId: string | null;
}
