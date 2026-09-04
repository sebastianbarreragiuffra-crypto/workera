import { notFound } from "next/navigation";
import { ExpenseAccountingQueueForm } from "@/components/expenses/ExpenseAccountingQueueForm";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseAccountingDashboard, type ExpenseAccountingExportStatus } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

const statusLabel: Record<ExpenseAccountingExportStatus, string> = {
  QUEUED: "En cola",
  PROCESSING: "Procesando",
  RETRY: "Reintento programado",
  SUCCEEDED: "Validada",
  FAILED: "Requiere revisión",
  CANCELLED: "Cancelada",
};

export default async function ExpenseAccountingPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context?.canReconcile) notFound();
  const dashboard = await getExpenseAccountingDashboard(supabase, context);

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Fase 4 · Integración contable</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-950">Salidas contables</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Prepara un snapshot de cada rendición pagada. La marcha blanca usa CSV y validación dry-run: todavía no crea asientos en un ERP real.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="font-semibold text-slate-950">Listas para preparar</h2><p className="text-sm text-slate-500">Solo rendiciones conciliadas como pagadas.</p></div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-700">{dashboard.ready.length}</span>
        </div>
        <div className="mt-4 divide-y divide-slate-100">
          {dashboard.ready.length === 0 && <p className="py-4 text-sm text-slate-500">No hay nuevas rendiciones pagadas pendientes de salida.</p>}
          {dashboard.ready.map((report) => (
            <article key={report.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="font-semibold text-slate-900">{report.referenceNumber} · {report.title}</p><p className="text-sm text-slate-500">{formatExpenseMoney(report.totalAmount, report.currencyCode)}</p></div>
              <ExpenseAccountingQueueForm companySlug={context.slug} reportId={report.id} />
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-950">Historial de salidas</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-3 pr-4">Rendición</th><th className="py-3 pr-4">Monto</th><th className="py-3 pr-4">Estado</th><th className="py-3 pr-4">Intentos</th><th className="py-3">Archivo</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {dashboard.exports.map((item) => (
                <tr key={item.exportId}><td className="py-4 pr-4"><span className="font-medium text-slate-900">{item.referenceNumber}</span><span className="block text-xs text-slate-500">{item.title}</span>{item.lastErrorSummary && <span className="block text-xs text-red-700">{item.lastErrorSummary}</span>}</td><td className="py-4 pr-4">{formatExpenseMoney(item.totalAmount, item.currencyCode)}</td><td className="py-4 pr-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{statusLabel[item.status]}</span>{item.externalReference && <span className="mt-1 block text-xs text-slate-500">{item.externalReference}</span>}</td><td className="py-4 pr-4">{item.attemptCount}/5</td><td className="py-4"><a className="font-semibold text-blue-700 hover:underline" href={`/empresas/${context.slug}/rendiciones/contabilidad/${item.exportId}/csv`}>Descargar CSV</a></td></tr>
              ))}
              {dashboard.exports.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-500">Aún no se han preparado salidas contables.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
