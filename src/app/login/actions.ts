"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { acceptCurrentUserInvitations } from "@/lib/platform/invitations";
import { resolvePostLoginDestination } from "@/lib/auth/mfa-account";

export type LoginState = { error: string | null };

/**
 * Email + password únicamente (sin OAuth, sin magic links, sin signup
 * público — encargo Fase 3 secciones 20-22). Mensaje de error genérico: no
 * revela si el email existe o no (sección 49).
 */
export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get("email");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: "Ingresa tu email corporativo y tu contraseña." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "No pudimos iniciar sesión con esas credenciales." };
  }

  await acceptCurrentUserInvitations(supabase);

  // Una contraseña correcta crea sesión, no acceso. Si la cuenta ya tiene un
  // segundo factor, todavía está en aal1 y le falta el desafío; si debe tener
  // uno y no lo inscribió, va a inscribirlo. Ver sección 6.2 de
  // docs/MFA_DESIGN.md.
  let destination;
  try {
    destination = await resolvePostLoginDestination(supabase);
  } catch {
    console.error("[auth] no se pudo resolver el destino post-login", {
      event: "password_post_login_destination_failed",
    });
    await supabase.auth.signOut();
    return { error: "No pudimos comprobar el estado de seguridad de tu cuenta. Intenta nuevamente." };
  }

  revalidatePath("/", "layout");
  redirect(destination);
}

/**
 * Google OAuth (preparación de código, credenciales reales pendientes de
 * configuración externa -- ver docs/AUTH_GOOGLE_OAUTH.md). `signInWithOAuth`
 * solo arma la URL de autorización de Supabase; no requiere que el
 * proveedor Google esté habilitado/configurado para compilar o ejecutar
 * este código, pero el flujo real fallará en el paso de Supabase si no lo
 * está.
 *
 * IMPORTANTE (mismo principio que email+password): un login de Google
 * exitoso SOLO crea una sesión de Supabase Auth -- nunca acceso a la
 * aplicación por sí solo. El trigger `handle_new_auth_user` (Fase 3) crea el
 * `profile` con `role = NULL` para CUALQUIER usuario nuevo sin importar el
 * método de login, y el layout de `(app)` (`src/app/(app)/layout.tsx`)
 * exige `profile.role` y `profile.active` para dejar pasar a cualquier
 * pantalla -- ninguna de esas dos barreras es específica de
 * email/password, así que ya cubren OAuth sin cambios adicionales. Ver
 * también identity linking automático de Supabase: si el email de Google
 * coincide con un `auth.users` existente y verificado, Supabase vincula la
 * identidad al MISMO usuario en vez de crear uno nuevo -- comportamiento
 * nativo, no código de esta app.
 */
export async function loginWithGoogle() {
  const supabase = await createClient();
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? `${requestHeaders.get("x-forwarded-proto") ?? "https"}://${requestHeaders.get("host")}`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });

  if (error || !data.url) {
    redirect("/login?error=oauth");
  }

  redirect(data.url);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
