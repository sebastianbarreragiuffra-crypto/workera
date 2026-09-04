import Link from "next/link";
import { notFound } from "next/navigation";
import { ExpenseStatusBadge } from "@/components/expenses/ExpenseStatusBadge";
import { ExpenseListFiltersForm, ExpensePaginationNav } from "@/components/expenses/ExpenseListControls";
import { ExpenseBankResolutionForms, ExpenseBankStatementImportForm } from "@/components/expenses/ExpenseBankReconciliationForms";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import {
  EXPENSE_BANK_TRANSACTION_STATUSES,
  EXPENSE_RECONCILIATION_STATUSES,
  getExpenseBankCandidates,
  getExpenseBankTransactions,
  getExpenseReconciliationQueue,
  parseExpenseListFilters,
  type ExpenseBankTransactionStatus,
} from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

function dateLabel(value: string | null): string {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "America/Santiago" }).format(new Date(value));
}

function calendarDateLabel(value: string): string {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "America/Santiago" }).format(new Date(`${value}T12:00:00-04:00`));
}

function currentMonthInSantiago(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  return `${year}-${month}`;
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export default async function ExpenseReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ pagina?: string; estado?: string; desde?: string; hasta?: string; banco?: string; movimiento?: string }>;
}) {
  const [{ companySlug }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context || !context.canReconcile) notFound();
  const filters = parseExpenseListFilters(query);
  const bankStatus: ExpenseBankTransactionStatus = EXPENSE_BANK_TRANSACTION_STATUSES.includes(query.banco as ExpenseBankTransactionStatus)
    ? (query.banco as ExpenseBankTransactionStatus)
    : "UNMATCHED";
  const [{ reports, pagination }, bankQueue] = await Promise.all([
    getExpenseReconciliationQueue(supabase, context, filters),
    getExpenseBankTransactions(supabase, context, bankStatus),
  ]);
  const base = `/empresas/${context.slug}/rendiciones`;
  const selectedTransaction = isUuid(query.movimiento)
    ? bankQueue.transactions.find((transaction) => transaction.id === query.movimiento) ?? null
    : null;
  const candidates = selectedTransaction?.status === "UNMATCHED"
    ? await getExpenseBankCandidates(supabase, context, selectedTransaction.id)
    : [];

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Control financiero</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Conciliación</h1>
        <p className="mt-2 text-sm text-slate-500">Rendiciones aprobadas de {context.name}, pendientes de registrar su pago o ya conciliadas.</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <h2 className="font-medium text-slate-900">Importar pagos del banco</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Sube el CSV exportado por el banco. GESTORA conserva solo fecha, monto, moneda y referencia para proponer coincidencias.
            </p>
            <div className="mt-4"><ExpenseBankStatementImportForm companySlug={context.slug} /></div>
          </div>

          <div className="min-w-0 border-t border-slate-200 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium text-slate-900">Movimientos bancarios</h2>
                <p className="mt-1 text-sm text-slate-500">{bankQueue.totalCount} movimiento(s) en esta vista; se muestran hasta 25.</p>
              </div>
              <nav aria-label="Estado de movimientos" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-xs font-medium">
                {(["UNMATCHED", "MATCHED", "IGNORED"] as const).map((status) => (
                  <Link
                    key={status}
                    href={`${base}/conciliacion?banco=${status}`}
                    className={`rounded-md px-3 py-2 ${bankStatus === status ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                  >
                    {status === "UNMATCHED" ? "Pendientes" : status === "MATCHED" ? "Conciliados" : "Apartados"}
                  </Link>
                ))}
              </nav>
            </div>

            {bankQueue.transactions.length === 0 ? (
              <p className="mt-4 rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                {bankStatus === "UNMATCHED" ? "No hay movimientos pendientes. Importa una cartola para comenzar." : "No hay movimientos en este estado."}
              </p>
            ) : (
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                  {bankQueue.transactions.map((transaction) => (
                    <Link
                      key={transaction.id}
                      href={`${base}/conciliacion?banco=${bankStatus}&movimiento=${transaction.id}`}
                      className={`block rounded-lg border p-3 transition-colors ${selectedTransaction?.id === transaction.id ? "border-arcotex-blue bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{transaction.bankReference}</p>
                          <p className="mt-1 truncate text-xs text-slate-500">{transaction.description ?? "Sin descripción"}</p>
                        </div>
                        <p className="shrink-0 font-semibold tabular-nums text-slate-900">{formatExpenseMoney(transaction.amount, transaction.currencyCode)}</p>
                      </div>
                      <p className="mt-2 text-xs text-slate-400">{calendarDateLabel(transaction.transactionDate)}</p>
                    </Link>
                  ))}
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  {selectedTransaction?.status === "UNMATCHED" ? (
                    <ExpenseBankResolutionForms
                      companySlug={context.slug}
                      transactionId={selectedTransaction.id}
                      candidates={candidates}
                    />
                  ) : selectedTransaction ? (
                    <div>
                      <h3 className="font-medium text-slate-900">Movimiento resuelto</h3>
                      <p className="mt-2 text-sm text-slate-600">
                        {selectedTransaction.status === "MATCHED"
                          ? "Fue asociado a una rendición y quedó auditado."
                          : `Fue apartado: ${selectedTransaction.ignoredReason ?? "sin detalle"}.`}
                      </p>
                    </div>
                  ) : (
                    <p className="py-10 text-center text-sm text-slate-500">Selecciona un movimiento para revisar su detalle.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-medium text-slate-900">Planilla mensual de reembolso</h2>
        <p className="mt-1 text-sm text-slate-500">
          Cuánto hay que devolverle a cada persona por comprobantes pagados con su tarjeta personal, agrupado por moneda -- incluye rendiciones
          aprobadas o ya pagadas, enviadas dentro del mes elegido.
        </p>
        <form action={`${base}/conciliacion/exportar`} method="GET" className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Mes</span>
            <input
              type="month"
              name="mes"
              defaultValue={currentMonthInSantiago()}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button type="submit" className="rounded-lg bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark">
            Descargar planilla (.xlsx)
          </button>
        </form>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <ExpenseListFiltersForm filters={filters} statuses={EXPENSE_RECONCILIATION_STATUSES} legend="Filtrar la bandeja de conciliación" />
        {reports.length === 0 ? (
          <div className="px-6 py-14 text-center"><div className="text-3xl" aria-hidden="true">✓</div><h2 className="mt-3 font-medium text-slate-900">Nada pendiente de pago</h2><p className="mt-1 text-sm text-slate-500">No hay rendiciones aprobadas esperando conciliación.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Folio</th><th className="px-4 py-3">Persona</th><th className="px-4 py-3">Rendición</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Referencia de pago</th><th className="px-5 py-3 text-right">Total</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {reports.map((report) => (
                  <tr key={report.id} className="hover:bg-slate-50">
                    <td className="px-5 py-4 font-mono text-xs text-slate-500">{report.referenceNumber}</td>
                    <td className="px-4 py-4 font-medium text-slate-900">{report.submitterName}</td>
                    <td className="px-4 py-4"><Link href={`${base}/${report.id}`} className="font-medium text-slate-900 hover:text-arcotex-blue-dark">{report.title}</Link></td>
                    <td className="px-4 py-4"><ExpenseStatusBadge status={report.status} /></td>
                    <td className="px-4 py-4 text-slate-500">{report.paymentReference ?? (report.paidAt ? "—" : "Pendiente")}{report.paidAt && <div className="mt-0.5 text-xs text-slate-400">{dateLabel(report.paidAt)}</div>}</td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-900">{formatExpenseMoney(report.totalAmount, report.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ExpensePaginationNav basePath={`${base}/conciliacion`} filters={filters} pagination={pagination} />
      </section>
    </div>
  );
}
