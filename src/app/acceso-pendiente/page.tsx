import { redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { getCurrentProfile } from "@/lib/auth/session";
import { logout } from "@/app/login/actions";

export default async function PendingAccessPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4"><GestoraBrand inverse /></header>
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-950">Tu cuenta está activa</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Aún no tienes una empresa o módulo asignado. Cuando el propietario envíe la invitación, vuelve a iniciar sesión para completar el acceso.
        </p>
        <form action={logout} className="mt-7">
          <button type="submit" className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cerrar sesión</button>
        </form>
      </main>
    </div>
  );
}
