import { logout } from "../../app/login/actions";

/** Fase 8, restilizado en Fase 8B.1 (azul oscuro). Nombre/rol/área ahora viven en el bloque de usuario del Sidebar -- el topbar solo da contexto de fecha y logout. */
export function Topbar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between bg-arcotex-navy-dark px-6">
      <div className="text-sm font-medium text-slate-200 capitalize">
        {new Date().toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })}
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="rounded-md border border-white/20 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Cerrar sesión
        </button>
      </form>
    </header>
  );
}
