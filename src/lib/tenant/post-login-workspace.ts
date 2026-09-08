import type { ActiveCompanyResolution } from "./resolve-active-company";
import { hasLegacyWorkforceWorkspace } from "./legacy-workforce";

export interface WorkspaceDestinationInput {
  hasPlatformMembership: boolean;
  legacyProfileRole: string | null;
  companies: ActiveCompanyResolution;
  expenseCompanyIds: ReadonlySet<string>;
}

/**
 * Precedencia única del inicio autenticado. Un usuario multiempresa siempre
 * elige tenant; un workspace laboral solo gana cuando es su única empresa.
 */
export function resolveWorkspaceDestination(input: WorkspaceDestinationInput): string {
  if (input.hasPlatformMembership) return "/plataforma";
  if (input.companies.kind === "MULTIPLE") return "/empresas";
  if (input.companies.kind === "NONE") return "/acceso-pendiente";

  const company = input.companies.membership;
  if (company.status === "ACTIVE" && hasLegacyWorkforceWorkspace(company)) {
    return "/dashboard";
  }
  if (input.expenseCompanyIds.has(company.companyId)) {
    return `/empresas/${company.companySlug}/rendiciones`;
  }
  return `/empresas/${company.companySlug}`;
}
