import "server-only";
import { WorkeraConfigurationError } from "./errors";

/**
 * Configuración server-only del adaptador Workera. `import "server-only"`
 * hace que Next.js falle el build si algún Client Component intentara
 * importar este archivo (sección 20 del encargo). Ninguna variable de acá
 * lleva jamás el prefijo NEXT_PUBLIC_.
 *
 * Mecanismo de autenticación CONFIRMADO en Fase 5C por el manual oficial de
 * Workera entregado por el usuario: "Utiliza los valores de API_USER y
 * API_KEY como encabezados en las consultas REST de cada funcionalidad
 * API." Dos credenciales, dos headers HTTP — `API_USER` (el correo
 * electrónico asociado a la cuenta) y `API_KEY` (código alfanumérico de 32
 * caracteres). Ya no es un placeholder genérico.
 */

export type WorkeraProvider = "mock" | "http";

export interface WorkeraConfig {
  provider: WorkeraProvider;
  /** Base URL del HttpWorkeraClient, ej. "https://workera.com/apiClient/v1". Vacía mientras provider = mock. */
  baseUrl: string | null;
  /** Header HTTP "API_USER" — el correo asociado a la cuenta de Workera. */
  apiUser: string | null;
  /** Header HTTP "API_KEY" — código alfanumérico de 32 caracteres. Nunca loguear ni exponer. */
  apiKey: string | null;
  requestTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Lee y valida la configuración. FAIL CLOSED (sección 22 del encargo): en
 * producción, si no hay un provider "http" configurado explícitamente con
 * base URL, se rechaza — nunca se cae silenciosamente al mock. Se evalúa de
 * forma perezosa (dentro de una función, no a nivel de módulo) para no
 * acceder a variables de entorno durante el build estático de Next.js.
 */
export function getWorkeraConfig(): WorkeraConfig {
  const rawProvider = process.env.WORKERA_PROVIDER;
  const baseUrl = process.env.WORKERA_BASE_URL || null;
  const apiUser = process.env.WORKERA_API_USER || null;
  const apiKey = process.env.WORKERA_API_KEY || null;
  const timeoutRaw = process.env.WORKERA_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new WorkeraConfigurationError(
      `WORKERA_REQUEST_TIMEOUT_MS debe ser un número positivo, recibido: "${timeoutRaw}"`
    );
  }

  function assertHttpCredentials(): void {
    if (!baseUrl) {
      throw new WorkeraConfigurationError(
        "WORKERA_PROVIDER=http requiere WORKERA_BASE_URL configurado."
      );
    }
    if (!apiUser || !apiKey) {
      throw new WorkeraConfigurationError(
        "WORKERA_PROVIDER=http requiere WORKERA_API_USER y WORKERA_API_KEY configurados."
      );
    }
  }

  if (isProductionEnvironment()) {
    if (rawProvider !== "http") {
      throw new WorkeraConfigurationError(
        'En producción, WORKERA_PROVIDER debe ser "http" explícitamente. ' +
          "No se usa el mock silenciosamente fuera de desarrollo/test (fail-closed)."
      );
    }
    assertHttpCredentials();
    return { provider: "http", baseUrl, apiUser, apiKey, requestTimeoutMs };
  }

  // Fuera de producción: mock por defecto si no se especifica nada, para no
  // exigir configuración a cada desarrollador que clona el repo. "http"
  // sigue siendo válido en desarrollo si alguien quiere probar contra la
  // API real (Fase 5C).
  const provider: WorkeraProvider = rawProvider === "http" ? "http" : "mock";

  if (provider === "http") {
    assertHttpCredentials();
  }

  return { provider, baseUrl, apiUser, apiKey, requestTimeoutMs };
}
