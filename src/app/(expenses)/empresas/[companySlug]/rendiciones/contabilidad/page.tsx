import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExpenseAccountingQueueForm } from "@/components/expenses/ExpenseAccountingQueueForm";
import { ExpenseAccountingResolutionForm } from "@/components/expenses/ExpenseAccountingResolutionForm";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import {
  applyExpenseAccountingRuntimePause,
  getExpenseAccountingDashboard,
  type ExpenseAccountingExportStatus,
} from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";
import { readExpenseAccountingConfig } from "@/lib/expense-accounting/config";

const statusLabel: Record<ExpenseAccountingExportStatus, string> = {
  QUEUED: "En cola",
  PROCESSING: "Procesando",
  RETRY: "Reintento programado",
  SUCCEEDED: "Validada",
  FAILED: "Requiere revisión",
  CANCELLED: "Cancelada",
};

function formatOperationalDate(value: string): string {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(new Date(value));
}

function errorGuidance(code: string | null): string | null {
  if (!code) return null;
  if (["ADAPTER_TIMEOUT", "PROVIDER_TIMEOUT", "LEASE_EXPIRED"].includes(code)) {
    return "Resultado externo incierto: verifica primero en el ERP antes de reintentar o cancelar.";
  }
  if (["PROVIDER_MISMATCH", "PAYLOAD_REJECTED", "RATE_LIMIT"].includes(code)) {
    return "Fallo conocido sin resultado externo: revisa el código operativo antes de decidir.";
  }
  return "Código no reconocido: trátalo como resultado incierto y consulta el runbook antes de decidir.";
}

