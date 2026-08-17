import type { NormalizedAttendanceStatusCode } from "../types/attendance-status";
import type { AttendanceStatusMappingTable } from "../types/attendance-status";

/**
 * Mapea un código externo de Workera hacia uno de nuestros 11 códigos
 * internos (P/F/F-P/.../?). Un valor externo desconocido NUNCA se convierte
 * silenciosamente en "P" o "F" (regla explícita, sección 9 del encargo) —
 * produce "UNKNOWN_EXTERNAL_STATUS", que la futura capa de sincronización
 * debe tratar como NEEDS_REVIEW, igual criterio que el código "?" interno
 * (docs/DATA_MODEL_PHASE2B.md sección 4).
 */
export function mapAttendanceStatus(
  externalCode: string,
  mapping: AttendanceStatusMappingTable
): NormalizedAttendanceStatusCode {
  const mapped = mapping[externalCode];
  return mapped ?? "UNKNOWN_EXTERNAL_STATUS";
}
