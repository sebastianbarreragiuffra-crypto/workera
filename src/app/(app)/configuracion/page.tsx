import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { PageHeader } from "../../../components/shell/PageHeader";
import { SectionCard } from "../../../components/shell/SectionCard";

export default async function ConfigurationPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN") redirect("/dashboard");

  return (
    <div className="space-y-4">
      <PageHeader title="Configuración" subtitle="Datos maestros y parámetros de operación." />

      <SectionCard title="Disponible">
        <div className="space-y-2">
          <Link
            href="/configuracion/horarios"
            className="block rounded-md border border-border p-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            <div className="text-sm font-medium text-slate-900">Horarios</div>
            <p className="mt-0.5 text-xs text-slate-500">
              Horarios de trabajo, asignación por trabajador y exenciones de control horario.
            </p>
          </Link>
          <Link
            href="/configuracion/motor-de-reglas"
            className="block rounded-md border border-border p-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            <div className="text-sm font-medium text-slate-900">Motor de reglas</div>
            <p className="mt-0.5 text-xs text-slate-500">
              Procesa un día y revisa el historial de corridas automáticas y manuales.
            </p>
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}
