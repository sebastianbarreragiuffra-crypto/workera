import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  authorizedRosterForCompany,
  canonicalRosterSha256,
} from "./arcotex-authorized-roster";

export interface ArcotexAuthorizedEmployeeReference {
  readonly id: string;
  readonly externalWorkeraId: string;
}

export interface ArcotexAuthorizedEmployeeScope {
  readonly employeeIds: readonly string[];
  readonly employees: readonly ArcotexAuthorizedEmployeeReference[];
}

/**
 * Resuelve el alcance operacional cerrado de ARCOTEX con el mismo cliente de
 * datos del consumidor. Para las demás empresas no cambia el alcance. En
 * ARCOTEX falla cerrado si falta una ficha, pertenece a otra empresa, no tiene
 * un código Workera único o la huella ya no coincide con el XLS autorizado.
 */
export async function resolveArcotexAuthorizedEmployeeScope(
  supabase: SupabaseClient<Database>,
  companyId: string,
): Promise<ArcotexAuthorizedEmployeeScope | undefined> {
  const normalizedCompanyId = companyId.trim();
  const roster = authorizedRosterForCompany(normalizedCompanyId, process.env.ARCOTEX_PILOT_EMPLOYEE_IDS);
  if (!roster) return undefined;

  const { data, error } = await supabase
    .from("employees")
    .select("id, external_workera_id")
    .eq("company_id", normalizedCompanyId)
    .in("id", [...roster.employeeIds]);
  if (error) {
    throw new Error("No se pudo comprobar el padrón autorizado de ARCOTEX.");
  }

  const employees = (data ?? []).map((row) => ({
    id: String(row.id ?? "").trim(),
    externalWorkeraId: String(row.external_workera_id ?? "").trim(),
  }));
  const returnedIds = new Set(employees.map((employee) => employee.id));
  const externalWorkeraIds = employees.map((employee) => employee.externalWorkeraId);
  if (
    employees.length !== roster.employeeCount
    || returnedIds.size !== roster.employeeCount
    || roster.employeeIds.some((id) => !returnedIds.has(id))
    || externalWorkeraIds.some((code) => code.length === 0)
    || new Set(externalWorkeraIds).size !== roster.employeeCount
    || canonicalRosterSha256(externalWorkeraIds) !== roster.expectedEmployeeCodeSha256
  ) {
    throw new Error("El padrón autorizado de ARCOTEX no coincide con las 45 fichas aprobadas.");
  }

  return {
    employeeIds: [...roster.employeeIds],
    employees: employees.sort((left, right) => left.id.localeCompare(right.id)),
  };
}
