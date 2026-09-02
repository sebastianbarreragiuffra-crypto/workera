import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type CompanyStatus = Database["public"]["Enums"]["company_lifecycle_status"];

export interface ExpenseCompanyOption {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  moduleStatus: "ENABLED" | "PILOT";
}
export interface ExpenseCompanyContext extends ExpenseCompanyOption {
  userId: string;
  displayName: string;
  canSubmit: boolean;
  canReadAll: boolean;
  canApprove: boolean;
  canConfigure: boolean;
  canManage: boolean;
}

type MembershipCompany = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  status: CompanyStatus;
};

function relatedCompany(value: unknown): MembershipCompany | null {
  if (Array.isArray(value)) return (value[0] as MembershipCompany | undefined) ?? null;
  return (value as MembershipCompany | null) ?? null;
}

export async function listExpenseCompaniesFromClient(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<ExpenseCompanyOption[]> {
  const { data: memberships, error: membershipError } = await supabase
    .from("company_memberships")
    .select("company_id, companies!company_memberships_company_id_fkey(id, name, slug, active, status)")
    .eq("user_id", userId)
    .eq("active", true);

  if (membershipError) throw new Error("No se pudieron verificar tus empresas.");
  const companies = (memberships ?? [])
    .map((row) => relatedCompany(row.companies))
    .filter((company): company is MembershipCompany => Boolean(company?.active));
  if (companies.length === 0) return [];

  const { data: modules, error: moduleError } = await supabase
    .from("company_modules")
    .select("company_id, status")
    .eq("module_key", "expenses")
    .in("company_id", companies.map((company) => company.id))
    .in("status", ["ENABLED", "PILOT"]);

  if (moduleError) throw new Error("No se pudo verificar el módulo Rendiciones.");
  const enabled = new Map((modules ?? []).map((module) => [module.company_id, module.status]));

  return companies
    .filter((company) => enabled.has(company.id))
    .map((company) => ({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      moduleStatus: enabled.get(company.id) as "ENABLED" | "PILOT",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function listMyExpenseCompanies(
  supabase: SupabaseClient<Database>
): Promise<ExpenseCompanyOption[]> {
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string") return [];
  return listExpenseCompaniesFromClient(supabase, userId);
}

async function hasPermission(
  supabase: SupabaseClient<Database>,
  companyId: string,
  permission: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_company_permission", {
    p_company_id: companyId,
    p_permission_code: permission,
  });
  if (error) throw new Error("No se pudieron verificar tus permisos de Rendiciones.");
  return data === true;
}

export async function getExpenseCompanyContextFromClient(
  supabase: SupabaseClient<Database>,
  companySlug: string
): Promise<ExpenseCompanyContext | null> {
  const slug = companySlug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;

  const { data: authData, error: authError } = await supabase.auth.getClaims();
  const userId = authData?.claims?.sub;
  if (authError || typeof userId !== "string") return null;

  const companies = await listExpenseCompaniesFromClient(supabase, userId);
  const company = companies.find((candidate) => candidate.slug === slug);
  if (!company) return null;

  const [profileResult, canSubmit, canReadAll, canApprove, canConfigure, canManage] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", userId).eq("active", true).maybeSingle(),
    hasPermission(supabase, company.id, "expenses.submit"),
    hasPermission(supabase, company.id, "expenses.read"),
    hasPermission(supabase, company.id, "expenses.approve"),
    hasPermission(supabase, company.id, "expenses.configure"),
    hasPermission(supabase, company.id, "expenses.manage"),
  ]);
  if (profileResult.error || !profileResult.data) return null;

  return {
    ...company,
    userId,
    displayName: profileResult.data.display_name,
    canSubmit: canSubmit || canManage,
    canReadAll,
    canApprove,
    canConfigure,
    canManage,
  };
}
