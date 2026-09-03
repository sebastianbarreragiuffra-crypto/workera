import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "../auth/cron-secret";
import { isMfaAllowedPath } from "../auth/mfa";
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
 *
 * El webhook de Resend también debe llegar sin una sesión humana. Su acceso
 * público se limita a una ruta exacta y el Route Handler exige la firma Svix
 * del proveedor antes de procesar cualquier dato.
 */
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/auth/callback",
  "/api/webhooks/resend/expense-receipts",
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Futuras rutas /api/* reciben 401 JSON en vez de un redirect HTML. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Vercel Cron autentica este endpoint antes de que exista sesión de usuario.
 * Dejarlo pasar aquí solo evita el redirect al login: la autorización real la
 * vuelve a hacer el route handler con el MISMO `isValidCronSecretHeader`.
 * El método y la ruta se acotan para que este camino no cubra nada más.
 */
export function isAuthorizedWorkeraCronRequest(request: NextRequest): boolean {
  if (request.method !== "GET" || request.nextUrl.pathname !== "/api/sync/workera") return false;
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

interface AuthClaimsResult {
  data: { claims: Record<string, unknown> } | null;
  error: { message: string } | null;
}

interface SessionRequiresMfaResult {
  data: boolean | null;
  error: { message: string } | null;
}

interface SupabaseAuthClient {
  auth: {
    getClaims: () => Promise<AuthClaimsResult>;
  };
  /**
   * Opcional a propósito: las pruebas del guard de sesión inyectan clientes
   * que solo saben responder `getClaims()`. Un cliente sin `rpc` no puede
   * responder si la cuenta exige MFA, y eso se resuelve cerrando, no abriendo
   * (ver `sessionRequiresMfa`).
   */
  rpc?: (fn: "session_requires_mfa") => PromiseLike<SessionRequiresMfaResult>;
}

/**
 * Gate de MFA, apagado por defecto. Mismo patrón que `WORKERA_SYNC_ENABLED` y
 * `EXPENSE_OCR_ENABLED`: la pantalla de inscripción puede desplegarse y usarse
 * mucho antes de que nadie quede bloqueado, y revertir un incidente es poner
 * esta variable en `false` y redesplegar -- el MFA ya inscrito no se pierde,
 * solo se deja de exigir mientras se diagnostica.
 */
export function isMfaEnforcementEnabled(): boolean {
  return process.env.MFA_ENFORCEMENT_ENABLED === "true";
}

/**
 * Fail-closed, igual que el guard de sesión de más abajo: si no se puede
 * determinar si la cuenta exige segundo factor, se asume que sí. Dejar pasar
 * ante un error sería exactamente el agujero que este gate existe para cerrar,
 * y la única consecuencia de equivocarse hacia el lado seguro es una vuelta de
 * más por `/seguridad/mfa`.
 */
async function sessionRequiresMfa(supabase: SupabaseAuthClient): Promise<boolean> {
  if (typeof supabase.rpc !== "function") return true;

  try {
    const { data, error } = await supabase.rpc("session_requires_mfa");
    if (error || typeof data !== "boolean") {
      console.error("[auth] no se pudo determinar si la cuenta exige MFA", {
        event: "mfa_gate_lookup_failed",
      });
      return true;
    }
    return data;
  } catch (err) {
    console.error("[auth] fallo inesperado consultando el gate de MFA", {
      event: "mfa_gate_error",
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return true;
  }
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

  if (isAuthorizedWorkeraCronRequest(request)) {
    return responseRef.current;
  }

  let isAuthenticated = false;
  let sessionAal = "aal1";
  try {
    const { data, error } = await supabase.auth.getClaims();
    // Autenticado únicamente si getClaims() no reportó error, hay claims, y
    // el claim `sub` (identificador de usuario, obligatorio en el JWT de
    // Supabase) es un string no vacío. No basta con "error es null": un
    // objeto de claims vacío o sin `sub` nunca debe considerarse sesión
    // válida.
    const sub = data?.claims?.sub;
    isAuthenticated = !error && typeof sub === "string" && sub.length > 0;
    // El nivel de autenticación viaja en el MISMO JWT que ya se verificó
    // acá, así que leerlo no agrega ningún round-trip. Su ausencia se lee
    // como aal1: una sesión que no declara nivel no probó un segundo factor.
    const aal = data?.claims?.aal;
    sessionAal = typeof aal === "string" && aal.length > 0 ? aal : "aal1";
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

  // Gate de MFA (etapa E del diseño). Va DESPUÉS de resolver la sesión y ANTES
  // de dejar pasar: una sesión válida pero todavía en aal1 no alcanza si la
  // cuenta exige segundo factor.
  //
  // El orden de las condiciones importa por costo: el flag y el nivel salen
  // del JWT ya verificado, y la ruta permitida se descarta antes de preguntar
  // nada a la base. La consulta solo ocurre en el camino aal1 hacia una ruta
  // protegida.
  if (
    isAuthenticated &&
    isMfaEnforcementEnabled() &&
    sessionAal !== "aal2" &&
    !isMfaAllowedPath(pathname) &&
    (await sessionRequiresMfa(supabase))
  ) {
    if (isApi) {
      // Un redirect HTML no sirve como respuesta a una llamada de API. 403 y
      // no 401: la sesión es válida, lo que falta es el segundo factor.
      const mfaRequired = NextResponse.json({ error: "mfa_required" }, { status: 403 });
      copyCookies(responseRef.current, mfaRequired);
      return mfaRequired;
    }

    const mfaRedirect = NextResponse.redirect(new URL("/seguridad/mfa", request.url));
    copyCookies(responseRef.current, mfaRedirect);
    return mfaRedirect;
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
