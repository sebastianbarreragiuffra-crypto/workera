import Link from "next/link";
import { notFound } from "next/navigation";
import { AddExpenseItemForm, ExpenseDecisionForm, ExpenseOcrReviewForm, ExpenseReceiptUploadForm, LinkExpenseAdvanceForm, ReconcileExpenseReportForm, SubmitExpenseReportForm, UpdateCostCenterForm, WithdrawExpenseReportForm } from "@/components/expenses/ExpenseForms";
import { ExpenseStatusBadge } from "@/components/expenses/ExpenseStatusBadge";
import { deleteExpenseItemAction } from "../actions";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getActiveOrganizationUnits, getExpenseReportDetail, getOwnPendingExpenseAdvances } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";
import { todayInSantiago } from "@/lib/view-models/date-utils";

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function confidenceLabel(value: number | null): string {
  return value === null ? "sin confianza informada" : `${Math.round(value * 100)}% de confianza`;
}

const OCR_FIELD_LABELS: Record<string, string> = {
  merchantName: "Comercio",
  expenseDate: "Fecha",
  netAmount: "Neto",
  taxAmount: "Impuesto",
  totalAmount: "Total",
  currencyCode: "Moneda",
};

export default async function ExpenseReportPage({ params }: { params: Promise<{ companySlug: string; reportId: string }> }) {
  const { companySlug, reportId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) notFound();
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) notFound();
  const report = await getExpenseReportDetail(supabase, context, reportId);
  if (!report) notFound();
  const editable = report.status === "DRAFT" && (report.isOwn || context.canManage);
  const [ownPendingAdvances, organizationUnits] = await Promise.all([
    editable && report.isOwn ? getOwnPendingExpenseAdvances(supabase, context, report.currencyCode, report.advanceId) : Promise.resolve([]),
    editable ? getActiveOrganizationUnits(supabase, context, report.organizationUnitId) : Promise.resolve([]),
  ]);
  const categoryNames = new Map(report.categories.map((category) => [category.id, category.name]));
  const receiptRequired = new Map(report.categories.map((category) => [category.id, category.requiresReceipt]));
  const missingRequiredReceipts = report.items.some((item) => item.categoryId && receiptRequired.get(item.categoryId) && !item.receipt);
  const awaitingDecision = report.status === "SUBMITTED" || report.status === "IN_REVIEW";
  // Separación de funciones: si ya decidiste un paso de esta ronda, el
  // siguiente paso es de otra persona -- aunque tu rol tenga permiso formal.
  const alreadyDecidedThisRound = report.decisions.some(
    (decision) => decision.reviewRound === report.reviewRound && decision.decidedBy === context.userId
  );
  const canDecide = awaitingDecision && !report.isOwn && !alreadyDecidedThisRound && (context.canApprove || context.canManage);
  const canWithdraw = awaitingDecision && (report.isOwn || context.canManage);
  const decisionsThisRound = report.decisions.filter((decision) => decision.reviewRound === report.reviewRound);
  const canReconcile = report.status === "APPROVED" && context.canReconcile;
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="space-y-6">
      <div><Link href={base} className="text-sm font-medium text-arcotex-blue-dark hover:underline">← Volver a Rendiciones</Link></div>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-slate-500">{report.referenceNumber}</span><ExpenseStatusBadge status={report.status} /></div><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{report.title}</h1>{report.purpose && <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{report.purpose}</p>}</div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-right shadow-sm"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total</p><p className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{formatExpenseMoney(report.totalAmount, report.currencyCode)}</p></div>
      </header>

      {editable && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4"><h2 className="font-semibold text-slate-900">Agregar gasto</h2><p className="mt-1 text-xs text-slate-500">Después de guardar el gasto podrás adjuntar su comprobante privado.</p></div>
          <AddExpenseItemForm companySlug={context.slug} reportId={report.id} currencyCode={report.currencyCode} categories={report.categories} defaultDate={todayInSantiago()} />
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-900">Gastos ({report.items.length})</h2></div>
          {report.items.length === 0 ? <div className="px-5 py-10 text-center text-sm text-slate-500">Todavía no agregas gastos.</div> : (
            <ul className="divide-y divide-slate-100">
              {report.items.map((item) => (
                <li key={item.id} className="px-5 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{item.description}</span>{item.categoryId && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{categoryNames.get(item.categoryId)}</span>}{item.categoryId && receiptRequired.get(item.categoryId) && <span className="text-[11px] font-medium text-amber-700">Comprobante obligatorio</span>}</div><p className="mt-1 text-xs text-slate-500">{shortDate(item.expenseDate)}{item.merchantName ? ` · ${item.merchantName}` : ""}</p></div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end"><span className="font-semibold tabular-nums text-slate-900">{formatExpenseMoney(item.totalAmount, report.currencyCode)}</span>{editable && <form action={deleteExpenseItemAction}><input type="hidden" name="companySlug" value={context.slug} /><input type="hidden" name="reportId" value={report.id} /><input type="hidden" name="itemId" value={item.id} /><button type="submit" className="text-xs font-medium text-critical hover:underline">Quitar</button></form>}</div>
                  </div>
                  {item.receipt && (() => {
                    const extraction = item.receipt.extraction;
                    const canReviewOcr = Boolean(extraction) && (
                      (report.status === "DRAFT" && (report.isOwn || context.canManage))
                      || ((report.status === "SUBMITTED" || report.status === "IN_REVIEW") && (context.canApprove || context.canManage))
                      || context.canManage
                    );
                    return <div className="mt-3 space-y-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`${base}/comprobantes/${item.receipt.id}`} target="_blank" className="font-medium text-arcotex-blue-dark hover:underline">Ver {item.receipt.originalFilename}</Link>
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">Guardado privado</span>
                        {item.receipt.duplicateOfReceiptId && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">Posible duplicado</span>}
                        {item.receipt.status === "UPLOADED" && <span className="text-slate-500">OCR en cola</span>}
                        {item.receipt.status === "PROCESSING" && <span className="text-blue-700">OCR analizando…</span>}
                        {item.receipt.status === "FAILED" && <span className="text-critical">OCR no disponible; revisa manualmente</span>}
                        {item.receipt.status === "PROCESSED" && <span className="text-success">OCR procesado · {confidenceLabel(extraction?.confidence ?? null)}</span>}
                      </div>
                      {extraction && <div className={`rounded-lg border p-3 ${extraction.requiresHumanReview ? "border-amber-200 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/60"}`}>
                        <p className="font-semibold text-slate-800">Sugerencia OCR — confirma siempre contra el comprobante original.</p>
                        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                          <div><dt className="inline text-slate-500">Comercio: </dt><dd className="inline text-slate-800">{extraction.fields.merchantName.value ?? "No detectado"}</dd></div>
                          <div><dt className="inline text-slate-500">Fecha: </dt><dd className="inline text-slate-800">{extraction.fields.transactionDate.value ?? "No detectada"}</dd></div>
                          <div><dt className="inline text-slate-500">Neto: </dt><dd className="inline text-slate-800">{extraction.fields.subtotal.value ?? "No detectado"}</dd></div>
                          <div><dt className="inline text-slate-500">Impuesto: </dt><dd className="inline text-slate-800">{extraction.fields.totalTax.value ?? "No detectado"}</dd></div>
                          <div><dt className="inline text-slate-500">Total: </dt><dd className="inline text-slate-800">{extraction.fields.total.value ?? "No detectado"} {extraction.fields.currencyCode.value ?? ""}</dd></div>
                        </dl>
                        {extraction.discrepancies.length > 0 && <div className="mt-2"><p className="font-medium text-amber-900">Diferencias con lo declarado:</p><ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-900">{extraction.discrepancies.map((difference, index) => <li key={`${difference.field}-${index}`}>{OCR_FIELD_LABELS[difference.field] ?? difference.field}: declarado “{String(difference.declared)}”, OCR “{String(difference.extracted)}”</li>)}</ul></div>}
                        {extraction.requiresHumanReview && <p className="mt-2 font-medium text-amber-900">Requiere revisión manual por baja confianza, campos faltantes o diferencias.</p>}
                        {extraction.humanReview?.decision && <p className="mt-2 text-slate-600">Revisión registrada: {extraction.humanReview.decision === "ACCEPTED" ? "aceptada como referencia" : "rechazada"}{extraction.humanReview.comment ? ` · ${extraction.humanReview.comment}` : ""}.</p>}
                        {canReviewOcr && !extraction.humanReview?.decision && <ExpenseOcrReviewForm companySlug={context.slug} reportId={report.id} receiptId={item.receipt.id} />}
                      </div>}
                    </div>;
                  })()}
                  {editable && <ExpenseReceiptUploadForm companySlug={context.slug} reportId={report.id} itemId={item.id} hasReceipt={Boolean(item.receipt)} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-4">
          {editable && organizationUnits.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-slate-900">Centro de costo</h2>
              <div className="mt-4">
                <UpdateCostCenterForm companySlug={context.slug} reportId={report.id} currentOrganizationUnitId={report.organizationUnitId} options={organizationUnits} />
              </div>
            </div>
          )}
          {editable && report.isOwn && (ownPendingAdvances.length > 0 || report.advanceId) && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-slate-900">Anticipo</h2>
              <p className="mt-1 text-xs text-slate-500">Si esta rendición es contra un fondo por rendir, selecciónalo -- si no, deja &quot;Sin anticipo&quot; para un reembolso normal.</p>
              <div className="mt-4">
                <LinkExpenseAdvanceForm companySlug={context.slug} reportId={report.id} currentAdvanceId={report.advanceId} options={ownPendingAdvances} />
              </div>
            </div>
          )}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">Siguiente paso</h2>{editable ? <><p className="mt-2 text-sm leading-6 text-slate-500">Al enviar, el borrador quedará bloqueado y pasará a revisión.</p>{missingRequiredReceipts && <p className="mt-2 text-xs font-medium text-amber-700">Faltan comprobantes obligatorios.</p>}<div className="mt-4"><SubmitExpenseReportForm companySlug={context.slug} reportId={report.id} disabled={report.items.length === 0 || report.totalAmount <= 0 || missingRequiredReceipts} /></div></> : canWithdraw ? <><p className="mt-2 text-sm leading-6 text-slate-500">Pendiente de revisión. Puedes retirarla para corregirla antes de que alguien la decida.</p><div className="mt-4"><WithdrawExpenseReportForm companySlug={context.slug} reportId={report.id} /></div></> : <p className="mt-2 text-sm leading-6 text-slate-500">Esta rendición ya fue enviada y no admite nuevos gastos.</p>}</div>
          {canReconcile && <div className="rounded-xl border border-blue-100 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">Conciliación</h2><p className="mb-4 mt-2 text-sm leading-6 text-slate-500">Registra la referencia de pago o el asiento contable una vez pagado el reembolso.</p><ReconcileExpenseReportForm companySlug={context.slug} reportId={report.id} /></div>}
          {report.status === "PAID" && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-5 text-emerald-900"><strong>Conciliada.</strong> Referencia: {report.paymentReference}{report.paidAt && ` · ${shortDate(report.paidAt.slice(0, 10))}`}</div>}
          {canDecide && <div className="rounded-xl border border-blue-100 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">Revisión</h2><p className="mt-1 text-xs text-slate-500">{report.requiredApprovalSteps > 1 ? `Paso ${decisionsThisRound.length + 1} de ${report.requiredApprovalSteps} -- por el monto de esta rendición se requieren dos aprobaciones de personas distintas.` : "Un solo paso de aprobación."}</p><p className="mb-4 mt-2 text-sm leading-6 text-slate-500">Revisa gastos y comprobantes antes de registrar una decisión.</p><ExpenseDecisionForm companySlug={context.slug} reportId={report.id} /></div>}
          {awaitingDecision && report.isOwn && (context.canApprove || context.canManage) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900"><strong>Segregación de funciones.</strong> Aunque tengas permiso de aprobación, otra persona debe revisar esta rendición.</div>}
          {awaitingDecision && !report.isOwn && alreadyDecidedThisRound && (context.canApprove || context.canManage) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900"><strong>Segregación de funciones.</strong> Ya registraste una decisión en esta ronda; el siguiente paso lo debe resolver otra persona.</div>}
          {report.decisions.length > 0 && <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">Historial de revisión</h2><ul className="mt-3 space-y-3">{report.decisions.map((decision) => <li key={decision.id} className="border-l-2 border-slate-200 pl-3 text-xs text-slate-600"><div className="font-semibold text-slate-800">Ronda {decision.reviewRound}, paso {decision.stepNumber}: {decision.decision === "APPROVED" ? "Aprobada" : decision.decision === "REJECTED" ? "Rechazada" : "Devuelta"}</div>{decision.comment && <p className="mt-1 leading-5">{decision.comment}</p>}</li>)}</ul></div>}
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-5 text-blue-900"><strong>Aislamiento activo.</strong> Esta información pertenece únicamente a {context.name} y respeta tus permisos dentro de la empresa.</div>
        </aside>
      </div>
    </div>
  );
}
