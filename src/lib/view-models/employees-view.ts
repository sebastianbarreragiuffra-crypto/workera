import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveTimeControlPolicy } from "../business-rules/schedule";
import { areasVisibleToRole, assertAreaAccessAllowed, type AreaCode, type CallerRole } from "../access/scope";

/**
 * Roster de empleados (Fase 8, PASO 7). Nunca expone RUT ni ningún otro
 * dato personal más allá de nombre/área/estado/control horario -- aunque
 * `GET /employee` (Fase Pre-8) sí trae RUT/fecha de nacimiento/teléfono/
 * dirección, esos campos nunca se persisten en `employees` (columna `rut`
 * existe pero nunca se puebla, decisión de minimización de datos desde
 * Fase 6A) ni se leen aquí aunque existieran.
 */

export interface EmployeeRosterEntry {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode | null;
  active: boolean;
  timeControl: "NORMAL" | "EXEMPT";
}

export interface EmployeeRosterFilter {
  areaCode?: AreaCode;
  activeOnly?: boolean;
  search?: string;
}

export async function getEmployeeRoster(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  filter: EmployeeRosterFilter,
  today: string
): Promise<EmployeeRosterEntry[]> {
  const allowedAreas = areasVisibleToRole(callerRole);
  if (filter.areaCode) assertAreaAccessAllowed(callerRole, filter.areaCode);

  let query = supabase.from("employees").select("id, display_name, active, employee_groups(code)").order("display_name");

  if (filter.activeOnly) query = query.eq("active", true);
  if (filter.search) query = query.ilike("display_name", `%${filter.search}%`);

  const { data, error } = await query;
  if (error) throw new Error(`getEmployeeRoster: fallo listando employees: ${error.message}`);

  const rows = (data ?? [])
    .map((row) => {
      const groupRelation = row.employee_groups as { code: string } | { code: string }[] | null;
      const areaCode = (Array.isArray(groupRelation) ? groupRelation[0]?.code : groupRelation?.code) as AreaCode | undefined;
      return { row, areaCode: areaCode ?? null };
    })
    .filter(({ areaCode }) => {
      if (filter.areaCode) return areaCode === filter.areaCode;
      // Sin filtro explícito: un supervisor solo ve su(s) área(s) visible(s); RRHH/SUPER_ADMIN ven todo (incluye sin área asignada).
      if (allowedAreas.length === 3) return true;
      return areaCode !== null && allowedAreas.includes(areaCode);
    });

  const entries = await Promise.all(
    rows.map(async ({ row, areaCode }) => {
      const policy = await resolveTimeControlPolicy(supabase, row.id, today);
      return {
        employeeId: row.id,
        displayName: row.display_name,
        areaCode,
        active: row.active,
        timeControl: policy.code === "EXEMPT_FROM_TIME_CONTROL" ? ("EXEMPT" as const) : ("NORMAL" as const),
      };
    })
  );

  return entries;
}
