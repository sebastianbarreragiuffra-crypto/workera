import { createHash } from "node:crypto";
import { postgresUuid } from "../shared/postgres-uuid";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_WORKFORCE_COMPANY_ID,
} from "../shared/workforce-constants";

export { ARCOTEX_AUTHORIZED_ROSTER_SIZE };

/**
 * Huella de los 45 códigos Workera del XLS autorizado por el usuario.
 * Los códigos no se versionan en claro; el exportador comprueba esta huella
 * después de resolver los UUID configurados contra el tenant ARCOTEX.
 */
export const ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256 =
  "7016f7cf445cb0ce65b20fa6a71646ed7a569ecc4382d318d46fff82cbd17c79";

export interface ArcotexAuthorizedRoster {
  employeeIds: readonly string[];
  employeeCount: typeof ARCOTEX_AUTHORIZED_ROSTER_SIZE;
  expectedEmployeeCodeSha256: typeof ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256;
}

export function canonicalRosterSha256(values: readonly string[]): string {
  return createHash("sha256")
    .update(values.map((value) => value.trim()).sort().join("\n"))
    .digest("hex");
}

/**
 * Convierte la configuración operacional del piloto en un conjunto cerrado.
 * Los IDs provienen del reporte de conciliación aprobado; nunca del navegador.
 */
export function requireArcotexAuthorizedRoster(value: string | undefined): ArcotexAuthorizedRoster {
  if (value === undefined || value.trim() === "") {
    throw new Error("Falta ARCOTEX_PILOT_EMPLOYEE_IDS; las planillas de Arcotex permanecen bloqueadas.");
  }

  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  const uniqueIds = new Set(ids);
  if (ids.length !== ARCOTEX_AUTHORIZED_ROSTER_SIZE || uniqueIds.size !== ARCOTEX_AUTHORIZED_ROSTER_SIZE) {
    throw new Error(`ARCOTEX_PILOT_EMPLOYEE_IDS debe contener exactamente ${ARCOTEX_AUTHORIZED_ROSTER_SIZE} UUID únicos.`);
  }
  for (const id of uniqueIds) {
    if (!postgresUuid.safeParse(id).success) {
      throw new Error("ARCOTEX_PILOT_EMPLOYEE_IDS contiene un identificador inválido.");
    }
  }
  return {
    employeeIds: [...uniqueIds].sort(),
    employeeCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  };
}

/** Otros tenants conservan su alcance normal; ARCOTEX nunca cae al padrón completo. */
export function authorizedRosterForCompany(
  companyId: string,
  configuredEmployeeIds: string | undefined,
): ArcotexAuthorizedRoster | undefined {
  return companyId === ARCOTEX_WORKFORCE_COMPANY_ID
    ? requireArcotexAuthorizedRoster(configuredEmployeeIds)
    : undefined;
}
