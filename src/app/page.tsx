import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveCompany } from "@/lib/tenant/resolve-active-company";
import { resolveWorkspaceDestination } from "@/lib/tenant/post-login-workspace";

export default async function RootPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const [platformMembershipResult, expenseCompanies, companyResolution] = await Promise.all([
    supabase
      .from("platform_memberships")
      .select("role")
      .eq("user_id", profile.id)
      .eq("active", true)
      .maybeSingle(),
    listExpenseCompaniesFromClient(supabase, profile.id),
    resolveActiveCompany(supabase),
  ]);

  if (platformMembershipResult.error) {
    console.error("[platform] no se pudo verificar la membresía al resolver la portada", {
      event: "root_platform_membership_lookup_failed",
    });
    throw new Error("No se pudo verificar el acceso a la plataforma.");
  }

  redirect(resolveWorkspaceDestination({
    hasPlatformMembership: Boolean(platformMembershipResult.data),
    legacyProfileRole: profile.role,
    companies: companyResolution,
    expenseCompanyIds: new Set(expenseCompanies.map((company) => company.id)),
  }));
}
