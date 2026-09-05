import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { getCurrentProfile } from "@/lib/auth/session";
import { listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveCompany } from "@/lib/tenant/resolve-active-company";
import { hasLegacyWorkforceWorkspace } from "@/lib/tenant/legacy-workforce";

export default async function CompanyHomePage({ params }: { params: Promise<{ companySlug: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const { companySlug } = await params;
  const supabase = await createClient();
  const [resolution, expenseCompanies] = await Promise.all([
    resolveActiveCompany(supabase),
    listExpenseCompaniesFromClient(supabase, profile.id),
  ]);
  const memberships = resolution.kind === "NONE"
    ? []
    : resolution.kind === "SINGLE"
      ? [resolution.membership]
      : resolution.memberships;
  const membership = memberships.find((item) => item.companySlug === companySlug.toLowerCase());
  if (!membership) notFound();

  const expensesEnabled = expenseCompanies.some((company) => company.id === membership.companyId);
  const workforceEnabled = hasLegacyWorkforceWorkspace(membership);

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4"><GestoraBrand inverse /></header>
      <main className="mx-auto max-w-4xl px-4 py-12">
        <Link href={memberships.length > 1 ? "/empresas" : "/"} className="text-sm font-medium text-arcotex-blue hover:underline">← Cambiar empresa</Link>
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <p className="text-sm font-medium text-arcotex-blue">Espacio empresarial</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">{membership.companyName}</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            {membership.status === "ONBOARDING"
              ? "La empresa está en configuración. Los módulos se habilitan de forma independiente cuando quedan listos."
              : "Selecciona uno de los módulos habilitados para esta empresa."}
          </p>
          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            {expensesEnabled && (
              <Link href={`/empresas/${membership.companySlug}/rendiciones`} className="rounded-xl border border-sky-200 bg-sky-50 p-5 hover:border-sky-400">
                <h2 className="font-semibold text-slate-950">Rendiciones</h2>
                <p className="mt-1 text-sm text-slate-600">Gastos, anticipos, aprobaciones y conciliación.</p>
              </Link>
            )}
            {workforceEnabled && (
              <Link href="/dashboard" className="rounded-xl border border-slate-200 p-5 hover:border-arcotex-blue">
                <h2 className="font-semibold text-slate-950">Personas y asistencia</h2>
                <p className="mt-1 text-sm text-slate-600">Workspace laboral habilitado para esta empresa.</p>
              </Link>
            )}
          </div>
          {!expensesEnabled && !workforceEnabled && (
            <div className="mt-7 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              Tu acceso está activo, pero esta empresa aún no tiene un módulo operativo habilitado.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
