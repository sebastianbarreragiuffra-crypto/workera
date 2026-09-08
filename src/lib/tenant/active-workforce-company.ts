import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  resolveActiveCompany,
  type ActiveCompanyResolution,
  type CompanyMembershipSummary,
} from "./resolve-active-company";
import { hasLegacyWorkforceWorkspace } from "./legacy-workforce";

export const ACTIVE_WORKFORCE_COMPANY_COOKIE = "gestora_workforce_company";

export function isOperationalWorkforceMembership(
  membership: CompanyMembershipSummary,
): boolean {
  return membership.status === "ACTIVE" && hasLegacyWorkforceWorkspace(membership);
}

export function selectActiveWorkforceCompany(
  resolution: ActiveCompanyResolution,
  selectedCompanyId: string | null,
): CompanyMembershipSummary | null {
  const memberships = resolution.kind === "NONE"
    ? []
    : resolution.kind === "SINGLE"
      ? [resolution.membership]
      : resolution.memberships;
  const eligible = memberships.filter(isOperationalWorkforceMembership);
  const selected = selectedCompanyId
    ? eligible.find((membership) => membership.companyId === selectedCompanyId)
    : null;
  if (selected) return selected;
  return eligible.length === 1 ? eligible[0] : null;
}

/**
 * Construye la entrada al workspace solo cuando la sesión tiene una
 * membresía laboral operativa para la empresa pedida. El slug de la URL nunca
 * actúa como autorización: debe coincidir con una membresía que acaba de
 * devolver `resolveActiveCompany`, y el Route Handler de destino vuelve a
 * comprobar exactamente la misma condición antes de fijar la empresa activa.
 */
export function workforceEntryPathForCompany(
  resolution: ActiveCompanyResolution,
  requestedCompanySlug: string,
): string | null {
  const memberships = resolution.kind === "NONE"
    ? []
    : resolution.kind === "SINGLE"
      ? [resolution.membership]
      : resolution.memberships;
  const normalizedSlug = requestedCompanySlug.trim().toLowerCase();
  const membership = memberships.find((candidate) =>
    candidate.companySlug === normalizedSlug && isOperationalWorkforceMembership(candidate)
  );

  return membership
    ? `/empresas/${encodeURIComponent(membership.companySlug)}/personas`
    : null;
}

/**
 * Resuelve la empresa laboral elegida, pero vuelve a autorizarla contra las
 * membresías activas en cada petición. La cookie solo recuerda una selección;
 * nunca concede acceso por sí misma.
 */
export async function resolveActiveWorkforceCompany(
  supabase: SupabaseClient<Database>,
): Promise<CompanyMembershipSummary | null> {
  const [resolution, cookieStore] = await Promise.all([
    resolveActiveCompany(supabase),
    cookies(),
  ]);
  const selectedCompanyId = cookieStore.get(ACTIVE_WORKFORCE_COMPANY_COOKIE)?.value ?? null;
  return selectActiveWorkforceCompany(resolution, selectedCompanyId);
}
