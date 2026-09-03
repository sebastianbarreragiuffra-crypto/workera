import { notFound } from "next/navigation";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseIndicators } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

function hoursLabel(hours: number | null): string {
  if (hours === null) return "Sin datos";
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} días`;
}

export default async function ExpenseIndicatorsPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) notFound();

  const indicators = await getExpenseIndicators(supabase, context);
  if (!indicators) notFound();

  const complianceRate = indicators.resolvedCount > 0 ? Math.round((indicators.approvedCount / indicators.resolvedCount) * 100) : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Control financiero</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Indicadores</h1>
        <p className="mt-2 text-sm text-slate-500">
          Rendiciones resueltas de {context.name} en los últimos {indicators.windowDays} días.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores de aprobación">
        {[
          ["Resueltas", indicators.resolvedCount.toString(), `Últimos ${indicators.windowDays} días`],
          ["Tiempo promedio de aprobación", hoursLabel(indicators.avgApprovalHours), "Desde el envío hasta la decisión final"],
          ["Tasa de aprobación", complianceRate === null ? "Sin datos" : `${complianceRate}%`, "Aprobadas o pagadas sobre el total resuelto"],
          ["Rechazadas", indicators.rejectedCount.toString(), `Últimos ${indicators.windowDays} días`],
        ].map(([label, value, help]) => (
          <article key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{value}</p>
            <p className="mt-1 text-xs text-slate-500">{help}</p>
          </article>
        ))}
      </section>

      <section className="space-y-3" aria-labelledby="expense-risk-heading">
        <div>
          <h2 id="expense-risk-heading" className="font-semibold text-slate-900">Controles y alertas</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
            Señales operativas para priorizar revisión humana. No determinan fraude ni constituyen una evaluación de cumplimiento legal.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[
            {
              label: "Cobertura de comprobantes",
              value: indicators.riskSignals.receiptCoveragePercent === null ? "Sin datos" : `${indicators.riskSignals.receiptCoveragePercent}%`,
              help: "Ítems con respaldo sobre los que lo exigen",
              alert: false,
            },
            {
              label: "Respaldos obligatorios faltantes",
              value: indicators.riskSignals.missingRequiredReceipts.toString(),
              help: "Ítems que todavía requieren comprobante",
              alert: indicators.riskSignals.missingRequiredReceipts > 0,
            },
            {
              label: "Comprobantes repetidos",
              value: indicators.riskSignals.duplicateReceipts.toString(),
              help: "Coincidencias exactas de archivo dentro de la empresa",
              alert: indicators.riskSignals.duplicateReceipts > 0,
            },
            {
              label: "OCR pendiente de revisión",
              value: indicators.riskSignals.ocrReviewPending.toString(),
              help: "Diferencias o baja confianza sin decisión humana",
              alert: indicators.riskSignals.ocrReviewPending > 0,
            },
            {
              label: "Fallos de lectura OCR",
              value: indicators.riskSignals.ocrFailures.toString(),
              help: "Comprobantes que deben revisarse manualmente",
              alert: indicators.riskSignals.ocrFailures > 0,
            },
            {
              label: "Sobre límite de política",
              value: indicators.riskSignals.policyLimitExceededItems.toString(),
              help: "Ítems abiertos que exceden el máximo configurado",
              alert: indicators.riskSignals.policyLimitExceededItems > 0,
            },
          ].map((signal) => (
            <article key={signal.label} className={`rounded-xl border p-5 shadow-sm ${signal.alert ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{signal.label}</p>
              <p className={`mt-2 text-2xl font-semibold tabular-nums ${signal.alert ? "text-amber-900" : "text-slate-950"}`}>{signal.value}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{signal.help}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="font-semibold text-slate-900">Gasto por categoría</h2>
          <p className="mt-1 text-xs text-slate-500">Rendiciones aprobadas o pagadas, resueltas en los últimos {indicators.windowDays} días.</p>
        </div>
        {indicators.categoryBreakdown.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-slate-500">Sin gastos registrados en la ventana seleccionada.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3">Categoría</th>
                  <th className="px-4 py-3">Moneda</th>
                  <th className="px-4 py-3 text-right">Ítems</th>
                  <th className="px-5 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {indicators.categoryBreakdown.map((row) => (
                  <tr key={`${row.categoryName}-${row.currencyCode}`} className="hover:bg-slate-50">
                    <td className="px-5 py-4 font-medium text-slate-900">{row.categoryName}</td>
                    <td className="px-4 py-4 text-slate-500">{row.currencyCode}</td>
                    <td className="px-4 py-4 text-right tabular-nums text-slate-700">{row.itemCount}</td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-900">{formatExpenseMoney(row.totalAmount, row.currencyCode)}</td>
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
