/**
 * Roster completo de empleados (GET /employee, confirmado Pre-Fase-8) --
 * distinto del sub-objeto reducido `employee` embebido en attendanceData
 * (Fase 5C/6A). Ver schemas/employee-roster.ts para el contrato real
 * completo; este archivo define únicamente el DTO NORMALIZADO -- deliberada
 * y drásticamente más chico que la respuesta cruda, por minimización de
 * datos (nunca RUT/fecha de nacimiento/teléfono/correo/dirección/estado
 * civil/género/nacionalidad, aunque la API los entregue).
 */
export interface NormalizedWorkeraEmployeeRosterEntry {
  /** Identificador estable de Workera -- mismo espacio de valores que `employee.code` en attendanceData / `employees.external_workera_id`. */
  code: string;
  firstName: string | null;
  lastName: string | null;
  employeeStatus: string | null;
  branchOfficeCode: string | null;
  departmentCode: string | null;
}

export interface NormalizedWorkeraEmployeeRosterPage {
  page: number;
  totalPages: number;
  pageResult: number;
  totalResult: number;
  employees: NormalizedWorkeraEmployeeRosterEntry[];
}
