import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { CallerRole, DailyReviewResult } from "../business-rules/daily-review";

/**
 * Scoping de área compartido por la capa de UI (Fase 8). Reutiliza el mismo
 * tipo `CallerRole` que `daily-review.ts` (Fase 7) para no duplicar el
 * vocabulario de roles, pero NO modifica ni reimplementa las reglas de
 * negocio de Fase 7 -- este módulo es nuevo, solo para las pantallas que
 * necesitan aplicar el mismo criterio de scoping fuera de `getDailyReview`
 * (ej. el detalle de un trabajador, el roster de empleados).
 *
 * Igual que en `daily-review.ts`: el scoping se aplica en ESTE código, no
 * solo confiado a RLS -- las policies SELECT de las tablas subyacentes son
 * amplias (`is_corporate_user()`), así que un supervisor de Producción
 * técnicamente PUEDE leer filas de Instalación a nivel de fila individual;
 * lo que le impide navegar/operar fuera de su área es este chequeo explícito
 * en cada servicio de lectura orientado a UI.
 */

export type { CallerRole };
export type AreaCode = DailyReviewResult["groupCode"];

export class AreaAccessError extends Error {}

const ALL_AREAS: AreaCode[] = ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"];

/** Áreas que el rol puede navegar/consultar -- misma jerarquía que `daily-review.ts`. */
export function areasVisibleToRole(callerRole: CallerRole): AreaCode[] {
  if (callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH") return ALL_AREAS;
  if (callerRole === "SUPERVISOR_PRODUCTION") return ["PRODUCTION"];
  return ["INSTALLATION"];
}

export function assertAreaAccessAllowed(callerRole: CallerRole, areaCode: AreaCode): void {
  if (!areasVisibleToRole(callerRole).includes(areaCode)) {
    throw new AreaAccessError(`El rol ${callerRole} no puede acceder al área ${areaCode}.`);
  }
}

/**
 * Resuelve el área real de un empleado y valida que el rol pueda acceder a
 * ella. Necesario para cualquier pantalla que reciba un `employeeId`
 * directamente (ej. detalle de revisión) en vez de solo un `groupCode` ya
 * validado -- de lo contrario un supervisor podría pedir el detalle de un
 * empleado de otra área simplemente conociendo su id.
 */
export async function assertEmployeeAccessAllowed(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  employeeId: string
): Promise<AreaCode> {
  const { data, error } = await supabase
    .from("employees")
    .select("employee_groups!employees_company_group_fkey(code)")
    .eq("id", employeeId)
    .single();
  if (error || !data) {
    throw new Error(`assertEmployeeAccessAllowed: empleado no encontrado (${employeeId}).`);
  }

  const groupRelation = data.employee_groups as { code: string } | { code: string }[] | null;
  const areaCode = (Array.isArray(groupRelation) ? groupRelation[0]?.code : groupRelation?.code) as AreaCode | undefined;
  if (!areaCode) {
    throw new AreaAccessError("El empleado no tiene área asignada -- no se puede evaluar acceso.");
  }
  assertAreaAccessAllowed(callerRole, areaCode);
  return areaCode;
}
