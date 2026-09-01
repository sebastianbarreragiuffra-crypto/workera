import Link from "next/link";
import { Badge } from "../shell/Badge";
import { onboardingProgress, presentCompanyStatus } from "./status-presenters";
import type { CompanyPortfolioItem } from "./types";

function companyInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("") || "--";
}

function progressTone(progress: number): string {
  if (progress >= 100) return "bg-emerald-500";
  if (progress > 0) return "bg-arcotex-blue";
  return "bg-slate-300";
}

function ClientWorkspaceCard({ company }: { company: CompanyPortfolioItem }) {
  const status = presentCompanyStatus(company.status);
  const progress = onboardingProgress(company.onboarding.completedSteps, company.onboarding.totalSteps);
  const modulesPending = Math.max(0, company.modules.available - company.modules.enabled);

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-lg">
      <div className="h-1.5 bg-gradient-to-r from-arcotex-navy via-arcotex-blue to-sky-300" />
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-arcotex-navy text-sm font-bold tracking-[0.08em] text-white shadow-sm" aria-hidden="true">
              {companyInitials(company.name)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight text-slate-950">{company.name}</h2>
              <p className="mt-0.5 truncate text-xs font-medium uppercase tracking-[0.12em] text-slate-400">{company.planCode}</p>
            </div>
          </div>
          <Badge label={status.label} tone={status.tone} />
        </div>

        <div className={`mt-5 rounded-xl border px-4 py-3 ${company.workspaceEnabled ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${company.workspaceEnabled ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
            <span className={`text-sm font-semibold ${company.workspaceEnabled ? "text-emerald-900" : "text-amber-950"}`}>
              {company.workspaceEnabled ? "Workspace en operación" : "Workspace en preparación"}
            </span>
          </div>
          <p className={`mt-1 text-xs leading-5 ${company.workspaceEnabled ? "text-emerald-800" : "text-amber-800"}`}>
            {company.workspaceEnabled
              ? "Puedes revisar su configuración, accesos y funciones activas."
              : "Configura sus funciones de forma independiente antes de habilitarlo."}
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/80 py-3 text-center">
          <div className="px-2">
            <dt className="text-[11px] font-medium text-slate-500">Usuarios</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{company.users.active}</dd>
          </div>
          <div className="px-2">
            <dt className="text-[11px] font-medium text-slate-500">Funciones</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{company.modules.enabled}</dd>
          </div>
          <div className="px-2">
            <dt className="text-[11px] font-medium text-slate-500">Pendientes</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{modulesPending}</dd>
          </div>
        </dl>

        <div className="mt-5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-600">Configuración inicial</span>
            <span className="font-semibold tabular-nums text-slate-800">{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`Configuración de ${company.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className={`h-full rounded-full transition-all ${progressTone(progress)}`} style={{ width: `${progress}%` }} />
          </div>
          {company.onboarding.nextStepLabel && progress < 100 && (
            <p className="mt-2 truncate text-xs text-slate-500">Siguiente: {company.onboarding.nextStepLabel}</p>
          )}
        </div>

        <Link href={company.detailHref} prefetch={false} className="mt-6 flex w-full items-center justify-between rounded-xl bg-arcotex-navy px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-arcotex-navy-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
          Administrar {company.name}
          <span aria-hidden="true">→</span>
        </Link>

        <nav className="mt-3 grid grid-cols-3 gap-2" aria-label={`Accesos rápidos de ${company.name}`}>
          <Link href={`${company.detailHref}?tab=modules`} prefetch={false} className="rounded-lg border border-slate-200 px-2 py-2 text-center text-xs font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-arcotex-blue-dark">
            Funciones
          </Link>
          <Link href={`${company.detailHref}?tab=users`} prefetch={false} className="rounded-lg border border-slate-200 px-2 py-2 text-center text-xs font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-arcotex-blue-dark">
            Usuarios
          </Link>
          <Link href={`${company.detailHref}?tab=organization`} prefetch={false} className="rounded-lg border border-slate-200 px-2 py-2 text-center text-xs font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-arcotex-blue-dark">
            Estructura
          </Link>
        </nav>
      </div>
    </article>
  );
}

export function ClientWorkspaceGrid({ companies }: { companies: CompanyPortfolioItem[] }) {
  if (companies.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
        <h2 className="text-base font-semibold text-slate-900">Todavía no hay clientes</h2>
        <p className="mt-1 text-sm text-slate-500">Agrega la primera empresa para comenzar a configurar su espacio.</p>
      </div>
    );
  }

  return (
    <section className="grid gap-5 lg:grid-cols-2" aria-label="Clientes administrados">
      {companies.map((company) => <ClientWorkspaceCard key={company.id} company={company} />)}
    </section>
  );
}
