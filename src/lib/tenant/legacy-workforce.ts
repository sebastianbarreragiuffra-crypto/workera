import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../shared/workforce-constants";

export { ARCOTEX_WORKFORCE_COMPANY_ID };

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