export default async function ExpenseAccountingPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ fallos?: string | string[] }>;
}) {
  const { companySlug } = await params;
  const failurePageRaw = (await searchParams).fallos;
  const failurePageValue = Array.isArray(failurePageRaw) ? failurePageRaw[0] : failurePageRaw;
  const failurePage = /^\d+$/.test(failurePageValue ?? "")
    ? Math.max(1, Math.min(Number(failurePageValue), 10_000))
    : 1;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context?.canReconcile) notFound();
  const accountingConfig = readExpenseAccountingConfig();
  const dashboard = await getExpenseAccountingDashboard(supabase, context, { failurePage });
  const failurePageCount = Math.max(1, Math.ceil(dashboard.failureTotal / dashboard.failurePageSize));
  if (dashboard.failurePage > failurePageCount) {
    redirect(`/empresas/${context.slug}/rendiciones/contabilidad?fallos=${failurePageCount}`);
  }
  const accountingEnabled = accountingConfig.enabled && dashboard.health.enqueueEnabled;
  const displayHealth = applyExpenseAccountingRuntimePause(
    dashboard.health,
    accountingConfig.enabled
  );
  const oldestReadyLabel = displayHealth.oldestReadyAt
    ? formatOperationalDate(displayHealth.oldestReadyAt)
    : null;
  const healthTone = displayHealth.requiresHumanReview
    ? "critical"
    : displayHealth.requiresWorkerRecovery || displayHealth.pausedWithBacklog
      ? "warning"
      : "healthy";
  const healthClass = healthTone === "critical"
    ? "border-red-200 bg-red-50"
    : healthTone === "warning"
      ? "border-amber-200 bg-amber-50"
      : "border-emerald-200 bg-emerald-50";
  const healthBadgeClass = healthTone === "critical"
    ? "bg-red-100 text-red-800"
    : healthTone === "warning"
      ? "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Fase 4 · Integración contable</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-950">Salidas contables</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Prepara un snapshot de cada rendición pagada. La marcha blanca usa CSV y validación dry-run: todavía no crea asientos en un ERP real.
        </p>
      </section>

      <section className={`rounded-xl border p-4 ${accountingEnabled ? "border-blue-200 bg-blue-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-slate-950">Modo de operación</h2>
            <p className="mt-1 text-sm text-slate-600">
              {accountingEnabled
                ? "Marcha blanca dry-run activa: valida e idempotiza, sin crear asientos reales."
                : !accountingConfig.enabled
                  ? "Integración pausada globalmente: no se permiten nuevas salidas."
                  : "Piloto pausado para esta empresa: un responsable de plataforma debe habilitarlo antes de encolar."}
            </p>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${accountingEnabled ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"}`}>
            {accountingEnabled ? "DRY-RUN ACTIVO" : "PAUSADA"}
          </span>
        </div>
      </section>

      <section className={`rounded-xl border p-5 ${healthClass}`}>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-slate-950">Salud de la integración</h2>
            <div className="mt-1 space-y-1 text-sm text-slate-600">
              {!displayHealth.requiresHumanReview && !displayHealth.requiresWorkerRecovery && !displayHealth.pausedWithBacklog && (
                <p>La cola de esta empresa no presenta bloqueos ni fallos pendientes.</p>
              )}
              {displayHealth.requiresHumanReview && (
                <p>Finanzas: hay fallos que requieren verificación y una decisión de un segundo responsable.</p>
              )}
              {displayHealth.requiresWorkerRecovery && (
                <p>Operaciones técnicas: la cola necesita recuperación; no tomes una decisión financiera sobre esos trabajos.</p>
              )}
              {displayHealth.pausedWithBacklog && (
                <p>Pausa controlada: {displayHealth.pausedBacklogCount} salida(s) permanecen retenidas y no serán enviadas al ERP.</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {displayHealth.requiresHumanReview && <span className="w-fit rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">Decisión humana</span>}
            {displayHealth.requiresWorkerRecovery && <span className="w-fit rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">Recuperación técnica</span>}
            {displayHealth.pausedWithBacklog && <span className="w-fit rounded-full bg-slate-200 px-3 py-1 text-xs font-bold text-slate-800">Backlog pausado</span>}
            {!displayHealth.requiresHumanReview && !displayHealth.requiresWorkerRecovery && !displayHealth.pausedWithBacklog && <span className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${healthBadgeClass}`}>Operación normal</span>}
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {[
            ["En cola", displayHealth.queuedCount],
            ["Reintentos", displayHealth.retryCount],
            ["Procesando", displayHealth.processingCount],
            ["Fallidas", displayHealth.failedCount],
            ["Vencidas", displayHealth.staleProcessingCount],
            ["Backlog vencido", displayHealth.staleReadyCount],
            ["Backlog pausado", displayHealth.pausedBacklogCount],
            ["Completadas", displayHealth.succeededCount],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-white/80 bg-white/70 p-3">
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="mt-1 text-xl font-bold text-slate-950">{value}</dd>
            </div>
          ))}
        </dl>
        {oldestReadyLabel && <p className="mt-3 text-xs text-slate-600">Trabajo listo más antiguo: {oldestReadyLabel}.</p>}
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
              <ExpenseAccountingQueueForm companySlug={context.slug} reportId={report.id} enabled={accountingEnabled} />
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div><h2 className="font-semibold text-slate-950">Historial y fallos pendientes</h2><p className="text-sm text-slate-500">Los fallos se consultan por separado para que ninguno quede oculto por el historial.</p></div>
          {dashboard.failureTotal > 0 && <span className="w-fit rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">{dashboard.failureTotal} por resolver</span>}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-3 pr-4">Rendición</th><th className="py-3 pr-4">Monto</th><th className="py-3 pr-4">Estado</th><th className="py-3 pr-4">Intentos</th><th className="py-3 pr-4">Archivo</th><th className="py-3">Resolución</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {dashboard.exports.map((item) => (
                <tr key={item.exportId} className="align-top">
                  <td className="py-4 pr-4"><span className="font-medium text-slate-900">{item.referenceNumber}</span><span className="block text-xs text-slate-500">{item.title}</span>{item.lastErrorSummary && <span className="block max-w-xs text-xs text-red-700">{item.lastErrorSummary}</span>}{item.lastErrorCode && <span className="mt-1 block max-w-xs text-xs font-semibold text-slate-600">Código: {item.lastErrorCode} · {item.providerCode}</span>}{errorGuidance(item.lastErrorCode) && <span className="mt-1 block max-w-xs text-xs text-amber-800">{errorGuidance(item.lastErrorCode)}</span>}<span className="mt-1 block text-xs text-slate-400">Actualizada {formatOperationalDate(item.updatedAt)}</span></td>
                  <td className="py-4 pr-4">{formatExpenseMoney(item.totalAmount, item.currencyCode)}</td>
                  <td className="py-4 pr-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{statusLabel[item.status]}</span>{item.externalReference && <span className="mt-1 block text-xs text-slate-500">{item.externalReference}</span>}</td>
                  <td className="py-4 pr-4"><span>{item.attemptCount}/5 automáticos</span>{item.manualReplayCount > 0 && <span className="block text-xs text-slate-500">{item.manualReplayCount}/3 manuales</span>}</td>
                  <td className="py-4 pr-4"><a className="font-semibold text-blue-700 hover:underline" href={`/empresas/${context.slug}/rendiciones/contabilidad/${item.exportId}/csv`}>Descargar CSV</a></td>
                  <td className="py-4">
                    {item.status === "FAILED" && context.canManage && item.requestedBy !== context.userId && (
                      <ExpenseAccountingResolutionForm
                        companySlug={context.slug}
                        exportId={item.exportId}
                        requeueEnabled={accountingEnabled}
                      />
                    )}
                    {item.status === "FAILED" && context.canManage && item.requestedBy === context.userId && (
                      <p className="max-w-64 text-xs leading-5 text-amber-800">Debe resolver otra persona con permiso de gestión.</p>
                    )}
                    {item.status === "FAILED" && !context.canManage && (
                      <p className="max-w-64 text-xs leading-5 text-slate-500">Un responsable de gestión debe revisar este fallo.</p>
                    )}
                    {item.status !== "FAILED" && <span className="text-xs text-slate-400">Sin acción pendiente</span>}
                  </td>
                </tr>
              ))}
              {dashboard.exports.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-500">Aún no se han preparado salidas contables.</td></tr>}
            </tbody>
          </table>
        </div>
        {dashboard.failureTotal > dashboard.failurePageSize && (
          <nav aria-label="Páginas de fallos contables" className="mt-4 flex items-center justify-end gap-3 text-sm">
            <span className="text-slate-500">Fallos {dashboard.failurePage} de {failurePageCount}</span>
            {dashboard.failurePage > 1 && <Link className="font-semibold text-blue-700 hover:underline" href={`/empresas/${context.slug}/rendiciones/contabilidad?fallos=${dashboard.failurePage - 1}`}>Anterior</Link>}
            {dashboard.failurePage < failurePageCount && <Link className="font-semibold text-blue-700 hover:underline" href={`/empresas/${context.slug}/rendiciones/contabilidad?fallos=${dashboard.failurePage + 1}`}>Siguiente</Link>}
          </nav>
        )}
      </section>
    </div>
  );
}
