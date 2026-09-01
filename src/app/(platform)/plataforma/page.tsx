import Link from "next/link";
import { CompanyPortfolioList, PortfolioKpis } from "@/components/platform";
import { PageHeader } from "@/components/shell/PageHeader";
import { SectionCard } from "@/components/shell/SectionCard";
import { requirePlatformSession } from "@/lib/platform/authorization";
import { getPlatformCompanyPortfolioPage, getPlatformPortfolioSummary } from "@/lib/platform/portfolio";

export default async function PlatformDashboardPage() {
  const [session, summary, recent] = await Promise.all([
    requirePlatformSession(),
    getPlatformPortfolioSummary(),
    getPlatformCompanyPortfolioPage({ pageSize: 5 }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard de plataforma"
        subtitle="Vista ejecutiva de empresas clientes, adopción y configuración."
        actions={session.canManage ? (
          <Link
            href="/plataforma/empresas#nueva-empresa"
            className="inline-flex rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            Nueva empresa
          </Link>
        ) : undefined}
      />

      <PortfolioKpis
        items={[
          { id: "companies", label: "Empresas clientes", value: summary.totalCompanies, supportingText: `${summary.activeCompanies} activas`, tone: "info", href: "/plataforma/empresas" },
          { id: "onboarding", label: "En onboarding", value: summary.onboardingCompanies, supportingText: "Configuración previa a habilitar workspace", tone: summary.onboardingCompanies > 0 ? "warning" : "positive", href: "/plataforma/empresas?status=ONBOARDING" },
          { id: "users", label: "Usuarios activos", value: summary.activeMembers, supportingText: "Membresías empresariales activas", tone: "neutral" },
          { id: "modules", label: "Módulos habilitados", value: summary.enabledModules, supportingText: "Suma de capacidades por cliente", tone: "positive" },
        ]}
      />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
        <SectionCard title="Atención requerida">
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              { label: "Onboarding bloqueado", value: summary.blockedOnboardingCompanies, href: "/plataforma/empresas?status=ONBOARDING" },
              { label: "Módulos por configurar", value: summary.setupRequiredModules, href: "/plataforma/empresas" },
              { label: "Invitaciones pendientes", value: summary.pendingInvitations, href: "/plataforma/empresas" },
              { label: "Clientes suspendidos", value: summary.suspendedCompanies, href: "/plataforma/empresas?status=SUSPENDED" },
            ].map((item) => (
              <li key={item.label}>
                <Link href={item.href} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 hover:border-blue-300 hover:bg-blue-50">
                  <span className="text-sm font-medium text-slate-700">{item.label}</span>
                  <span className="text-lg font-semibold tabular-nums text-slate-900">{item.value}</span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Gate operacional">
          <p className="text-sm leading-6 text-slate-600">Las empresas nuevas se configuran con su workspace bloqueado. Solo pasan a operación después del aislamiento tenant completo de datos, archivos, jobs y RLS.</p>
        </SectionCard>
      </section>

      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Empresas recientes</h2>
          <p className="text-sm text-slate-500">Estado de incorporación, usuarios y capacidades contratadas.</p>
        </div>
        <Link href="/plataforma/empresas" className="shrink-0 text-sm font-medium text-arcotex-blue hover:underline">
          Ver cartera completa →
        </Link>
      </div>
      <CompanyPortfolioList companies={recent.items} />
    </div>
  );
}
