import Link from "next/link";
import { notFound } from "next/navigation";
import { runExpenseAssistantAction } from "./actions";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import {
  getExpenseAssistantDashboard,
  getAllowedExpenseAssistantIntents,
  canOpenExpenseAssistantEvidence,
  type ExpenseAssistantIntent,
  type ExpenseAssistantResult,
} from "@/lib/expenses/assistant";
import { EXPENSE_STATUS_LABEL, formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";
import { formatDateTimeInSantiago } from "@/lib/view-models/date-utils";

const intentLabel: Record<ExpenseAssistantIntent, string> = {
  ACTION_REQUIRED: "¿Qué requiere atención?",
  SPEND_SUMMARY: "¿Cuánto se aprobó o pagó?",
  PAYMENT_STATUS: "¿Qué falta pagar o contabilizar?",
};

const reasonLabel: Record<string, string> = {
  PENDING_APPROVAL: "Espera aprobación",
  MISSING_RECEIPT: "Falta comprobante",
  DUPLICATE_RECEIPT: "Comprobante repetido",
  OCR_REVIEW_PENDING: "Lectura por revisar",
  OCR_FAILED: "Lectura fallida",
  POLICY_LIMIT_EXCEEDED: "Sobre límite",
  APPROVED_IN_WINDOW: "Aprobada en el período",
  PAID_IN_WINDOW: "Pagada en el período",
  AWAITING_PAYMENT: "Espera pago",
  ACCOUNTING_NOT_QUEUED: "Falta salida contable",
  ACCOUNTING_PENDING: "Salida contable en curso",
  ACCOUNTING_FAILED: "Salida contable fallida",
};

function Metric({ label, value, help }: { label: string; value: string | number; help: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{help}</p>
    </article>
  );
}

function MoneyTotals({ title, totals }: {
  title: string;
  totals: Array<{ currencyCode: string; totalAmount: number; reportCount: number }>;
}) {
  if (totals.length === 0) return null;
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">{title}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {totals.map((total) => (
          <div key={total.currencyCode} className="rounded-lg bg-white px-4 py-3">
            <p className="font-semibold tabular-nums text-slate-950">{formatExpenseMoney(total.totalAmount, total.currencyCode)}</p>
            <p className="mt-0.5 text-xs text-slate-500">{total.reportCount} rendición{total.reportCount === 1 ? "" : "es"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantSummary({ result }: { result: ExpenseAssistantResult }) {
  if (result.intent === "ACTION_REQUIRED") {
    const summary = result.summary;
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric label="Pendientes de aprobación" value={summary.pendingApprovalReports} help="Rendiciones enviadas que esperan decisión." />
        <Metric label="Respaldos obligatorios faltantes" value={summary.missingRequiredReceiptItems} help="Gastos que aún requieren comprobante." />
        <Metric label="Comprobantes repetidos" value={summary.duplicateReceipts} help="Coincidencias exactas que requieren revisión humana." />
        <Metric label="Lecturas por revisar" value={summary.ocrReviewPending} help="OCR con baja confianza o diferencias." />
        <Metric label="Lecturas fallidas" value={summary.ocrFailures} help="Archivos que deben revisarse manualmente." />
        <Metric label="Sobre límite de política" value={summary.policyLimitExceededItems} help="Gastos abiertos que exceden una regla configurada." />
      </div>
    );
  }

  if (result.intent === "SPEND_SUMMARY") {
    const summary = result.summary;
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric label="Total de rendiciones" value={summary.reportCount} help="Aprobadas o pagadas dentro del período." />
          <Metric label="Aprobadas" value={summary.approvedReports} help="Todavía no figuran como pagadas." />
          <Metric label="Pagadas" value={summary.paidReports} help="Con conciliación de pago registrada." />
        </div>
        <MoneyTotals title="Monto por moneda" totals={summary.totals} />
      </div>
    );
  }

  const summary = result.summary;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric label="Aprobadas por pagar" value={summary.approvedAwaitingPayment} help="Aprobadas durante el período sin pago registrado." />
        <Metric label="Pagadas" value={summary.paidInWindow} help="Pagos registrados dentro del período." />
        <Metric label="Movimientos bancarios sin resolver" value={summary.unmatchedBankTransactions} help="Conteo agregado; no expone referencias bancarias." />
        <Metric label="Sin salida contable" value={summary.paidWithoutAccountingExport} help="Pagadas que aún no ingresan a la cola contable." />
        <Metric label="Salidas en curso" value={summary.accountingInProgress} help="En cola, procesando o esperando reintento." />
        <Metric label="Salidas con falla" value={summary.accountingFailed} help="Requieren intervención antes de continuar." />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <MoneyTotals title="Monto aprobado por pagar" totals={summary.awaitingPaymentTotals} />
        <MoneyTotals title="Monto pagado" totals={summary.paidTotals} />
      </div>
    </div>
  );
}

