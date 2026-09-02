import Link from "next/link";
import { notFound } from "next/navigation";
import { ExpenseStatusBadge } from "@/components/expenses/ExpenseStatusBadge";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseDashboard } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Santiago" }).format(new Date(value));
}

export default async function ExpensesDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ enviada?: string }>;
}) {
  const [{ companySlug }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) notFound();
  const dashboard = await getExpenseDashboard(supabase, context);
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="space-y-6">
      {query.enviada === "1" && (
        <div role="status" className="rounded-xl border border-success-border bg-success-bg px-4 py-3 text-sm font-medium text-success">
          Rendición enviada a revisión correctamente.
        </div>
      )}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Finanzas</p>
            {context.moduleStatus === "PILOT" && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">Piloto</span>}
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Rendiciones</h1>
          <p className="mt-2 text-sm text-slate-500">Controla tus gastos y su avance desde un solo lugar.</p>
        </div>
        {context.canSubmit && (
          <Link href={`${base}/nueva`} className="inline-flex items-center justify-center rounded-lg bg-arcotex-blue px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-arcotex-blue-dark">
            + Nueva rendición
          </Link>
        )}
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de rendiciones">
        {[
          ["Borradores", dashboard.draftCount.toString(), "Pendientes de completar"],
          ["En revisión", dashboard.reviewCount.toString(), "Esperando una decisión"],
          ["Aprobadas", dashboard.approvedCount.toString(), "Aprobadas o pagadas"],
          ["Monto visible", formatExpenseMoney(dashboard.visibleTotal), "Todo el historial según tu acceso"],
        ].map(([label, value, help]) => (
          <article key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{value}</p>
            <p className="mt-1 text-xs text-slate-400">{help}</p>
          </article>
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div><h2 className="font-semibold text-slate-900">Rendiciones recientes</h2><p className="mt-0.5 text-xs text-slate-500">Últimos 100 registros visibles.</p></div>
        </div>
        {dashboard.reports.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="text-3xl" aria-hidden="true">◇</div>
            <h3 className="mt-3 font-medium text-slate-900">Aún no hay rendiciones</h3>
            <p className="mt-1 text-sm text-slate-500">Crea el primer borrador para comenzar.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr><th className="px-5 py-3">Folio</th><th className="px-4 py-3">Rendición</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Fecha</th><th className="px-5 py-3 text-right">Total</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dashboard.reports.map((report) => (
                  <tr key={report.id} className="hover:bg-slate-50">
                    <td className="px-5 py-4 font-mono text-xs text-slate-500">{report.referenceNumber}</td>
                    <td className="px-4 py-4"><Link href={`${base}/${report.id}`} className="font-medium text-slate-900 hover:text-arcotex-blue-dark">{report.title}</Link>{!report.isOwn && <div className="mt-0.5 text-xs text-slate-400">Rendición de la empresa</div>}</td>
                    <td className="px-4 py-4"><ExpenseStatusBadge status={report.status} /></td>
                    <td className="px-4 py-4 text-slate-500">{dateLabel(report.createdAt)}</td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-900">{formatExpenseMoney(report.totalAmount, report.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
