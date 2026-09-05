import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import { acceptCurrentUserInvitations } from "../../../lib/platform/invitations";
import { resolvePostLoginDestination } from "../../../lib/auth/mfa-account";
import { AUTH_FLOW_PATHS, publicAppUrl, resolvePublicOrigin, safeInternalDestination } from "../../../lib/auth/public-origin";

/**
 * Destino de vuelta de OAuth (Google, u otro proveedor que se habilite a
 * futuro). Debe ser pública en el middleware (`src/lib/supabase/middleware.ts`,
 * `PUBLIC_PATHS`) porque llega ANTES de que exista sesión -- este handler es
 * el que recién la crea vía `exchangeCodeForSession`.
 *
 * Tras crear la sesión resuelve el destino con la MISMA función que el login de
 * email+password (`src/app/login/actions.ts`). Las dos formas de crear sesión
 * tienen que decidir el segundo factor igual: si esta se quedara redirigiendo a
 * `/`, una cuenta privilegiada que entra por Google no recibiría el desafío
 * mientras `MFA_ENFORCEMENT_ENABLED` está apagado, que es justo el período en
 * que hay que comprobar que el flujo funciona antes de encender el bloqueo.
 *
 * Este route handler sigue sin decidir autorización por sí mismo, solo sesión:
 * el gate de acceso real lo decide el destino raíz con membresía de plataforma
 * o tenant activa. Una identidad sin asignación termina en acceso pendiente,
 * nunca en un loop de login.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin: requestOrigin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeInternalDestination(searchParams.get("next"), "/", AUTH_FLOW_PATHS);

  try {
    resolvePublicOrigin(requestOrigin);
  } catch {
    console.error("[auth] origen público ausente o inválido en callback OAuth", {
      event: "auth_public_origin_unavailable",
    });
    return new NextResponse("No pudimos completar el inicio de sesión de forma segura.", {
      status: 503,
    });
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      try {
        await acceptCurrentUserInvitations(supabase);
        const mfaDestination = await resolvePostLoginDestination(supabase);
        const destination = mfaDestination === "/"
          ? next
          : `${mfaDestination}?next=${encodeURIComponent(next)}`;
        return NextResponse.redirect(publicAppUrl(destination, requestOrigin));
      } catch {
        console.error("[auth] no se pudo resolver el destino post-login de OAuth", {
          event: "oauth_post_login_destination_failed",
        });
        try {
          await supabase.auth.signOut();
        } catch {
          console.error("[auth] no se pudo cerrar la sesión OAuth incompleta", {
            event: "oauth_partial_session_cleanup_failed",
          });
        }
        return NextResponse.redirect(publicAppUrl("/login?error=security", requestOrigin));
      }
    }
  }

  return NextResponse.redirect(publicAppUrl("/login?error=oauth", requestOrigin));
}
