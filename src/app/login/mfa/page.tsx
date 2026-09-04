import { redirect } from "next/navigation";
import { GestoraBrand } from "@/components/platform/GestoraBrand";
import { MfaChallenge, type MfaChallengeFactor } from "@/components/auth/MfaChallenge";
import { MfaSignOut } from "@/components/auth/MfaSignOut";
import { getMfaAccountState } from "@/lib/auth/mfa-account";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Verificación en dos pasos — GESTORA",
};

/**
 * Desafío tras un login por contraseña correcto (sección 6.2 del diseño).
 *
 * Los tres redirects de acá no son defensivos por costumbre: esta ruta es
 * alcanzable directamente, así que tiene que decidir por sí misma y no confiar
 * en que se llegó desde el formulario de login.
 */
export default async function LoginMfaPage() {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);
  if (!account) redirect("/login");

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect("/");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verifiedFactors: MfaChallengeFactor[] = (factors?.totp ?? []).map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name?.trim() || "Autenticador sin nombre",
  }));

  // Sin ningún factor verificado no hay nada que desafiar: lo que corresponde
  // es inscribir uno.
  if (verifiedFactors.length === 0) redirect("/seguridad/mfa");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-login-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <GestoraBrand subtitle="Acceso seguro" />
        </div>

        <div className="rounded-xl border border-login-border-soft bg-card p-8 shadow-sm">
          <h1 className="text-center text-xl font-semibold text-foreground">Verificación en dos pasos</h1>
          <p className="mt-1 text-center text-sm text-login-muted">
            Abre tu aplicación de autenticación y escribe el código que muestra ahora.
          </p>

          <div className="mt-6">
            <MfaChallenge factors={verifiedFactors} />
          </div>

          <div className="mt-6 flex justify-center border-t border-login-border-soft pt-4">
            <MfaSignOut />
          </div>
        </div>
      </div>
    </main>
  );
}
