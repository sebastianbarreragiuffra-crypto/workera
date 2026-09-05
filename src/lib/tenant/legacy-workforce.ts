/** Identidad estable del único workspace laboral legacy habilitado en MT-3A. */
export const ARCOTEX_WORKFORCE_COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

export interface LegacyWorkforceMembership {
  companyId: string;
  legacyRole: string | null;
  workspaceEnabled: boolean;
}

/**
 * El slug es mutable y sirve solo para URLs. La autorización laboral se ata
 * al UUID sentinel que también protege el gate de base de datos.
 */
export function hasLegacyWorkforceWorkspace(
  membership: LegacyWorkforceMembership
): boolean {
  return membership.companyId === ARCOTEX_WORKFORCE_COMPANY_ID
    && membership.workspaceEnabled
    && membership.legacyRole !== null;
}
