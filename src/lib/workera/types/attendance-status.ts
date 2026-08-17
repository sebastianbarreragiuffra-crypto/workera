/**
 * Los 11 códigos diarios reales de nuestra aplicación
 * (docs/DATA_MODEL_PHASE2B.md sección 5, catálogo `attendance_statuses`).
 * Este archivo no afirma que Workera use este vocabulario — ver
 * mappers/attendance-status.ts.
 */
export type InternalAttendanceStatusCode =
  | "P"
  | "F"
  | "F-P"
  | "F-J"
  | "P-L"
  | "P-M"
  | "V"
  | "L"
  | "L-M"
  | "R"
  | "?";

/**
 * Un valor externo de Workera que no está en la tabla de mapeo NUNCA se
 * convierte silenciosamente en "P" o "F" (regla explícita, sección 9 del
 * encargo) — se representa con este código adicional, que exige revisión
 * humana o actualización del mapeo antes de sincronizar.
 */
export type NormalizedAttendanceStatusCode = InternalAttendanceStatusCode | "UNKNOWN_EXTERNAL_STATUS";

export const INTERNAL_ATTENDANCE_STATUS_CODES: readonly InternalAttendanceStatusCode[] = [
  "P",
  "F",
  "F-P",
  "F-J",
  "P-L",
  "P-M",
  "V",
  "L",
  "L-M",
  "R",
  "?",
];

/** Igual patrón de inyección de dependencia que EmployeeGroupMappingTable — ver ese archivo para el razonamiento. */
export type AttendanceStatusMappingTable = Readonly<Record<string, InternalAttendanceStatusCode>>;

/** Vacía por defecto: no conocemos el vocabulario real de Workera todavía. */
export const EMPTY_ATTENDANCE_STATUS_MAPPING: AttendanceStatusMappingTable = Object.freeze({});
