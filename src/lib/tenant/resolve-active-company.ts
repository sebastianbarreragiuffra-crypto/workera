import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * GESTORA — resolver de tenant activo (MT-1/MT-2, fundación mínima).
 *
 * auth.uid() -> membresías activas (en empresas activas) -> 0/1/N.
 *
 * IMPORTANTE -- este módulo NO está conectado a ningún gate de autorización
 * real todavía: `(app)/layout.tsx`, `authorize.ts` y todos los view-models
 * existentes siguen usando exclusivamente `profiles.role` (el modelo
 * ACTIVO). Este archivo prueba que el modelo OBJETIVO (companies +
 * company_memberships) es resolvible de forma segura, para que una fase
 * futura (MT-3+) pueda migrar la autorización real sin rediseñar esto de
 * nuevo. Ningún llamador existente importa este archivo.
 *
 * Esta versión enumera únicamente las membresías autorizadas. El selector de
 * workspace de MT-3D podrá recibir una empresa elegida en URL/cookie, pero
 * tendrá que contrastarla nuevamente contra esta lista y RLS; la selección
 * nunca será autorización por sí sola.
 */

export interface CompanyMembershipSummary {
  companyId: string;
  companyName: string;
  companySlug: string;
  role: Database["public"]["Enums"]["app_role"];
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
  const { data, error } = await supabase
    .from("company_memberships")
    .select("company_id, role, companies(name, slug, active, workspace_enabled)")
    .eq("active", true);

  if (error) throw new Error(`resolveActiveCompany: fallo leyendo company_memberships: ${error.message}`);

  const memberships: CompanyMembershipSummary[] = (data ?? [])
    .map((row) => {
      const company = row.companies as
        | { name: string; slug: string; active: boolean; workspace_enabled: boolean }
        | { name: string; slug: string; active: boolean; workspace_enabled: boolean }[]
        | null;
      const resolved = Array.isArray(company) ? company[0] : company;
      if (!resolved?.active || !resolved.workspace_enabled) return null;
      return { companyId: row.company_id, companyName: resolved.name, companySlug: resolved.slug, role: row.role };
    })
    .filter((m): m is CompanyMembershipSummary => m !== null);

  if (memberships.length === 0) return { kind: "NONE" };
  if (memberships.length === 1) return { kind: "SINGLE", membership: memberships[0] };
  return { kind: "MULTIPLE", memberships };
}
