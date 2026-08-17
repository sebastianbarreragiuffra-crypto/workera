import "server-only";
import { WorkeraConfigurationError } from "./errors";

/**
 * Configuración server-only del adaptador Workera. `import "server-only"`
 * hace que Next.js falle el build si algún Client Component intentara
 * importar este archivo (sección 20 del encargo). Ninguna variable de acá
 * lleva jamás el prefijo NEXT_PUBLIC_.
 *
 * Nombres de variables: no conocemos todavía el mecanismo de autenticación
 * real de Workera (checklist pendiente, docs/WORKERA_API_REQUIREMENTS.md),
 * así que se usan nombres genéricos documentados en vez de fingir que
 * `WORKERA_API_KEY` es el nombre definitivo. Se ajustarán en Fase 5 cuando
 * se confirme el mecanismo real — ese cambio no debería requerir tocar
 * ningún archivo fuera de este módulo.
 */

export type WorkeraProvider = "mock" | "http";

export interface WorkeraConfig {
  provider: WorkeraProvider;
  /** Base URL del futuro HttpWorkeraClient. Vacía mientras provider = mock. */
  baseUrl: string | null;
  /** Placeholder genérico — nombre/forma real de la credencial: WAITING_FOR_WORKERA_DOCUMENTATION. */
  credential: string | null;
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
  const credential = process.env.WORKERA_CREDENTIAL || null;
  const timeoutRaw = process.env.WORKERA_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new WorkeraConfigurationError(
      `WORKERA_REQUEST_TIMEOUT_MS debe ser un número positivo, recibido: "${timeoutRaw}"`
    );
  }

  if (isProductionEnvironment()) {
    if (rawProvider !== "http") {
      throw new WorkeraConfigurationError(
        'En producción, WORKERA_PROVIDER debe ser "http" explícitamente. ' +
          "No se usa el mock silenciosamente fuera de desarrollo/test (fail-closed)."
      );
    }
    if (!baseUrl) {
      throw new WorkeraConfigurationError(
        "WORKERA_PROVIDER=http requiere WORKERA_BASE_URL configurado."
      );
    }
    return { provider: "http", baseUrl, credential, requestTimeoutMs };
  }

  // Fuera de producción: mock por defecto si no se especifica nada, para no
  // exigir configuración a cada desarrollador que clona el repo. "http"
  // sigue siendo válido en desarrollo si alguien quiere probar contra un
  // sandbox real una vez exista.
  const provider: WorkeraProvider = rawProvider === "http" ? "http" : "mock";

  if (provider === "http" && !baseUrl) {
    throw new WorkeraConfigurationError(
      "WORKERA_PROVIDER=http requiere WORKERA_BASE_URL configurado."
    );
  }

  return { provider, baseUrl, credential, requestTimeoutMs };
}
