import Link from "next/link";
import { logout } from "@/app/login/actions";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import type { ExpenseCompanyContext, ExpenseCompanyOption } from "@/lib/expenses/access";

export function ExpenseShell({
  children,
  context,
  companies,
}: {
  children: React.ReactNode;
  context: ExpenseCompanyContext;
  companies: ExpenseCompanyOption[];
}) {
  const base = `/empresas/${context.slug}/rendiciones`;
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-slate-200 bg-arcotex-navy text-white">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-5">
            <Link href="/" aria-label="Inicio GESTORA"><GestoraBrand inverse /></Link>
            <div className="hidden h-8 w-px bg-white/15 sm:block" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{context.name}</div>
              <div className="text-xs text-slate-300">Rendiciones y reembolsos</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {companies.length > 1 && (
              <Link href="/rendiciones" className="rounded-md border border-white/20 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10">
                Cambiar empresa
              </Link>
            )}
            <form action={logout}>
              <button type="submit" className="rounded-md border border-white/20 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10">
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:px-6 lg:px-8" aria-label="Rendiciones">
          <Link href={base} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Resumen</Link>
          {context.canSubmit && (
            <Link href={`${base}/nueva`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Nueva rendición</Link>
          )}
          {context.canSubmit && (
            <Link href={`${base}/comprobantes`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Comprobantes</Link>
          )}
          {(context.canApprove || context.canManage) && (
            <Link href={`${base}/aprobaciones`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Aprobaciones</Link>
          )}
          {(context.canReadAll || context.canApprove || context.canManage) && (
            <Link href={`${base}/indicadores`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Indicadores</Link>
          )}
          {context.canReconcile && (
            <Link href={`${base}/conciliacion`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Conciliación</Link>
          )}
          {context.canReconcile && (
            <Link href={`${base}/contabilidad`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Contabilidad</Link>
          )}
          {(context.canSubmit || context.canReadAll || context.canApprove || context.canReconcile || context.canManage) && (
            <Link href={`${base}/anticipos`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Anticipos</Link>
          )}
          {(context.canConfigure || context.canManage) && (
            <Link href={`${base}/politicas`} className="min-h-11 shrink-0 rounded-md px-3 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Políticas</Link>
          )}
        </nav>
      </div>

      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
