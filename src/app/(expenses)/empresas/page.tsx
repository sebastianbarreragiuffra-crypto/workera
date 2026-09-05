import Link from "next/link";
import { redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { getCurrentProfile } from "@/lib/auth/session";
import { listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveCompany } from "@/lib/tenant/resolve-active-company";

export default async function CompanySelectionPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=%2Fempresas");

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
  const expenseIds = new Set(expenseCompanies.map((company) => company.id));

  if (memberships.length === 0) redirect("/acceso-pendiente");

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4"><GestoraBrand inverse /></header>
      <main className="mx-auto max-w-4xl px-4 py-12">
        <p className="text-sm font-medium text-arcotex-blue">Hola, {profile.display_name}</p>
        <h1 className="mt-1 text-3xl font-semibold text-slate-950">Elige una empresa</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Cada espacio conserva sus propios usuarios, roles, módulos y datos.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {memberships.map((membership) => (
            <Link
              key={membership.companyId}
              href={`/empresas/${membership.companySlug}`}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-arcotex-blue hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-950">{membership.companyName}</h2>
                  <p className="mt-1 text-xs text-slate-500">{membership.status === "ONBOARDING" ? "Configuración en curso" : "Empresa activa"}</p>
                </div>
                {expenseIds.has(membership.companyId) && (
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">Rendiciones</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
