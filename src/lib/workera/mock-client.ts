import "server-only";
import type { WorkeraClient, GetAttendanceParams, GetAbsencesParams } from "./client";
import type { WorkeraListOptions, WorkeraListResult } from "./types/common";
import type { NormalizedEmployee, NormalizedAttendance, NormalizedAbsence } from "./types/normalized";
import type { RawWorkeraEmployee, RawWorkeraAttendanceRecord, RawWorkeraAbsenceRecord } from "./types/raw";
import type { EmployeeGroupMappingTable } from "./types/employee-group";
import type { AbsenceTypeMappingTable } from "./types/absence-type";
import { rawWorkeraEmployeeSchema } from "./schemas/employee";
import { rawWorkeraAttendanceRecordSchema } from "./schemas/attendance";
import { rawWorkeraAbsenceRecordSchema } from "./schemas/absence";
import { validateWorkeraPayload } from "./schemas/validate";
import { mapWorkeraEmployee } from "./mappers/employee";
import { mapWorkeraAttendance } from "./mappers/attendance";
import { mapWorkeraAbsence } from "./mappers/absence";

/**
 * Cliente de desarrollo/test con datos 100% ficticios. Implementa la misma
 * interfaz `WorkeraClient` que usará el futuro `HttpWorkeraClient` (Fase 5)
 * — el resto de la aplicación no puede distinguir cuál está activo.
 *
 * Los payloads ficticios pasan por el mismo pipeline schema -> mapper que
 * usaría un cliente real (no se construyen los `Normalized*` a mano),
 * para que este mock también sirva como prueba end-to-end del pipeline.
 *
 * Prefijo "MOCK_" en nombres de grupo/estado: son etiquetas inventadas para
 * este mock, nunca una hipótesis de cómo se llaman realmente en Workera
 * (ver types/employee-group.ts, types/attendance-status.ts).
 */

const MOCK_GROUP_MAPPING: EmployeeGroupMappingTable = Object.freeze({
  MOCK_PRODUCTION: "PRODUCTION",
  MOCK_INSTALLATION: "INSTALLATION",
  MOCK_ADMINISTRATION: "ADMINISTRATION",
});

const MOCK_ABSENCE_TYPE_MAPPING: AbsenceTypeMappingTable = Object.freeze({
  MOCK_VACATION: "VACATION",
  MOCK_MEDICAL_LEAVE: "MEDICAL_LEAVE",
  MOCK_MUTUAL: "MUTUAL",
});

// Fechas ficticias de referencia — no representan un calendario real, solo
// necesitan ser internamente consistentes para poder filtrar por rango.
const WEEKDAY = "2026-08-10";
const SATURDAY = "2026-08-15";

