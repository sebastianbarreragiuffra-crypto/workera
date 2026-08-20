import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { HttpWorkeraClient } from "../workera/http-client";
import { normalizeName } from "./name-matching";

/**
 * Reconciliación del roster de empleados (Pre-Fase-8, extendida en la fase
 * de "roster bootstrap" -- ver `personnel-roster-import.ts`). Resuelve el
 * hallazgo de Fase 7: un trabajador que nunca genera eventos de asistencia
 * (exento de marcación) nunca aparece vía `workera_attendance_events`/
 * `syncWorkeraAttendance` -- ahora se usa `GET /employee` (roster completo,
 * confirmado real en esta fase) para completar `employees` antes de volver
 * a intentar resolver esos casos.
 *
 * Jerarquía de matching (orden de prioridad, nunca fuzzy):
 *   1. `employees.external_workera_id` ya existente (coincide con
 *      `roster.code` -- mismo espacio de identificador que
 *      `employee.code` de attendanceData).
 *   2. Un empleado `source='excel_roster'` (bootstrap administrativo, ver
 *      `personnel-roster-import.ts`) SIN vínculo real a Workera todavía,
 *      con nombre completo EXACTO normalizado -- se "promueve" (se le
 *      asigna el `external_workera_id` real y pasa a `source='workera'`,
 *      la fuente de mayor confianza) EN VEZ de crear una fila duplicada.
 *      Límite real documentado: `GET /employee` no expone RUT a esta capa
 *      (`mapWorkeraEmployeeRosterEntry` lo descarta deliberadamente, misma
 *      decisión de minimización de datos Pre-Fase-8) -- si lo expusiera,
 *      la promoción podría hacerse por RUT (igual de alta confianza que en
 *      el bootstrap de Excel) en vez de depender del nombre exacto. Esto
 *      queda documentado como una decisión de negocio pendiente de
 *      confirmar (ver reporte de la fase de roster bootstrap), no una
 *      limitación técnica que se pueda resolver aquí sin esa decisión.
 *   3. Si el nombre coincide con MÁS DE UN empleado `excel_roster` sin
 *      vincular -> NUNCA se elige uno al azar. Se crea una fila nueva (para
 *      no perder al empleado real de Workera) y se reporta en
 *      `reconciliationRequired` para revisión manual -- puede que dos
 *      personas Excel compartan nombre, o que una de ellas sea en realidad
 *      un duplicado a fusionar manualmente.
 *   4. Si nada de lo anterior resuelve de forma única -> se bootstrapea una
 *      fila nueva `source='workera'` (comportamiento histórico, sin
 *      cambios) -- nunca se adivina ni se crea un empleado ficticio.
 */

export interface RosterReconciliationRequired {
  rosterCode: string;
  matchedNames: string[];
}

export interface BootstrapRosterResult {
  totalRosterEmployees: number;
  alreadyExisting: number;
  newlyBootstrapped: number;
  promotedFromExcelRoster: number;
  reconciliationRequired: RosterReconciliationRequired[];
}

/**
 * Trae el roster COMPLETO (todas las páginas, GET /employee sin filtrar) y
 * concilia contra `employees`: código ya existente -> sin cambios; nombre
 * exacto coincide con UN empleado `excel_roster` sin vincular -> promueve
 * (nunca duplica); si no -> bootstrapea fila nueva. Mismo criterio de
 * minimización de Fase 6A/Pre-8: solo external_workera_id/first_name/
 * last_name/display_name -- nunca RUT/fecha de nacimiento/teléfono/correo/
 * dirección, aunque el roster los entregara.
 */
export async function bootstrapEmployeesFromRoster(
  supabase: SupabaseClient<Database>,
  workeraClient: HttpWorkeraClient
): Promise<BootstrapRosterResult> {
  const { employees: roster } = await workeraClient.getAllEmployeeRoster();

  const { data: existing, error: existingError } = await supabase
    .from("employees")
    .select("id, external_workera_id, source, first_name, last_name");
  if (existingError) {
    throw new Error(`bootstrapEmployeesFromRoster: fallo consultando employees existentes: ${existingError.message}`);
  }

  const existingCodes = new Set((existing ?? []).map((e) => e.external_workera_id));
  const excelUnlinked = (existing ?? []).filter((e) => e.source === "excel_roster");

  const seenInThisBatch = new Set<string>();
  const toInsert: { external_workera_id: string; first_name: string; last_name: string; display_name: string; source: string }[] = [];
  const reconciliationRequired: RosterReconciliationRequired[] = [];
  let alreadyExisting = 0;
  let promotedFromExcelRoster = 0;

  for (const entry of roster) {
    if (existingCodes.has(entry.code) || seenInThisBatch.has(entry.code)) {
      alreadyExisting += 1;
      continue;
    }
    seenInThisBatch.add(entry.code);

    const firstName = entry.firstName?.trim() || "(sin nombre Workera)";
    const lastName = entry.lastName?.trim() || "(sin apellido Workera)";
    const candidateName = normalizeName(`${firstName} ${lastName}`);
    const nameMatches = excelUnlinked.filter((e) => normalizeName(`${e.first_name} ${e.last_name}`) === candidateName);

    if (nameMatches.length === 1) {
      const { error: promoteError } = await supabase
        .from("employees")
        .update({ external_workera_id: entry.code, source: "workera" })
        .eq("id", nameMatches[0].id);
      if (promoteError) {
        throw new Error(`bootstrapEmployeesFromRoster: fallo promoviendo empleado ${entry.code}: ${promoteError.message}`);
      }
      promotedFromExcelRoster += 1;
      continue;
    }

    if (nameMatches.length > 1) {
      reconciliationRequired.push({ rosterCode: entry.code, matchedNames: nameMatches.map((m) => `${m.first_name} ${m.last_name}`) });
    }

    toInsert.push({
      external_workera_id: entry.code,
      first_name: firstName,
      last_name: lastName,
      display_name: `${firstName} ${lastName}`.trim(),
      source: "workera",
    });
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from("employees").insert(toInsert);
    if (insertError) {
      throw new Error(`bootstrapEmployeesFromRoster: fallo insertando empleados nuevos: ${insertError.message}`);
    }
  }

  return {
    totalRosterEmployees: roster.length,
    alreadyExisting,
    newlyBootstrapped: toInsert.length,
    promotedFromExcelRoster,
    reconciliationRequired,
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
 *
 * `sourceEquals` opcional -- usado por `bootstrapEmployeesFromRoster` para
 * acotar la búsqueda solo a empleados `excel_roster` sin vincular todavía
 * (nunca reconciliar contra alguien ya confirmado por Workera).
 */
export async function resolveEmployeeByFullName(
  supabase: SupabaseClient<Database>,
  fullName: string,
  options?: { sourceEquals?: string }
): Promise<ResolveEmployeeByFullNameResult> {
  let query = supabase.from("employees").select("id, first_name, last_name");
  if (options?.sourceEquals) query = query.eq("source", options.sourceEquals);
  const { data, error } = await query;
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
