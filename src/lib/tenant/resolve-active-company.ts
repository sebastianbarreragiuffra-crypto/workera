import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * GESTORA — resolver único de empresas accesibles para la sesión.
 *
 * auth.uid() -> membresías activas (en empresas activas) -> 0/1/N.
 *
 * Enumera la identidad tenant aunque el workspace laboral legacy esté
 * bloqueado. `workspaceEnabled` solo gobierna asistencia/RRHH; no determina
 * si la empresa existe ni si puede usar módulos independientes como gastos.
 * La selección nunca es autorización por sí sola: cada módulo vuelve a
 * validar membresía, permisos y estado mediante RLS/RPC.
 */

export interface CompanyMembershipSummary {
  companyId: string;
  companyName: string;
  companySlug: string;
  legacyRole: Database["public"]["Enums"]["app_role"] | null;
  status: Database["public"]["Enums"]["company_lifecycle_status"];
  workspaceEnabled: boolean;
}

export type ActiveCompanyResolution =
  | { kind: "NONE" }
  | { kind: "SINGLE"; membership: CompanyMembershipSummary }
  | { kind: "MULTIPLE"; memberships: CompanyMembershipSummary[] };

/**
 * Lee las membresías activas del usuario autenticado, cada una con el
 * nombre/slug de SU empresa únicamente -- nunca la lista completa de
 * empresas de la plataforma (encargo sección 8: "must not discover... the
 * existence of another tenant"). El join a `companies` está limitado por
 * la policy `companies_select_member`, no por esta consulta -- doble capa.
 */
export async function resolveActiveCompany(supabase: SupabaseClient<Database>): Promise<ActiveCompanyResolution> {
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || typeof userId !== "string" || userId.length === 0) {
    return { kind: "NONE" };
  }

  const { data, error } = await supabase
    .from("company_memberships")
    .select("company_id, role, companies!company_memberships_company_id_fkey(name, slug, active, status, workspace_enabled)")
    .eq("user_id", userId)
    .eq("active", true);

  if (error) throw new Error(`resolveActiveCompany: fallo leyendo company_memberships: ${error.message}`);

  const memberships: CompanyMembershipSummary[] = (data ?? [])
    .map((row) => {
      const company = row.companies as
        | { name: string; slug: string; active: boolean; status: Database["public"]["Enums"]["company_lifecycle_status"]; workspace_enabled: boolean }
        | { name: string; slug: string; active: boolean; status: Database["public"]["Enums"]["company_lifecycle_status"]; workspace_enabled: boolean }[]
        | null;
      const resolved = Array.isArray(company) ? company[0] : company;
      if (!resolved?.active || !["ACTIVE", "ONBOARDING"].includes(resolved.status)) return null;
      return {
        companyId: row.company_id,
        companyName: resolved.name,
        companySlug: resolved.slug,
        legacyRole: row.role,
        status: resolved.status,
        workspaceEnabled: resolved.workspace_enabled,
      };
    })
    .filter((m): m is CompanyMembershipSummary => m !== null);

  if (memberships.length === 0) return { kind: "NONE" };
  if (memberships.length === 1) return { kind: "SINGLE", membership: memberships[0] };
  return { kind: "MULTIPLE", memberships };
}
