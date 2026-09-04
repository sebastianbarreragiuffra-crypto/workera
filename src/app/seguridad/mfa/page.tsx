import Link from "next/link";
import { redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { MfaChallenge } from "@/components/auth/MfaChallenge";
import { MfaSignOut } from "@/components/auth/MfaSignOut";
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

  const [{ data: factors }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);

  const toView = (factor: { id: string; friendly_name?: string; created_at: string }): MfaFactorView => ({
    id: factor.id,
    friendlyName: factor.friendly_name?.trim() || "Autenticador sin nombre",
    createdAt: factor.created_at,
  });

  const verifiedFactors = (factors?.totp ?? []).map(toView);
  const unverifiedFactors = (factors?.all ?? []).filter((factor) => factor.status === "unverified").map(toView);

  // Sección 5 del diseño: el middleware no distingue inscribir de desafiar,
  // manda todo acá y esta pantalla decide. Con un factor ya verificado y la
  // sesión todavía en aal1, lo que corresponde es el desafío -- y solo el
  // desafío: dejar inscribir un factor nuevo sin haber probado el que ya
  // existe sería una forma de saltárselo.
  const needsChallenge = aal?.currentLevel !== "aal2" && verifiedFactors.length > 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <GestoraBrand subtitle="Acceso seguro" />
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm font-medium text-arcotex-blue hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            Volver
          </Link>
          <MfaSignOut />
        </div>
      </div>

      <h1 className="mt-8 text-2xl font-semibold text-foreground">Segundo factor de autenticación</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Una contraseña filtrada alcanza para entrar con tu identidad. Con un segundo factor, además hace falta el
        dispositivo que genera los códigos. Se usa el estándar TOTP, así que sirve cualquier aplicación de
        autenticación.
      </p>

      <div className="mt-8">
        {needsChallenge ? (
          <section className="rounded-xl border border-slate-200 bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold text-foreground">Verifica tu identidad</h2>
            <p className="mt-1 text-sm text-slate-600">
              Ya tienes un segundo factor inscrito. Escribe el código que muestra tu aplicación de autenticación para
              continuar.
            </p>
            <div className="mt-4 max-w-sm">
              <MfaChallenge
                factors={verifiedFactors.map((factor) => ({ id: factor.id, friendlyName: factor.friendlyName }))}
              />
            </div>
          </section>
        ) : (
          <MfaEnrollment
            verifiedFactors={verifiedFactors}
            unverifiedFactors={unverifiedFactors}
            requiresMfa={account.requiresMfa}
            isPlatformOwner={account.isPlatformOwner}
          />
        )}
      </div>
    </main>
  );
}
