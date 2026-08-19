import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { HttpWorkeraClient } from "../workera/http-client";
import { normalizeName } from "./name-matching";

/**
 * Reconciliación del roster de empleados (Pre-Fase-8). Resuelve el hallazgo
 * de Fase 7: un trabajador que nunca genera eventos de asistencia (exento
 * de marcación) nunca aparece vía `workera_attendance_events`/
 * `syncWorkeraAttendance` -- ahora se usa `GET /employee` (roster completo,
 * confirmado real en esta fase) para completar `employees` antes de volver
 * a intentar resolver esos casos.
 *
 * Jerarquía de matching (orden de prioridad, nunca fuzzy):
 *   1. `employees.external_workera_id` ya existente (coincide con
 *      `roster.code` -- mismo espacio de identificador que
 *      `employee.code` de attendanceData).
 *   2. `roster.code` en sí mismo -- es el identificador estable de Workera;
 *      si no hay una fila existente con ese código, se bootstrapea una
 *      nueva (mínima, nunca sobrescribe).
 *   3. Nombre completo EXACTO normalizado (mayúsculas + espacios
 *      colapsados + sin acentos) -- solo para reconciliar contra fuentes
 *      SIN código Workera (ej. el Excel de cumpleaños). Nunca ILIKE
 *      parcial, nunca "se parece".
 *   4. Si nada de lo anterior resuelve de forma única -> MANUAL_REVIEW_REQUIRED,
 *      nunca se adivina ni se crea un empleado ficticio.
 */

export interface BootstrapRosterResult {
  totalRosterEmployees: number;
  alreadyExisting: number;
  newlyBootstrapped: number;
}

/**
 * Trae el roster COMPLETO (todas las páginas, GET /employee sin filtrar) y
 * hace upsert-por-código en `employees`: SOLO crea filas para códigos que
 * no existen todavía -- un empleado ya existente (bootstrapeado antes vía
 * eventos de asistencia, Fase 6A) nunca se sobrescribe. Mismo criterio de
 * minimización que Fase 6A: solo external_workera_id/first_name/last_name/
 * display_name -- nunca RUT/fecha de nacimiento/teléfono/correo/dirección,
 * aunque el roster los entregue.
 */
export async function bootstrapEmployeesFromRoster(
  supabase: SupabaseClient<Database>,
  workeraClient: HttpWorkeraClient
): Promise<BootstrapRosterResult> {
  const { employees: roster } = await workeraClient.getAllEmployeeRoster();

  const { data: existing, error: existingError } = await supabase.from("employees").select("external_workera_id");
  if (existingError) {
    throw new Error(`bootstrapEmployeesFromRoster: fallo consultando employees existentes: ${existingError.message}`);
  }
  const existingCodes = new Set((existing ?? []).map((e) => e.external_workera_id));

  const seenInThisBatch = new Set<string>();
  const toInsert = roster
    .filter((entry) => {
      if (existingCodes.has(entry.code) || seenInThisBatch.has(entry.code)) return false;
      seenInThisBatch.add(entry.code);
      return true;
    })
    .map((entry) => {
      const firstName = entry.firstName?.trim() || "(sin nombre Workera)";
      const lastName = entry.lastName?.trim() || "(sin apellido Workera)";
      return {
        external_workera_id: entry.code,
        first_name: firstName,
        last_name: lastName,
        display_name: `${firstName} ${lastName}`.trim(),
      };
    });

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from("employees").insert(toInsert);
    if (insertError) {
      throw new Error(`bootstrapEmployeesFromRoster: fallo insertando empleados nuevos: ${insertError.message}`);
    }
  }

  return {
    totalRosterEmployees: roster.length,
    alreadyExisting: roster.length - toInsert.length,
    newlyBootstrapped: toInsert.length,
  };
}

export interface ResolveEmployeeByFullNameResult {
  resolved: boolean;
  employeeId: string | null;
  matchCount: number;
}

/**
 * Match EXACTO por nombre completo normalizado (nunca separado en
 * first/last -- el roster puede traer nombre/segundo-nombre y
 * apellido/segundo-apellido en combinaciones no siempre predecibles desde
 * afuera; comparar el nombre completo concatenado evita asumir dónde cae el
 * límite entre "nombre" y "apellido"). Si no hay EXACTAMENTE una
 * coincidencia, se reporta sin resolver -- nunca se adivina.
 */
export async function resolveEmployeeByFullName(
  supabase: SupabaseClient<Database>,
  fullName: string
): Promise<ResolveEmployeeByFullNameResult> {
  const { data, error } = await supabase.from("employees").select("id, first_name, last_name");
  if (error) {
    throw new Error(`resolveEmployeeByFullName: fallo consultando employees: ${error.message}`);
  }

  const target = normalizeName(fullName);
  const matches = (data ?? []).filter((e) => normalizeName(`${e.first_name} ${e.last_name}`) === target);

  if (matches.length !== 1) {
    return { resolved: false, employeeId: null, matchCount: matches.length };
  }
  return { resolved: true, employeeId: matches[0].id, matchCount: 1 };
}
