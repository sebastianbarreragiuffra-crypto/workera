import Link from "next/link";
import { ClientWorkspaceGrid, PortfolioKpis } from "@/components/platform";
import { PageHeader } from "@/components/shell/PageHeader";
import { requirePlatformSession } from "@/lib/platform/authorization";
import { getPlatformCompanyPortfolioPage, getPlatformPortfolioSummary } from "@/lib/platform/portfolio";

export default async function PlatformDashboardPage() {
  const [session, summary, portfolio] = await Promise.all([
    requirePlatformSession(),
    getPlatformPortfolioSummary(),
    getPlatformCompanyPortfolioPage({ pageSize: 100 }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mis clientes"
        subtitle="Administra cada empresa por separado y adapta sus funciones, usuarios y estructura según lo que necesite."
        actions={session.canManage ? (
          <Link
            href="/plataforma/empresas#nueva-empresa"
            className="inline-flex rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            Agregar cliente
          </Link>
        ) : undefined}
      />

      <PortfolioKpis
        items={[
          { id: "companies", label: "Clientes", value: summary.totalCompanies, supportingText: `${summary.activeCompanies} en operación`, tone: "info", href: "/plataforma/empresas" },
          { id: "onboarding", label: "En preparación", value: summary.onboardingCompanies, supportingText: "Configuración inicial pendiente", tone: summary.onboardingCompanies > 0 ? "warning" : "positive", href: "/plataforma/empresas?status=ONBOARDING" },
          { id: "users", label: "Usuarios activos", value: summary.activeMembers, supportingText: "En todos los clientes", tone: "neutral" },
          { id: "modules", label: "Funciones activas", value: summary.enabledModules, supportingText: "Configuradas por empresa", tone: "positive" },
        ]}
      />

      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Espacios de clientes</h2>
          <p className="text-sm text-slate-500">Entra a una empresa para gestionar sus funciones sin afectar a las demás.</p>
        </div>
        <Link href="/plataforma/empresas" className="shrink-0 text-sm font-medium text-arcotex-blue hover:underline">
          Ver listado →
        </Link>
      </div>
      <ClientWorkspaceGrid companies={portfolio.items} />

      {(summary.setupRequiredModules > 0 || summary.pendingInvitations > 0 || summary.blockedOnboardingCompanies > 0) && (
        <aside className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <span className="font-semibold">Pendientes generales:</span>{" "}
          {summary.setupRequiredModules} funciones por configurar · {summary.pendingInvitations} invitaciones · {summary.blockedOnboardingCompanies} onboarding bloqueado.
        </aside>
      )}
    </div>
  );
}
