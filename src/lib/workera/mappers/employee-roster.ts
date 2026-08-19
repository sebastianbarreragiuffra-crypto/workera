import type { RawWorkeraEmployeeRosterEntryParsed } from "../schemas/employee-roster";
import type { NormalizedWorkeraEmployeeRosterEntry } from "../types/employee-roster";

function joinNames(...parts: (string | null | undefined)[]): string | null {
  const joined = parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join(" ");
  return joined.length > 0 ? joined : null;
}

/**
 * raw (ya validado) -> DTO normalizado MÍNIMO. Descarta deliberadamente
 * `identification` (RUT), `birthDate`, `address`, `personalPhone`,
 * `personalMail`, `corporateMail`, `corporatePhone`, `civilStatus`,
 * `genre`, `nationality`, `comment` -- nunca llegan más allá de esta
 * función (minimización de datos, Pre-Fase-8).
 *
 * `firstName`/`lastName` combinan name+secondName / lastName+secondLastName
 * -- mismo criterio que ya produce el `name`/`lastName` embebido en
 * attendanceData (Fase 6A), para que el matching por nombre normalizado
 * compare manzanas con manzanas.
 */
export function mapWorkeraEmployeeRosterEntry(raw: RawWorkeraEmployeeRosterEntryParsed): NormalizedWorkeraEmployeeRosterEntry {
  return {
    code: raw.code,
    firstName: joinNames(raw.name, raw.secondName),
    lastName: joinNames(raw.lastName, raw.secondLastName),
    employeeStatus: raw.employeeStatus ?? null,
    branchOfficeCode: raw.branchOfficeCode ?? null,
    departmentCode: raw.departmentCode ?? null,
  };
}
