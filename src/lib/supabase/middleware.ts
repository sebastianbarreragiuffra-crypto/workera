import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

/**
 * Refresca la sesión de Supabase Auth en cada request (patrón oficial de
 * @supabase/ssr para Next.js App Router con cookies). Se invoca desde
 * src/middleware.ts. No decide autorización aquí — eso lo hace RLS en la
 * base de datos (server-side, nunca confiando en el frontend).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // No eliminar: revalida el token en cada request.
  await supabase.auth.getUser();

  return supabaseResponse;
}
