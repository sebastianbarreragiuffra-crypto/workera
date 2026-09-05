import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { resolvePostLoginDestination } from "@/lib/auth/mfa-account";
import {
  publicAppUrl,
  resolvePublicOrigin,
  safeInternalDestination,
} from "@/lib/auth/public-origin";
import { acceptCurrentUserInvitations } from "@/lib/platform/invitations";
import { createClient } from "@/lib/supabase/server";

const EMAIL_OTP_TYPES = new Set<EmailOtpType>(["invite", "email", "magiclink", "recovery", "email_change"]);
const CONFIRM_CALLBACK_PATHS = new Set(["/auth/callback", "/auth/confirm"]);

export async function GET(request: NextRequest) {
  const { searchParams, origin: requestOrigin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const requestedType = searchParams.get("type") as EmailOtpType | null;
  const next = safeInternalDestination(searchParams.get("next"), "/", CONFIRM_CALLBACK_PATHS);

  try {
    resolvePublicOrigin(requestOrigin);
  } catch {
    console.error("[auth] origen público ausente o inválido en confirmación", {
      event: "auth_public_origin_unavailable",
    });
    return new NextResponse("No pudimos confirmar el acceso de forma segura.", { status: 503 });
  }

  if (tokenHash && requestedType && EMAIL_OTP_TYPES.has(requestedType)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: requestedType });
    if (!error) {
      try {
        await acceptCurrentUserInvitations(supabase);
        const mfaDestination = await resolvePostLoginDestination(supabase);
        const destination = mfaDestination === "/" ? next : mfaDestination;
        return NextResponse.redirect(publicAppUrl(destination, requestOrigin));
      } catch {
        console.error("[auth] no se pudo resolver el destino tras confirmar el acceso", {
          event: "confirm_post_login_destination_failed",
        });
        try {
          await supabase.auth.signOut();
        } catch {
          console.error("[auth] no se pudo cerrar la sesión de confirmación incompleta", {
            event: "confirm_partial_session_cleanup_failed",
          });
        }
        return NextResponse.redirect(publicAppUrl("/login?error=security", requestOrigin));
      }
    }
  }

  return NextResponse.redirect(publicAppUrl("/login?error=invite", requestOrigin));
}