export default async function ExpenseAssistantPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ consulta?: string; error?: string }>;
}) {
  const [{ companySlug }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) notFound();
  const dashboard = await getExpenseAssistantDashboard(supabase, context, query.consulta ?? null);
  if (!dashboard) notFound();
  const allowedIntents = getAllowedExpenseAssistantIntents(context);
  const canOpenEvidence = canOpenExpenseAssistantEvidence(context);

  const errorMessage = query.error === "limite"
    ? "Alcanzaste temporalmente el límite de consultas. Intenta nuevamente más tarde."
    : query.error === "operacion"
      ? "No pudimos preparar el análisis. Los datos financieros no fueron modificados."
      : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Fase 6 · Apoyo operativo</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Asistente de Rendiciones</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Responde preguntas predefinidas con reglas verificables y enlaces a la evidencia. No usa texto libre, no envía datos a una IA externa y no puede aprobar, pagar ni modificar rendiciones.
        </p>
      </header>

      {errorMessage && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900">
          {errorMessage}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="assistant-question-heading">
        <h2 id="assistant-question-heading" className="font-semibold text-slate-950">Elige una pregunta</h2>
        <p className="mt-1 text-sm text-slate-500">El análisis se limita a la empresa activa y a una ventana acotada.</p>
        <form action={runExpenseAssistantAction} className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end">
          <input type="hidden" name="companySlug" value={context.slug} />
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            Pregunta
            <select name="intent" defaultValue={allowedIntents[0]} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
              {allowedIntents.map((value) => <option key={value} value={value}>{intentLabel[value]}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            Período
            <select name="windowDays" defaultValue="30" className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
              <option value="7">Últimos 7 días</option>
              <option value="30">Últimos 30 días</option>
              <option value="90">Últimos 90 días</option>
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-arcotex-blue px-5 py-2.5 text-sm font-semibold text-white hover:bg-arcotex-blue-dark">
            Analizar
          </button>
        </form>
      </section>

      {dashboard.selected ? (
        <section className="space-y-5" aria-labelledby="assistant-result-heading">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="assistant-result-heading" className="text-xl font-semibold text-slate-950">{intentLabel[dashboard.selected.intent]}</h2>
              <p className="mt-1 text-xs text-slate-500">
                Generado {formatDateTimeInSantiago(dashboard.selected.result.generatedAt)} · últimos {dashboard.selected.windowDays} días
              </p>
            </div>
            <span className="text-xs font-medium text-slate-500">Respuesta de solo lectura</span>
          </div>

          <AssistantSummary result={dashboard.selected.result} />

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-labelledby="assistant-evidence-heading">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 id="assistant-evidence-heading" className="font-semibold text-slate-950">Evidencia</h3>
              <p className="mt-1 text-xs text-slate-500">
                {canOpenEvidence
                  ? "Hasta 12 rendiciones relacionadas. Abre una para comprobar el dato en su fuente."
                  : "Hasta 12 referencias relacionadas. El detalle individual exige permiso de lectura de rendiciones."}
              </p>
            </div>
            {dashboard.selected.result.citations.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">No hay rendiciones relacionadas para esta consulta.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {dashboard.selected.result.citations.map((citation) => (
                  <li key={citation.reportId} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      {canOpenEvidence ? (
                        <Link href={`/empresas/${context.slug}/rendiciones/${citation.reportId}`} className="font-semibold text-blue-700 hover:underline">
                          {citation.referenceNumber}
                        </Link>
                      ) : (
                        <span className="font-semibold text-slate-800">{citation.referenceNumber}</span>
                      )}
                      <p className="mt-1 text-xs text-slate-500">{citation.reasonCodes.map((code) => reasonLabel[code] ?? code).join(" · ")}</p>
                    </div>
                    <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{EXPENSE_STATUS_LABEL[citation.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      ) : (
        <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
          <h2 className="font-semibold text-slate-900">Todavía no hay un análisis seleccionado</h2>
          <p className="mt-2 text-sm text-slate-500">Elige una pregunta para obtener una respuesta con evidencia trazable.</p>
        </section>
      )}

      {dashboard.recent.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="assistant-history-heading">
          <h2 id="assistant-history-heading" className="font-semibold text-slate-950">Consultas recientes</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {dashboard.recent.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <Link href={`?consulta=${item.id}`} className="font-medium text-blue-700 hover:underline">{intentLabel[item.intent]}</Link>
                <span className="text-xs text-slate-500">{item.windowDays} días · {formatDateTimeInSantiago(item.createdAt)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-slate-500">El historial no guarda preguntas libres ni conversaciones y expira a los 90 días.</p>
        </section>
      )}
    </div>
  );
}
