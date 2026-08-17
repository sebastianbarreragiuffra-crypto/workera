import type { EmployeeGroupMappingResult } from "../types/normalized";
import type { EmployeeGroupMappingTable } from "../types/employee-group";

/**
 * Mapea el nombre de grupo tal como lo entrega Workera hacia nuestro
 * EmployeeGroupCode, usando una tabla inyectada (nunca hardcodeada — ver
 * types/employee-group.ts). Sin entrada en la tabla => UNMAPPED, nunca una
 * asignación por defecto o adivinada (sección 10 del encargo: "la futura
 * sincronización deberá generar revisión/error en vez de asignar
 * aleatoriamente").
 */
export function mapEmployeeGroup(
  externalGroup: string | null,
  mapping: EmployeeGroupMappingTable
): EmployeeGroupMappingResult {
  if (externalGroup === null) {
    return { status: "UNMAPPED", externalGroup: null };
  }

  const mapped = mapping[externalGroup];
  if (mapped === undefined) {
    return { status: "UNMAPPED", externalGroup };
  }

  return { status: "MAPPED", group: mapped };
}
