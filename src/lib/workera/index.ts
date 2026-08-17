import "server-only";

/**
 * Punto de entrada público del adaptador Workera. Cualquier código server-side
 * del resto de la aplicación debe importar exclusivamente desde aquí (o
 * desde `./client` directamente para el tipo `WorkeraClient`), nunca desde
 * `mock-client.ts`/`schemas/`/`mappers/`/`types/raw.ts` — esos son detalles
 * internos de esta carpeta (ver README.md).
 */

export { createWorkeraClient } from "./client";
export type { WorkeraClient, GetAttendanceParams, GetAbsencesParams } from "./client";

export type {
  NormalizedEmployee,
  NormalizedAttendance,
  NormalizedAttendanceStatus,
  NormalizedAbsence,
  NormalizedAbsenceType,
  NormalizedInstant,
  EmployeeGroupMappingResult,
} from "./types/normalized";
export type { LocalDate, LocalDateRange, WorkeraListOptions, WorkeraListResult, WorkeraPageToken } from "./types/common";
export type { EmployeeGroupCode } from "./types/employee-group";
export type { InternalAttendanceStatusCode, NormalizedAttendanceStatusCode } from "./types/attendance-status";

export {
  WorkeraError,
  WorkeraConfigurationError,
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraValidationError,
  WorkeraNetworkError,
  WorkeraTimeoutError,
  WorkeraServerError,
  isRetryableWorkeraError,
} from "./errors";
export type { WorkeraErrorCode } from "./errors";

export { WORKERA_CAPABILITIES, isCapabilityConfirmed } from "./capabilities";
export type { WorkeraCapabilities, CapabilityStatus } from "./capabilities";
