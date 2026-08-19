import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../lib/auth/session";
import { Sidebar } from "../../components/shell/Sidebar";
import { Topbar } from "../../components/shell/Topbar";
import { getNavItemsForRole } from "../../components/shell/nav-config";

/**
 * Shell autenticado (Fase 8, PASO 3). Toda ruta bajo `(app)` pasa por acá
 * primero: sin sesión o sin rol asignado -> `/login`, nunca un shell vacío.
 * El middleware (`src/proxy.ts`, Fase 3) ya bloquea rutas sin sesión antes
 * de llegar aquí; este chequeo es la segunda capa (rol, no solo sesión) y
 * la que decide qué navegación mostrar.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.role || !profile.active) {
    redirect("/login");
  }

  const navItems = getNavItemsForRole(profile.role);

  return (
    <div className="flex h-full min-h-screen bg-slate-50">
      <Sidebar items={navItems} appName="Workera" />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar displayName={profile.display_name} role={profile.role} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
