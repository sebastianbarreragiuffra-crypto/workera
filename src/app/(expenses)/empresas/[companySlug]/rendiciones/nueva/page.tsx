import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateExpenseReportForm } from "@/components/expenses/ExpenseForms";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";

export default async function NewExpenseReportPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context?.canSubmit) notFound();
  const base = `/empresas/${context.slug}/rendiciones`;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div><Link href={base} className="text-sm font-medium text-arcotex-blue-dark hover:underline">← Volver a Rendiciones</Link><h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Nueva rendición</h1><p className="mt-2 text-sm text-slate-500">Primero crea el borrador; luego podrás agregar cada gasto.</p></div>
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <CreateExpenseReportForm companySlug={context.slug} />
      </section>
    </div>
  );
}
