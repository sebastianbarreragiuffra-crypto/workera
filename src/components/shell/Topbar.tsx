import { logout } from "../../app/login/actions";
import { roleLabel } from "./nav-config";
import type { AppRole } from "../../lib/supabase/authorize";

export function Topbar({ displayName, role }: { displayName: string; role: AppRole }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="text-sm text-slate-500">
        {new Date().toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm font-medium text-slate-900">{displayName}</div>
          <div className="text-xs text-slate-500">{roleLabel(role)}</div>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Cerrar sesión
          </button>
        </form>
      </div>
    </header>
  );
}
