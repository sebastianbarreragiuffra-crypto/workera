import Link from "next/link";
import { Badge } from "../shell/Badge";
import { EmptyState } from "../shell/StateMessages";
import { onboardingProgress, presentCompanyStatus, presentOnboardingStatus } from "./status-presenters";
import type { CompanyPortfolioItem } from "./types";

function companyInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "--";
}

function CompanyIdentity({ company }: { company: Pick<CompanyPortfolioItem, "name" | "slug"> }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-arcotex-navy text-xs font-semibold tracking-wide text-white" aria-hidden="true">
        {companyInitials(company.name)}
      </span>
      <div className="min-w-0">
        <div className="truncate font-medium text-slate-900">{company.name}</div>
        <div className="truncate text-xs text-slate-500">{company.slug}</div>
      </div>
    </div>
  );
}

function OnboardingProgress({ onboarding }: { onboarding: CompanyPortfolioItem["onboarding"] }) {
  const presentation = presentOnboardingStatus(onboarding.status);
  const progress = onboardingProgress(onboarding.completedSteps, onboarding.totalSteps);

  return (
    <div className="min-w-40">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700">{presentation.label}</span>
        <span className="tabular-nums text-slate-500">{progress}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`Onboarding de ${progress}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <div className="h-full rounded-full bg-arcotex-blue" style={{ width: `${progress}%` }} />
      </div>
      {onboarding.nextStepLabel && <p className="mt-1 truncate text-[11px] text-slate-500">Siguiente: {onboarding.nextStepLabel}</p>}
    </div>
  );
}

function CompanyMobileCard({ company }: { company: CompanyPortfolioItem }) {
  const status = presentCompanyStatus(company.status);

  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <CompanyIdentity company={company} />
        <Badge label={status.label} tone={status.tone} />
      </div>

      <div className="mt-4">
        <OnboardingProgress onboarding={company.onboarding} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Usuarios</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-slate-800">{company.users.active} activos · {company.users.total} total</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Módulos</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-slate-800">{company.modules.enabled} de {company.modules.available}</dd>
        </div>
      </dl>

      <Link href={company.detailHref} prefetch={false} className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
        Ver empresa <span className="ml-1" aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function CompanyPortfolioList({ companies, emptyMessage = "Todavía no hay empresas en la cartera." }: { companies: CompanyPortfolioItem[]; emptyMessage?: string }) {
  if (companies.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <section aria-label="Empresas de la cartera">
      <div className="grid gap-3 md:hidden">
        {companies.map((company) => <CompanyMobileCard key={company.id} company={company} />)}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card shadow-sm md:block">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">Empresa</th>
              <th scope="col" className="px-4 py-3">Estado</th>
              <th scope="col" className="px-4 py-3">Onboarding</th>
              <th scope="col" className="px-4 py-3">Usuarios</th>
              <th scope="col" className="px-4 py-3">Módulos</th>
              <th scope="col" className="px-4 py-3 text-right"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => {
              const status = presentCompanyStatus(company.status);
              return (
                <tr key={company.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/80">
                  <td className="px-4 py-3"><CompanyIdentity company={company} /></td>
                  <td className="px-4 py-3"><Badge label={status.label} tone={status.tone} /></td>
                  <td className="px-4 py-3"><OnboardingProgress onboarding={company.onboarding} /></td>
                  <td className="px-4 py-3">
                    <div className="font-medium tabular-nums text-slate-800">{company.users.active} activos</div>
                    <div className="text-xs tabular-nums text-slate-500">{company.users.total} en total</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium tabular-nums text-slate-800">{company.modules.enabled} habilitados</div>
                    <div className="text-xs tabular-nums text-slate-500">{company.modules.available} disponibles</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={company.detailHref} prefetch={false} className="inline-flex rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-arcotex-blue hover:bg-blue-50 hover:text-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
                      Ver detalle
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
