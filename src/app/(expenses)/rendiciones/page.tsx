import Link from "next/link";
import { redirect } from "next/navigation";
import { ExpenseCompanyPicker } from "@/components/expenses/ExpenseCompanyPicker";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { getCurrentProfile } from "@/lib/auth/session";
import { listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";

export default async function ExpenseCompanySelectionPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=%2Frendiciones");

  const supabase = await createClient();
  const companies = await listExpenseCompaniesFromClient(supabase, profile.id);
  if (companies.length === 1) redirect(`/empresas/${companies[0].slug}/rendiciones`);
  if (companies.length > 1) return <ExpenseCompanyPicker companies={companies} displayName={profile.display_name} />;

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4"><GestoraBrand inverse /></header>
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-950">Rendiciones todavía no está disponible</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">Necesitas una membresía activa en una empresa que tenga contratado este módulo.</p>
        <Link href="/" className="mt-6 inline-flex rounded-lg bg-arcotex-blue px-4 py-2.5 text-sm font-semibold text-white hover:bg-arcotex-blue-dark">Volver al inicio</Link>
      </main>
    </div>
  );
}
