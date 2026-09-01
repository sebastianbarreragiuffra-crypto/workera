import Link from "next/link";
import { logout } from "@/app/login/actions";
import { GestoraBrand } from "./GestoraBrand";
import { PlatformNavigation } from "./PlatformNavigation";

const ROLE_LABEL = {
  OWNER: "Propietario de plataforma",
  ADMIN: "Administrador de plataforma",
  SUPPORT: "Soporte de plataforma",
  VIEWER: "Lectura de plataforma",
} as const;

export function PlatformShell({
  children,
  displayName,
  role,
  workspaceHref,
}: {
  children: React.ReactNode;
  displayName: string;
  role: keyof typeof ROLE_LABEL;
  workspaceHref?: string | null;
}) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-16 shrink-0 flex-col bg-arcotex-navy md:w-64" aria-label="Panel de plataforma">
        <div className="flex h-16 items-center border-b border-white/10 px-3 md:px-4">
          <GestoraBrand inverse compact className="md:hidden" />
          <GestoraBrand inverse className="hidden md:inline-flex" />
        </div>

        <div className="px-2 py-4 md:px-3">
          <div className="hidden rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 md:block">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-200">Control plane</div>
            <div className="mt-1 text-xs leading-5 text-slate-300">Clientes, accesos, módulos y organización.</div>
          </div>
        </div>

        <PlatformNavigation />

        <div className="mt-auto border-t border-white/10 p-3 md:p-4">
          <div className="hidden md:block">
            <div className="truncate text-sm font-medium text-white">{displayName}</div>
            <div className="mt-0.5 truncate text-xs text-slate-400">{ROLE_LABEL[role]}</div>
          </div>
          <form action={logout} className="mt-0 md:mt-3">
            <button
              type="submit"
              aria-label="Cerrar sesión"
              className="flex w-full items-center justify-center rounded-md border border-white/15 px-2 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              title="Cerrar sesión"
            >
              <span className="md:hidden" aria-hidden="true">↪</span>
              <span className="hidden md:inline">Cerrar sesión</span>
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-white px-4 sm:px-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-arcotex-blue">GESTORA</div>
            <div className="text-sm font-medium text-slate-700">Administración multiempresa</div>
          </div>
          {workspaceHref ? (
            <Link
              href={workspaceHref}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-arcotex-blue hover:bg-blue-50 hover:text-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
            >
              <span className="hidden sm:inline">Ir al workspace </span>ARCOTEX
            </Link>
          ) : (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">Modo plataforma</span>
          )}
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
