import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Resuelve el grupo que regía en la fecha calculada. El caché
 * `employees.employee_group_id` describe hoy y no puede usarse al reprocesar
 * historia: hacerlo aplicaría políticas actuales a una pre-nómina pasada.
 */
export async function resolveEffectiveEmployeeGroup(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  companyId: string
): Promise<{ id: string; code: string }> {
  const { data, error } = await supabase
    .from("employee_group_assignments")
    .select("employee_group_id, employee_groups!inner(code, company_id), employees!inner(company_id)")
    .eq("employee_id", employeeId)
    .eq("employee_groups.company_id", companyId)
    .eq("employees.company_id", companyId)
    .lte("effective_from", workDate)
    .or(`effective_to.is.null,effective_to.gte.${workDate}`)
    .maybeSingle();

  const relation = data?.employee_groups as { code: string } | { code: string }[] | null | undefined;
  const code = Array.isArray(relation) ? relation[0]?.code : relation?.code;
  if (error || !data?.employee_group_id || !code) {
    throw new Error(
      `resolveEffectiveEmployeeGroup: no existe un grupo histórico único del tenant para trabajador/fecha: ${error?.message ?? "sin asignación"}`
    );
  }
  return { id: data.employee_group_id, code };
}
