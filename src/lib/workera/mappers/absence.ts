import type { RawWorkeraAbsenceRecord } from "../types/raw";
import type { NormalizedAbsence } from "../types/normalized";
import type { AbsenceTypeMappingTable } from "../types/absence-type";

export interface MapAbsenceOptions {
  typeMapping: AbsenceTypeMappingTable;
}

/**
 * raw (ya validado por schemas/absence.ts) -> NormalizedAbsence. Un
 * `type` externo no reconocido en la tabla de mapeo produce
 * "UNKNOWN_EXTERNAL_STATUS" — nunca se asume VACATION/MEDICAL_LEAVE/etc. por
 * defecto (sección 8 del encargo: "no asumir que Workera devuelve
 * exactamente estas categorías").
 */
export function mapWorkeraAbsence(
  raw: RawWorkeraAbsenceRecord,
  options: MapAbsenceOptions
): NormalizedAbsence {
  return {
    employeeExternalId: raw.employee_id,
    type: options.typeMapping[raw.type] ?? "UNKNOWN_EXTERNAL_STATUS",
    externalType: raw.type,
    startDate: raw.start_date,
    endDate: raw.end_date,
    externalRecordId: raw.record_id ?? null,
  };
}
