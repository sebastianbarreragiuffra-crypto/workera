import type { CallerRole } from "../access/scope";

export type PayrollCompanyRole = CallerRole;

interface CompanyRoleClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

/**
 * Resuelve el rol laboral dentro de la empresa indicada. La etiqueta legacy
 * de profiles.role nunca basta para acceder a RUT, ajustes o archivos de
 * pre-nómina de un tenant.
 */
export async function resolvePayrollCompanyRole(
  client: CompanyRoleClient,
  companyId: string,
  allowed: readonly PayrollCompanyRole[],
): Promise<PayrollCompanyRole | null> {
  for (const role of allowed) {
    const result = await client.rpc("has_company_app_role", {
      p_company_id: companyId,
      p_role: role,
    });
    if (result.error) return null;
    if (result.data === true) return role;
  }
  return null;
}
