import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../shared/workforce-constants";

export { ARCOTEX_WORKFORCE_COMPANY_ID };

export interface LegacyWorkforceMembership {
  companyId: string;
  legacyRole: string | null;
  workspaceEnabled: boolean;
}

/**
 * El slug es mutable y sirve solo para URLs. La autorización laboral exige
 * que la empresa tenga el workspace habilitado y un rol legacy asignado; el
 * UUID concreto se vuelve a comprobar contra la membresía en cada petición.
 */
export function hasLegacyWorkforceWorkspace(
  membership: LegacyWorkforceMembership
): boolean {
  return membership.workspaceEnabled
    && membership.legacyRole !== null;
}
