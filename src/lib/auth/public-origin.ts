import "server-only";

/**
 * Única frontera para construir URLs absolutas que salen de la aplicación
 * (OAuth, invitaciones y redirects del proxy). Detrás de un túnel o proxy,
 * `request.url`, `Host` y `X-Forwarded-Host` pueden describir el upstream
 * interno — o venir manipulados por el cliente — y no son una autoridad para
 * decidir a qué dominio enviar una sesión.
 */

export interface PublicOriginEnvironment {
  readonly [key: string]: string | undefined;
  APP_PUBLIC_ORIGIN?: string;
  /** Compatibilidad con despliegues anteriores; preferir APP_PUBLIC_ORIGIN. */
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
}

export class PublicOriginConfigurationError extends Error {
  constructor(message = "No hay un origen público confiable configurado para la aplicación.") {
    super(message);
    this.name = "PublicOriginConfigurationError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const INTERNAL_URL_BASE = "https://internal-app.invalid";

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function exactOrigin(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PublicOriginConfigurationError(`${source} no contiene un origen URL válido.`);
  }

  if (
    url.username ||
    url.password ||
    url.hostname.includes("*") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new PublicOriginConfigurationError(
      `${source} debe contener solo protocolo, hostname y puerto opcional.`
    );
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new PublicOriginConfigurationError(
      `${source} debe usar HTTPS; HTTP solo se admite para loopback local.`
    );
  }

  return url.origin;
}

function configuredOrigin(
  environment: PublicOriginEnvironment
): { value: string; source: string } | null {
  for (const [source, raw] of [
    ["APP_PUBLIC_ORIGIN", environment.APP_PUBLIC_ORIGIN],
    ["NEXT_PUBLIC_APP_URL", environment.NEXT_PUBLIC_APP_URL],
  ] as const) {
    if (raw?.trim()) return { value: raw, source };
  }

  for (const [source, raw] of [
    ["VERCEL_PROJECT_PRODUCTION_URL", environment.VERCEL_PROJECT_PRODUCTION_URL],
    ["VERCEL_URL", environment.VERCEL_URL],
  ] as const) {
    if (raw?.trim()) {
      const value = raw.includes("://") ? raw : `https://${raw}`;
      return { value, source };
    }
  }

  return null;
}

/**
 * Resuelve el origen canónico sin confiar en headers enviados por Internet.
 * El request solo sirve como fallback para desarrollo HTTP en loopback. Un
 * `https://localhost` visto detrás de un proxy se rechaza deliberadamente: es
 * el síntoma exacto que antes enviaba teléfonos externos hacia localhost.
 */
export function resolvePublicOrigin(
  requestOrigin?: string | null,
  environment: PublicOriginEnvironment = process.env
): string {
  const configured = configuredOrigin(environment);
  if (configured) return exactOrigin(configured.value, configured.source);

  if (requestOrigin) {
    const origin = exactOrigin(requestOrigin, "el origen local del request");
    const url = new URL(origin);
    if (url.protocol === "http:" && isLoopback(url)) return origin;
  }

  throw new PublicOriginConfigurationError();
}

/** Rechaza destinos capaces de cambiar de origen o formar loops de callback. */
export function isSafeInternalDestination(
  value: string,
  blockedPathnames: ReadonlySet<string> = new Set()
): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;

  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return false;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) break;
    decoded = next;
    if (!decoded.startsWith("/") || decoded.startsWith("//")) return false;
  }

  try {
    const url = new URL(value, INTERNAL_URL_BASE);
    return url.origin === INTERNAL_URL_BASE && !blockedPathnames.has(url.pathname);
  } catch {
    return false;
  }
}

export function safeInternalDestination(
  value: string | null,
  fallback = "/",
  blockedPathnames?: ReadonlySet<string>
): string {
  return value && isSafeInternalDestination(value, blockedPathnames) ? value : fallback;
}

/** Construye una URL absoluta únicamente dentro del origen público confiable. */
export function publicAppUrl(
  destination: string,
  requestOrigin?: string | null,
  environment: PublicOriginEnvironment = process.env
): URL {
  if (!isSafeInternalDestination(destination)) {
    throw new PublicOriginConfigurationError("El destino interno de autenticación no es válido.");
  }

  const origin = resolvePublicOrigin(requestOrigin, environment);
  const url = new URL(destination, `${origin}/`);
  if (url.origin !== origin) {
    throw new PublicOriginConfigurationError("El destino de autenticación cambió de origen.");
  }
  return url;
}
