import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryLimitsForm } from "@/components/expenses/ExpenseForms";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpensePolicySettings } from "@/lib/expenses/data";
import { createClient } from "@/lib/supabase/server";

export default async function ExpensePoliciesPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context || (!context.canConfigure && !context.canManage)) notFound();
  const settings = await getExpensePolicySettings(supabase, context);
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <Link href={base} className="text-sm font-medium text-arcotex-blue-dark hover:underline">← Volver a Rendiciones</Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Políticas de gasto</h1>
        <p className="mt-2 text-sm text-slate-500">Define un monto máximo por categoría. Un gasto que lo supere bloquea el envío de la rendición hasta corregirlo -- nunca se ajusta el monto en silencio.</p>
      </div>
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        {settings.policyId ? (
          <CategoryLimitsForm
            companySlug={context.slug}
            policyId={settings.policyId}
            categories={settings.categories}
            categoryLimits={settings.categoryLimits}
          />
        ) : (
          <p className="text-sm text-slate-500">Todavía no hay una política activa para esta empresa.</p>
        )}
      </section>
    </div>
  );
}
