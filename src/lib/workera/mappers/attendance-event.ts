import type { RawWorkeraAttendanceEventParsed } from "../schemas/attendance-event";
import type { NormalizedWorkeraAttendanceEvent, WorkeraAttendanceStatus } from "../types/attendance-event";
import { WORKERA_ATTENDANCE_TYPES } from "../types/attendance-event";

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["ACTIVO", "INACTIVO", "MODIFICADO"]);

/**
 * Mapea un evento crudo (ya validado por Zod) al modelo normalizado a nivel
 * de evento. NUNCA colapsa a clock_in/clock_out (regla 16, Fase 5C) y nunca
 * descarta el valor externo original cuando un código no se reconoce —
 * mismo criterio que mappers/attendance-status.ts y mappers/absence.ts para
 * UNKNOWN_EXTERNAL_STATUS.
 */
export function mapWorkeraAttendanceEvent(
  raw: RawWorkeraAttendanceEventParsed
): NormalizedWorkeraAttendanceEvent {
  const typeLabel =
    raw.attendanceType in WORKERA_ATTENDANCE_TYPES
      ? WORKERA_ATTENDANCE_TYPES[raw.attendanceType as keyof typeof WORKERA_ATTENDANCE_TYPES]
      : "UNKNOWN_EXTERNAL_TYPE";

  const status: WorkeraAttendanceStatus = KNOWN_STATUSES.has(raw.attendanceStatus)
    ? (raw.attendanceStatus as WorkeraAttendanceStatus)
    : "UNKNOWN_EXTERNAL_STATUS";

  return {
    employeeExternalId: raw.employee.code,
    employee: {
      code: raw.employee.code,
      identification: raw.employee.identification ?? null,
      name: raw.employee.name ?? null,
      lastName: raw.employee.lastName ?? null,
      branchOffice: raw.employee.branchOffice ?? null,
      department: raw.employee.department ?? null,
      employeeStatus: raw.employee.employeeStatus ?? null,
      companyIdentification: raw.employee.companyIdentification ?? null,
      companyName: raw.employee.companyName ?? null,
    },
    attendanceTimestampRaw: raw.attendanceDate,
    attendanceTypeCode: raw.attendanceType,
    attendanceTypeLabel: typeLabel,
    attendanceStatus: status,
    externalAttendanceStatus: raw.attendanceStatus,
    origin: raw.origin ?? null,
    originCode: raw.originCode ?? null,
    deviceName: raw.deviceName ?? null,
    checksum: raw.checksum ?? null,
  };
}
