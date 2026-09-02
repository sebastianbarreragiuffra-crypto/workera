import Link from "next/link";
import { notFound } from "next/navigation";
import { ExpenseStatusBadge } from "@/components/expenses/ExpenseStatusBadge";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseApprovalQueue } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

function submittedLabel(value: string | null): string {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "America/Santiago" }).format(new Date(value));
}

export default async function ExpenseApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ decidida?: string }>;
}) {
  const [{ companySlug }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context || (!context.canApprove && !context.canManage)) notFound();
  const reports = await getExpenseApprovalQueue(supabase, context);
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="space-y-6">
      {query.decidida === "1" && <div role="status" className="rounded-xl border border-success-border bg-success-bg px-4 py-3 text-sm font-medium text-success">Decisión registrada correctamente.</div>}
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Control financiero</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Aprobaciones pendientes</h1>
        <p className="mt-2 text-sm text-slate-500">Rendiciones enviadas por personas de {context.name}, ordenadas desde la más antigua.</p>
      </header>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {reports.length === 0 ? (
          <div className="px-6 py-14 text-center"><div className="text-3xl" aria-hidden="true">✓</div><h2 className="mt-3 font-medium text-slate-900">Bandeja al día</h2><p className="mt-1 text-sm text-slate-500">No hay rendiciones esperando una decisión.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Folio</th><th className="px-4 py-3">Persona</th><th className="px-4 py-3">Rendición</th><th className="px-4 py-3">Enviada</th><th className="px-4 py-3">Estado</th><th className="px-5 py-3 text-right">Total</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {reports.map((report) => (
                  <tr key={report.id} className="hover:bg-slate-50">
                    <td className="px-5 py-4 font-mono text-xs text-slate-500">{report.referenceNumber}</td>
                    <td className="px-4 py-4"><div className="font-medium text-slate-900">{report.submitterName}</div>{report.isOwn && <div className="mt-0.5 text-xs font-medium text-amber-700">Requiere otro aprobador</div>}</td>
                    <td className="px-4 py-4"><Link href={`${base}/${report.id}`} className="font-medium text-slate-900 hover:text-arcotex-blue-dark">{report.title}</Link></td>
                    <td className="px-4 py-4 text-slate-500">{submittedLabel(report.submittedAt)}</td>
                    <td className="px-4 py-4"><ExpenseStatusBadge status={report.status} /></td>
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
