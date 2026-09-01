import Link from "next/link";
import { Badge } from "../shell/Badge";
import { PageHeader } from "../shell/PageHeader";
import { onboardingProgress, presentCompanyStatus } from "./status-presenters";
import type { CompanyHeaderSummary } from "./types";

function CompanyMonogram({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "--";
  return <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-arcotex-navy text-sm font-semibold tracking-wide text-white" aria-hidden="true">{initials}</span>;
}

export function CompanyHeader({
  company,
  backHref,
  workspaceHref,
}: {
  company: CompanyHeaderSummary;
  backHref: string;
  workspaceHref?: string | null;
}) {
  const status = presentCompanyStatus(company.status);
  const progress = onboardingProgress(company.onboarding.completedSteps, company.onboarding.totalSteps);

  return (
    <section className="space-y-4" aria-label={`Empresa ${company.name}`}>
      <Link href={backHref} className="inline-flex text-sm font-medium text-arcotex-blue hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
        <span className="mr-1" aria-hidden="true">←</span> Volver a empresas
      </Link>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <CompanyMonogram name={company.name} />
          <div className="min-w-0 flex-1">
            <PageHeader
              title={company.name}
              subtitle={company.legalName ? `${company.legalName} · ${company.slug}` : company.slug}
              actions={workspaceHref ? (
                <Link href={workspaceHref} className="inline-flex rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
                  Abrir espacio de trabajo <span className="ml-1" aria-hidden="true">→</span>
                </Link>
              ) : undefined}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge label={status.label} tone={status.tone} />
              <span className="text-xs text-slate-500">Onboarding {progress}%</span>
            </div>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">Usuarios activos</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{company.users.active}<span className="text-sm font-normal text-slate-400"> / {company.users.total}</span></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Módulos habilitados</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{company.modules.enabled}<span className="text-sm font-normal text-slate-400"> / {company.modules.available}</span></dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Trabajadores</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{company.employeeCount ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
