import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

/**
 * Rutas accesibles sin sesión. Todo lo demás es privado por defecto
 * (secure-by-default): una página nueva queda protegida automáticamente
 * salvo que se agregue aquí explícitamente — nunca al revés.
 *
 * `/auth/callback` DEBE ser pública: es el redirect de vuelta de Google
 * (u otro proveedor OAuth) ANTES de que exista sesión -- ese route handler
 * es el que recién la crea vía `exchangeCodeForSession`. No es un bypass de
 * autorización: un OAuth exitoso solo crea sesión (igual que email+password);
 * el acceso real a la app lo sigue decidiendo el layout de `(app)`
 * (`profile.role`/`profile.active`), exactamente igual para ambos métodos de
 * login.
 */
const PUBLIC_PATHS = new Set<string>(["/login", "/auth/callback"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Futuras rutas /api/* reciben 401 JSON en vez de un redirect HTML. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

interface AuthClaimsResult {
  data: { claims: Record<string, unknown> } | null;
  error: { message: string } | null;
}

interface SupabaseAuthClient {
  auth: {
    getClaims: () => Promise<AuthClaimsResult>;
  };
}

type ResponseRef = { current: NextResponse };

type SupabaseClientFactory = (request: NextRequest, responseRef: ResponseRef) => SupabaseAuthClient;

function defaultClientFactory(request: NextRequest, responseRef: ResponseRef): SupabaseAuthClient {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          responseRef.current = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            responseRef.current.cookies.set(name, value, options)
          );
        },
      },
    }
  );
}

/** Copia las cookies (incluida cualquier renovación) de una respuesta a otra. */
function copyCookies(from: NextResponse, to: NextResponse): void {
  from.cookies.getAll().forEach((cookie) => {
    to.cookies.set(cookie);
  });
}

/**
 * Refresca la sesión de Supabase Auth y decide acceso en cada request
 * (patrón oficial de @supabase/ssr para Next.js App Router con cookies,
 * extendido con guard de sesión — Gate B pre-UI). Se invoca desde
 * src/proxy.ts.
 *
 * No reemplaza RLS: RLS sigue siendo la barrera real en la base de datos.
 * Este guard es defensa en profundidad — evita que una página protegida se
 * renderice sin sesión antes de que RLS entre en juego.
 *
 * Usa getClaims() (verificación local del JWT), nunca getSession() ni
 * getUser() para esta decisión — getUser() exige un round-trip de red al
 * Auth server en cada request, getSession() puede confiar en un valor de
 * storage no verificado. Se llama exactamente una vez por request.
 */
export async function updateSession(
  request: NextRequest,
  createClientForRequest: SupabaseClientFactory = defaultClientFactory
): Promise<NextResponse> {
  const responseRef: ResponseRef = { current: NextResponse.next({ request }) };
  const supabase = createClientForRequest(request, responseRef);

  const pathname = request.nextUrl.pathname;
  const isPublic = isPublicPath(pathname);
  const isApi = isApiPath(pathname);

  let isAuthenticated = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    // Autenticado únicamente si getClaims() no reportó error, hay claims, y
    // el claim `sub` (identificador de usuario, obligatorio en el JWT de
    // Supabase) es un string no vacío. No basta con "error es null": un
    // objeto de claims vacío o sin `sub` nunca debe considerarse sesión
    // válida.
    const sub = data?.claims?.sub;
    isAuthenticated = !error && typeof sub === "string" && sub.length > 0;
  } catch (err) {
    // Fallo técnico inesperado (ej. JWKS no disponible, error de red al
    // verificar) -> fail closed: nunca se concede acceso por defecto. No se
    // registra el pathname (puede contener UUIDs u otros identificadores en
    // futuras rutas), ni query string, ni cookies, ni token, ni claims, ni
    // email, ni error.message/stack (pueden traer datos externos) — solo un
    // evento estático y el nombre normalizado del error.
    console.error("[auth] fallo inesperado verificando sesión", {
      event: "session_guard_error",
      errorName: err instanceof Error ? err.name : "unknown",
    });
    isAuthenticated = false;
  }

  if (isPublic || isAuthenticated) {
    return responseRef.current;
  }

  if (isApi) {
    const unauthorized = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    copyCookies(responseRef.current, unauthorized);
    return unauthorized;
  }

  const redirectResponse = NextResponse.redirect(new URL("/login", request.url));
  copyCookies(responseRef.current, redirectResponse);
  return redirectResponse;
}
