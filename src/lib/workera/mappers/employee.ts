import type { RawWorkeraEmployee } from "../types/raw";
import type { NormalizedEmployee } from "../types/normalized";
import type { EmployeeGroupMappingTable } from "../types/employee-group";
import { mapEmployeeGroup } from "./employee-group";

export interface MapEmployeeOptions {
  groupMapping: EmployeeGroupMappingTable;
}

/**
 * raw (ya validado por schemas/employee.ts) -> NormalizedEmployee. Asume
 * que `raw` cumple el schema — no vuelve a validar tipos, solo aplica
 * reglas de normalización (valores por defecto, mapping de grupo).
 */
export function mapWorkeraEmployee(
  raw: RawWorkeraEmployee,
  options: MapEmployeeOptions
): NormalizedEmployee {
  const firstName = raw.first_name ?? null;
  const lastName = raw.last_name ?? null;
  const composedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const displayName = raw.full_name?.trim() || composedName || raw.id;

  return {
    externalId: raw.id,
    rut: raw.rut ?? null,
    firstName,
    lastName,
    displayName,
    // Workera no siempre indicará explícitamente el estado activo; ante
    // ausencia del campo se asume activo (no se descarta un trabajador real
    // por un campo faltante) — decisión documentada, revisable en Fase 5.
    active: raw.active ?? true,
    externalGroup: raw.group ?? null,
    employeeGroup: mapEmployeeGroup(raw.group ?? null, options.groupMapping),
  };
}
