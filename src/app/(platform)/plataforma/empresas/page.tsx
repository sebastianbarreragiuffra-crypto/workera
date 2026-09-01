import Link from "next/link";
import { CompanyPortfolioList, CreateCompanyForm } from "@/components/platform";
import { PageHeader } from "@/components/shell/PageHeader";
import { SectionCard } from "@/components/shell/SectionCard";
import { requirePlatformSession } from "@/lib/platform/authorization";
import { getPlatformCompanyPortfolioPage } from "@/lib/platform/portfolio";
import type { CompanyLifecycleStatus } from "@/lib/platform/types";

const STATUSES: Array<{ value: CompanyLifecycleStatus; label: string }> = [
  { value: "ACTIVE", label: "Activas" },
  { value: "ONBOARDING", label: "En onboarding" },
  { value: "SUSPENDED", label: "Suspendidas" },
  { value: "INACTIVE", label: "Inactivas" },
];

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function portfolioHref(input: { q: string; status: CompanyLifecycleStatus | null; page: number }): string {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.status) params.set("status", input.status);
  if (input.page > 1) params.set("page", String(input.page));
  const query = params.toString();
  return query ? `/plataforma/empresas?${query}` : "/plataforma/empresas";
}

export default async function CompaniesIndexPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; status?: string | string[]; page?: string | string[] }> }) {
  const query = await searchParams;
  const q = one(query.q).trim().slice(0, 100);
  const requestedStatus = one(query.status);
  const status = STATUSES.some((item) => item.value === requestedStatus) ? requestedStatus as CompanyLifecycleStatus : null;
  const parsedPage = Number.parseInt(one(query.page), 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [session, portfolio] = await Promise.all([
    requirePlatformSession(),
    getPlatformCompanyPortfolioPage({ search: q, status, page, pageSize: 20 }),
  ]);
  const totalPages = Math.max(1, Math.ceil(portfolio.totalCount / portfolio.pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Empresas clientes"
        subtitle="Cartera multiempresa con onboarding, accesos y módulos independientes."
      />

      <SectionCard title="Cartera">
        <form method="get" className="mb-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:grid-cols-[minmax(0,1fr)_220px_auto_auto] md:items-end">
          <label className="text-sm font-medium text-slate-700">
            Buscar empresa
            <input name="q" defaultValue={q} maxLength={100} placeholder="Nombre o identificador" className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Estado
            <select name="status" defaultValue={status ?? ""} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100">
              <option value="">Todos</option>
              {STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark">Filtrar</button>
          {(q || status) && <Link href="/plataforma/empresas" className="rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-700 hover:bg-white">Limpiar</Link>}
        </form>

        <div className="mb-3 flex items-center justify-between gap-4 text-sm text-slate-500">
          <span>{portfolio.totalCount} {portfolio.totalCount === 1 ? "empresa" : "empresas"}</span>
          {portfolio.totalCount > 0 && <span>Página {portfolio.page} de {totalPages}</span>}
        </div>
        <CompanyPortfolioList companies={portfolio.items} emptyMessage="No hay empresas que coincidan con estos filtros." />
        {totalPages > 1 && (
          <nav className="mt-5 flex justify-end gap-2" aria-label="Paginación de empresas">
            {portfolio.page > 1 && <Link href={portfolioHref({ q, status, page: portfolio.page - 1 })} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">← Anterior</Link>}
            {portfolio.page < totalPages && <Link href={portfolioHref({ q, status, page: portfolio.page + 1 })} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Siguiente →</Link>}
          </nav>
        )}
      </SectionCard>

      <div id="nueva-empresa" className="scroll-mt-6">
        <SectionCard title="Nueva empresa">
          <CreateCompanyForm canManage={session.canManage} />
        </SectionCard>
      </div>
    </div>
  );
}
