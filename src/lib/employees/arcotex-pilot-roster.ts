import { postgresUuid } from "../shared/postgres-uuid";

export const ARCOTEX_PILOT_ROSTER_SIZE = 60;

/**
 * Convierte la configuración operacional del piloto en un conjunto cerrado.
 * Los IDs provienen del reporte de conciliación aprobado; nunca del navegador.
 */
export function requireArcotexPilotEmployeeIds(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new Error("Falta ARCOTEX_PILOT_EMPLOYEE_IDS; la exportación Arcotex permanece bloqueada.");
  }

  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  const uniqueIds = new Set(ids);
  if (ids.length !== ARCOTEX_PILOT_ROSTER_SIZE || uniqueIds.size !== ARCOTEX_PILOT_ROSTER_SIZE) {
    throw new Error(`ARCOTEX_PILOT_EMPLOYEE_IDS debe contener exactamente ${ARCOTEX_PILOT_ROSTER_SIZE} UUID únicos.`);
  }
  for (const id of uniqueIds) {
    if (!postgresUuid.safeParse(id).success) {
      throw new Error("ARCOTEX_PILOT_EMPLOYEE_IDS contiene un identificador inválido.");
    }
  }
  return [...uniqueIds];
}
