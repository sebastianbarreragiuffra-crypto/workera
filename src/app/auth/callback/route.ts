import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../lib/supabase/server";

/**
 * Destino de vuelta de OAuth (Google, u otro proveedor que se habilite a
 * futuro). Debe ser pública en el middleware (`src/lib/supabase/middleware.ts`,
 * `PUBLIC_PATHS`) porque llega ANTES de que exista sesión -- este handler es
 * el que recién la crea vía `exchangeCodeForSession`.
 *
 * Tras crear la sesión, redirige a `/` exactamente igual que el login de
 * email+password (`src/app/login/actions.ts`) -- mismo destino, mismo
 * gate de acceso real: el layout de `(app)` exige `profile.role` y
 * `profile.active`, así que un usuario de Google sin rol asignado
 * simplemente rebota a `/login` desde ahí, nunca entra a ninguna pantalla.
 * Este route handler NO decide autorización por sí mismo, solo sesión.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth`);
}
