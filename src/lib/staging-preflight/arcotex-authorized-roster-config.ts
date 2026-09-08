import "server-only";

import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_WORKFORCE_COMPANY_ID,
} from "../shared/workforce-constants";
import { createAdminClient } from "../supabase/admin-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArcotexRosterPreviewEmployee {
  id: string;
  externalWorkeraId: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  active: boolean;
}

/** Consulta exclusivamente las fichas ya existentes; nunca crea, edita ni desactiva personas. */
export async function resolveArcotexAuthorizedEmployeeIds(
  externalWorkeraIds: readonly string[],
): Promise<string[]> {
  if (
    externalWorkeraIds.length !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || new Set(externalWorkeraIds).size !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
  ) {
    throw new Error(`Se requieren exactamente ${ARCOTEX_AUTHORIZED_ROSTER_SIZE} códigos Workera únicos.`);
  }

  const supabase = createAdminClient("arcotex-authorized-roster-config");
  const { data, error } = await supabase
    .from("employees")
    .select("id, external_workera_id")
    .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
    .in("external_workera_id", [...externalWorkeraIds]);
  if (error) throw new Error("No se pudo comprobar el padrón autorizado de ARCOTEX en staging.");

  const rows = data ?? [];
  const employeeIds = rows.map((row) => String(row.id ?? "").trim());
  const matchedCodes = rows.map((row) => String(row.external_workera_id ?? "").trim());
  if (
    rows.length !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || new Set(employeeIds).size !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || new Set(matchedCodes).size !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || employeeIds.some((id) => !UUID_PATTERN.test(id))
    || matchedCodes.some((code) => !externalWorkeraIds.includes(code))
  ) {
    throw new Error("Las 45 personas autorizadas no resolvieron de forma unívoca en staging.");
  }
  return employeeIds.sort();
}

/** Lectura fija de ARCOTEX para conciliar el archivo fuente, sin mutaciones. */
export async function readArcotexExistingEmployeesForRosterPreview(): Promise<ArcotexRosterPreviewEmployee[]> {
  const supabase = createAdminClient("arcotex-authorized-roster-config");
  const { data, error } = await supabase
    .from("employees")
    .select("id, external_workera_id, display_name, first_name, last_name, active")
    .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
    .order("id");
  if (error) throw new Error("No se pudo leer el padrón actual de ARCOTEX en staging.");

  return (data ?? []).map((employee) => ({
    id: employee.id,
    externalWorkeraId: employee.external_workera_id,
    displayName: employee.display_name,
    firstName: employee.first_name,
    lastName: employee.last_name,
    active: employee.active,
  }));
}
