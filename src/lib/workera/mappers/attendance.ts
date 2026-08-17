import type { RawWorkeraAttendanceRecord } from "../types/raw";
import type { NormalizedAttendance, NormalizedAttendanceStatus } from "../types/normalized";
import type { AttendanceStatusMappingTable } from "../types/attendance-status";
import { toNormalizedInstantOrNull } from "./instant";
import { mapAttendanceStatus } from "./attendance-status";

/**
 * raw (ya validado por schemas/attendance.ts) -> NormalizedAttendance.
 * clock_in/clock_out ausentes se representan como `null`, nunca se inventa
 * un valor (ej. "marcación faltante" nunca se convierte silenciosamente en
 * un clock_out igual al scheduled_end — eso sería decidir una regla de
 * negocio, prohibido en esta capa, sección 25-27 del encargo).
 */
export function mapWorkeraAttendance(raw: RawWorkeraAttendanceRecord): NormalizedAttendance {
  return {
    employeeExternalId: raw.employee_id,
    workDate: raw.date,
    clockIn: toNormalizedInstantOrNull(raw.clock_in),
    clockOut: toNormalizedInstantOrNull(raw.clock_out),
    externalRecordId: raw.record_id ?? null,
    sourceUpdatedAt: toNormalizedInstantOrNull(raw.updated_at),
  };
}

export interface MapAttendanceStatusOptions {
  statusMapping: AttendanceStatusMappingTable;
}

/**
 * Extrae y mapea el código diario, si Workera lo entrega (campo
 * especulativo `status_code`, ver types/raw.ts). Devuelve null cuando
 * Workera no informó ningún código para este registro — distinto de
 * "UNKNOWN_EXTERNAL_STATUS", que significa "informó algo, pero no lo
 * reconocemos".
 */
export function mapWorkeraAttendanceStatus(
  raw: RawWorkeraAttendanceRecord,
  options: MapAttendanceStatusOptions
): NormalizedAttendanceStatus | null {
  if (!raw.status_code) return null;

  return {
    employeeExternalId: raw.employee_id,
    workDate: raw.date,
    code: mapAttendanceStatus(raw.status_code, options.statusMapping),
    externalCode: raw.status_code,
  };
}
