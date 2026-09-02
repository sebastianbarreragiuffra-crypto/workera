import Link from "next/link";
import { logout } from "@/app/login/actions";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import type { ExpenseCompanyOption } from "@/lib/expenses/access";

export function ExpenseCompanyPicker({ companies, displayName }: { companies: ExpenseCompanyOption[]; displayName: string }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-slate-200 bg-arcotex-navy text-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <GestoraBrand inverse />
          <form action={logout}><button className="text-sm text-slate-300 hover:text-white">Cerrar sesión</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <p className="text-sm font-medium text-arcotex-blue">Hola, {displayName}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Selecciona una empresa</h1>
        <p className="mt-2 text-sm text-slate-500">Verás solamente empresas donde tienes una membresía activa y Rendiciones está contratado.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {companies.map((company) => (
            <Link
              key={company.id}
              href={`/empresas/${company.slug}/rendiciones`}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-arcotex-blue hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-900 group-hover:text-arcotex-blue-dark">{company.name}</h2>
                  <p className="mt-1 text-sm text-slate-500">Rendiciones y reembolsos</p>
                </div>
                {company.moduleStatus === "PILOT" && <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700">Piloto</span>}
              </div>
              <div className="mt-5 text-sm font-medium text-arcotex-blue-dark">Abrir módulo →</div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
