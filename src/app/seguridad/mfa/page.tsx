import Link from "next/link";
import { redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { getMfaAccountState } from "@/lib/auth/mfa-account";
import { createClient } from "@/lib/supabase/server";
import { MfaEnrollment, type MfaFactorView } from "./MfaEnrollment";

export const metadata = {
  title: "Segundo factor — GESTORA",
};

/**
 * Pantalla de inscripción y gestión del segundo factor (sección 6.1 del
 * diseño).
 *
 * Vive fuera de los grupos `(app)` y `(platform)` a propósito. El layout de
 * `(app)` exige `profile.role`, y la cuenta OWNER de plataforma puede no tener
 * rol de workspace: si la pantalla viviera ahí, el gate del middleware la
 * mandaría a una ruta que su propio layout devuelve al login, en un rebote sin
 * salida. Acá solo se exige sesión, que es la única condición razonable para
 * una pantalla cuyo propósito es dejar de estar a medio autenticar.
 */
export default async function MfaPage() {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);

  if (!account) {
    redirect("/login");
  }

  const { data: factors } = await supabase.auth.mfa.listFactors();

  const toView = (factor: { id: string; friendly_name?: string; created_at: string }): MfaFactorView => ({
    id: factor.id,
    friendlyName: factor.friendly_name?.trim() || "Autenticador sin nombre",
    createdAt: factor.created_at,
  });

  const verifiedFactors = (factors?.totp ?? []).map(toView);
  const unverifiedFactors = (factors?.all ?? []).filter((factor) => factor.status === "unverified").map(toView);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <GestoraBrand subtitle="Acceso seguro" />
        <Link
          href="/"
          className="text-sm font-medium text-arcotex-blue hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
        >
          Volver
        </Link>
      </div>

      <h1 className="mt-8 text-2xl font-semibold text-foreground">Segundo factor de autenticación</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Una contraseña filtrada alcanza para entrar con tu identidad. Con un segundo factor, además hace falta el
        dispositivo que genera los códigos. Se usa el estándar TOTP, así que sirve cualquier aplicación de
        autenticación.
      </p>

      <div className="mt-8">
        <MfaEnrollment
          verifiedFactors={verifiedFactors}
          unverifiedFactors={unverifiedFactors}
          requiresMfa={account.requiresMfa}
          isPlatformOwner={account.isPlatformOwner}
        />
      </div>
    </main>
  );
}
