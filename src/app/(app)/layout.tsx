import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../lib/auth/session";
import { createClient } from "../../lib/supabase/server";
import { Sidebar } from "../../components/shell/Sidebar";
import { Topbar } from "../../components/shell/Topbar";
import { getNavSectionsForRole, roleLabel } from "../../components/shell/nav-config";
import { getPeriodStatus } from "../../lib/view-models/dashboard-view";
import { todayInSantiago } from "../../lib/view-models/date-utils";
import { listExpenseCompaniesFromClient } from "../../lib/expenses/access";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../lib/tenant/legacy-workforce";

const AREA_LABEL: Record<"SUPERVISOR_PRODUCTION" | "SUPERVISOR_INSTALLATION", string> = {
  SUPERVISOR_PRODUCTION: "Producción",
  SUPERVISOR_INSTALLATION: "Instalación",
};

/**
 * Shell autenticado (Fase 8, PASO 3; restilizado en Fase 8B.1). Toda ruta
 * bajo `(app)` pasa por acá primero: sin sesión o sin rol asignado ->
 * `/login`, nunca un shell vacío. El middleware (`src/proxy.ts`, Fase 3) ya
 * bloquea rutas sin sesión antes de llegar aquí; este chequeo es la segunda
 * capa (rol, no solo sesión) y la que decide qué navegación mostrar.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.role || !profile.active) {
    redirect("/login");
  }

  const supabase = await createClient();
  const [periodStatus, platformMembership, expenseCompanies, workforceMembership] = await Promise.all([
    getPeriodStatus(supabase, todayInSantiago()),
    supabase
      .from("platform_memberships")
      .select("user_id")
      .eq("user_id", profile.id)
      .eq("active", true)
      .maybeSingle(),
    listExpenseCompaniesFromClient(supabase, profile.id),
    supabase
      .from("company_memberships")
      .select("company_id, companies!inner(id)")
      .eq("user_id", profile.id)
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .eq("active", true)
      .eq("companies.active", true)
      .eq("companies.status", "ACTIVE")
      .eq("companies.workspace_enabled", true)
      .maybeSingle(),
  ]);

  if (workforceMembership.error || !workforceMembership.data) {
    redirect("/");
  }

  const expensesHref = expenseCompanies.length > 1
    ? "/rendiciones"
    : expenseCompanies[0]
      ? `/empresas/${expenseCompanies[0].slug}/rendiciones`
      : null;
  const sections = getNavSectionsForRole(profile.role, {
    expensesHref,
  });
  const areaLabel =
    profile.role === "SUPERVISOR_PRODUCTION" || profile.role === "SUPERVISOR_INSTALLATION" ? AREA_LABEL[profile.role] : null;

  return (
    <div className="flex h-full min-h-screen bg-background">
      <Sidebar
        sections={sections}
        weeklyReview={periodStatus.weeklyReview}
        reportingPeriod={periodStatus.reportingPeriod}
        displayName={profile.display_name}
        roleLabel={roleLabel(profile.role)}
        areaLabel={areaLabel}
        platformHref={platformMembership.data ? "/plataforma" : null}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