const MOCK_EMPLOYEES: readonly RawWorkeraEmployee[] = [
  { id: "MOCK-001", rut: "11111111-1", first_name: "Sebastián", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-002", rut: "22222222-2", first_name: "Juan", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-003", rut: "33333333-3", first_name: "María", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-004", rut: "44444444-4", first_name: "Pedro", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-005", rut: "55555555-5", first_name: "Andrea", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-006", rut: "66666666-6", first_name: "Carla", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-007", rut: "77777777-7", first_name: "Diego", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-008", rut: "88888888-8", first_name: "Fernanda", last_name: "Demo", active: true, group: "MOCK_PRODUCTION" },
  { id: "MOCK-009", rut: "99999999-9", first_name: "Ignacio", last_name: "Demo", active: true, group: "MOCK_INSTALLATION" },
  { id: "MOCK-010", rut: "10101010-1", first_name: "Rosa", last_name: "Demo", active: true, group: "MOCK_ADMINISTRATION" },
  // Grupo externo que no existe en MOCK_GROUP_MAPPING a propósito, para
  // ejercitar el camino UNMAPPED (sección 10 del encargo).
  { id: "MOCK-011", rut: "12121212-1", first_name: "Grupo", last_name: "Desconocido", active: true, group: "MOCK_GRUPO_FANTASMA" },
];

const MOCK_ATTENDANCE: readonly RawWorkeraAttendanceRecord[] = [
  // Normal.
  { employee_id: "MOCK-001", date: WEEKDAY, clock_in: `${WEEKDAY}T07:28:00-04:00`, clock_out: `${WEEKDAY}T17:00:00-04:00`, record_id: "ATT-001" },
  // Atraso.
  { employee_id: "MOCK-002", date: WEEKDAY, clock_in: `${WEEKDAY}T07:43:00-04:00`, clock_out: `${WEEKDAY}T17:00:00-04:00`, record_id: "ATT-002" },
  // Candidato a horas extra.
  { employee_id: "MOCK-003", date: WEEKDAY, clock_in: `${WEEKDAY}T07:30:00-04:00`, clock_out: `${WEEKDAY}T18:00:00-04:00`, record_id: "ATT-003" },
  // Horas extra al tope (permanece en instalaciones más allá del margen habitual).
  { employee_id: "MOCK-004", date: WEEKDAY, clock_in: `${WEEKDAY}T07:30:00-04:00`, clock_out: `${WEEKDAY}T19:45:00-04:00`, record_id: "ATT-004" },
  // Marcación faltante — clock_out null se conserva como null, nunca se inventa.
  { employee_id: "MOCK-005", date: WEEKDAY, clock_in: `${WEEKDAY}T07:31:00-04:00`, clock_out: null, record_id: "ATT-005" },
  // Instalación, registro de fin de semana.
  { employee_id: "MOCK-009", date: SATURDAY, clock_in: `${SATURDAY}T08:00:00-04:00`, clock_out: `${SATURDAY}T14:00:00-04:00`, record_id: "ATT-009" },
  // Código de estado diario reconocido (presente) y uno no reconocido, para
  // ejercitar el mapper de attendance-status por separado.
  { employee_id: "MOCK-001", date: WEEKDAY, clock_in: `${WEEKDAY}T07:28:00-04:00`, clock_out: `${WEEKDAY}T17:00:00-04:00`, record_id: "ATT-001-STATUS", status_code: "MOCK_P" },
  { employee_id: "MOCK-002", date: WEEKDAY, clock_in: `${WEEKDAY}T07:43:00-04:00`, clock_out: `${WEEKDAY}T17:00:00-04:00`, record_id: "ATT-002-STATUS", status_code: "CODIGO_NO_RECONOCIDO" },
];

const MOCK_ABSENCES: readonly RawWorkeraAbsenceRecord[] = [
  { employee_id: "MOCK-006", type: "MOCK_VACATION", start_date: WEEKDAY, end_date: WEEKDAY, record_id: "ABS-006" },
  { employee_id: "MOCK-007", type: "MOCK_MEDICAL_LEAVE", start_date: WEEKDAY, end_date: WEEKDAY, record_id: "ABS-007" },
  { employee_id: "MOCK-008", type: "MOCK_MUTUAL", start_date: WEEKDAY, end_date: WEEKDAY, record_id: "ABS-008" },
  // Tipo externo no reconocido, para ejercitar UNKNOWN_EXTERNAL_STATUS.
  { employee_id: "MOCK-010", type: "TIPO_NO_RECONOCIDO", start_date: WEEKDAY, end_date: WEEKDAY, record_id: "ABS-010" },
];

export class MockWorkeraClient implements WorkeraClient {
  async getEmployees(options?: WorkeraListOptions): Promise<WorkeraListResult<NormalizedEmployee>> {
    // El mock siempre devuelve el set completo (sin paginación real) —
    // options se acepta para cumplir la interfaz pero no se usa todavía.
    void options;

    const items = MOCK_EMPLOYEES.map((employee) => {
      const validated = validateWorkeraPayload(rawWorkeraEmployeeSchema, employee, {
        operation: "getEmployees",
      });
      return mapWorkeraEmployee(validated, { groupMapping: MOCK_GROUP_MAPPING });
    });

    return { items, nextPageToken: null };
  }

  async getAttendance(params: GetAttendanceParams): Promise<WorkeraListResult<NormalizedAttendance>> {
    const inRange = MOCK_ATTENDANCE.filter(
      (record) => record.date >= params.range.from && record.date <= params.range.to
    );

    const items = inRange.map((record) => {
      const validated = validateWorkeraPayload(rawWorkeraAttendanceRecordSchema, record, {
        operation: "getAttendance",
      });
      return mapWorkeraAttendance(validated);
    });

    return { items, nextPageToken: null };
  }

  async getAbsences(params: GetAbsencesParams): Promise<WorkeraListResult<NormalizedAbsence>> {
    const inRange = MOCK_ABSENCES.filter(
      (record) => record.start_date <= params.range.to && record.end_date >= params.range.from
    );

    const items = inRange.map((record) => {
      const validated = validateWorkeraPayload(rawWorkeraAbsenceRecordSchema, record, {
        operation: "getAbsences",
      });
      return mapWorkeraAbsence(validated, { typeMapping: MOCK_ABSENCE_TYPE_MAPPING });
    });

    return { items, nextPageToken: null };
  }
}
