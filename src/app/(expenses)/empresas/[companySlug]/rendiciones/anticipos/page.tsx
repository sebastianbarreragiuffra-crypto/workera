import { notFound } from "next/navigation";
import { CancelExpenseAdvanceForm, GrantExpenseAdvanceForm, SettleExpenseAdvanceForm } from "@/components/expenses/ExpenseForms";
import { getCompanyMembersForAdvances, getExpenseAdvances } from "@/lib/expenses/data";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { EXPENSE_ADVANCE_STATUS_LABEL, formatExpenseMoney } from "@/lib/expenses/presentation";
import { createClient } from "@/lib/supabase/server";

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "America/Santiago" }).format(new Date(value));
}

export default async function ExpenseAdvancesPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) notFound();

  const [advances, members] = await Promise.all([
    getExpenseAdvances(supabase, context),
    context.canReconcile ? getCompanyMembersForAdvances(supabase, context) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-arcotex-blue">Control financiero</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Anticipos y fondos por rendir</h1>
        <p className="mt-2 text-sm text-slate-500">
          {context.canReconcile
            ? `Dinero entregado por adelantado en ${context.name}, para que la persona rinda después contra ese anticipo en vez de esperar un reembolso.`
            : "Tus anticipos otorgados por la empresa -- puedes vincularlos a una rendición en borrador desde su propia página."}
        </p>
      </header>

      {context.canReconcile && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-medium text-slate-900">Otorgar un anticipo</h2>
          <div className="mt-4 max-w-xl">
            <GrantExpenseAdvanceForm companySlug={context.slug} members={members} />
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {advances.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="text-3xl" aria-hidden="true">💵</div>
            <h2 className="mt-3 font-medium text-slate-900">Sin anticipos</h2>
            <p className="mt-1 text-sm text-slate-500">{context.canReconcile ? "Todavía no se ha otorgado ningún anticipo." : "No tienes anticipos otorgados."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  {context.canReconcile && <th className="px-5 py-3">Persona</th>}
                  <th className="px-4 py-3">Motivo</th>
                  <th className="px-4 py-3">Otorgado</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-5 py-3 text-right">Monto</th>
                  {context.canReconcile && <th className="px-4 py-3 text-right">Acciones</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {advances.map((advance) => (
                  <tr key={advance.id} className="hover:bg-slate-50">
                    {context.canReconcile && <td className="px-5 py-4 font-medium text-slate-900">{advance.recipientName}</td>}
                    <td className="px-4 py-4 text-slate-700">{advance.purpose}</td>
                    <td className="px-4 py-4 text-slate-500">{dateLabel(advance.grantedAt)}</td>
                    <td className="px-4 py-4">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          advance.status === "PENDING" ? "bg-blue-50 text-blue-700" : advance.status === "SETTLED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {EXPENSE_ADVANCE_STATUS_LABEL[advance.status]}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-900">{formatExpenseMoney(advance.amount, advance.currencyCode)}</td>
                    {context.canReconcile && (
                      <td className="px-4 py-4">
                        {advance.status === "PENDING" && (
                          <div className="flex justify-end gap-3">
                            <SettleExpenseAdvanceForm companySlug={context.slug} advanceId={advance.id} />
                            <CancelExpenseAdvanceForm companySlug={context.slug} advanceId={advance.id} />
                          </div>
                        )}
                      </td>
                    )}
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
