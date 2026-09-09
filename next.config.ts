import type { NextConfig } from "next";

const ARCOTEX_SHADOW_E2E_FLAG = "enabled";

interface NextConfigRuntime {
  nodeEnv?: string;
  arcotexShadowE2E?: string;
}

function arcotexShadowAliases(runtime: NextConfigRuntime): Record<string, string> | null {
  if (runtime.arcotexShadowE2E !== ARCOTEX_SHADOW_E2E_FLAG) return null;
  if (runtime.nodeEnv !== "development") {
    throw new Error("ARCOTEX_SHADOW_E2E solo puede habilitarse con next dev.");
  }

  return {
    "@/lib/supabase/middleware": "./tests/e2e/support/arcotex-shadow-middleware.ts",
    "@/lib/supabase/server": "./tests/e2e/support/arcotex-shadow-supabase.ts",
    "../employees/arcotex-authorized-employee-scope":
      "./tests/e2e/support/arcotex-shadow-authorized-employee-scope.ts",
    "../shared/arcotex-authorized-employee-scope":
      "./tests/e2e/support/arcotex-shadow-authorized-employee-scope.ts",
    "../sync/scheduler": "./tests/e2e/support/arcotex-shadow-sync-health.ts",
  };
}

function trustedTemporaryOrigin(value?: string): string | null {
  const origin = value?.trim();
  return origin && /^[a-z0-9.-]+$/i.test(origin) ? origin : null;
}

export function createNextConfig(
  rawTemporaryDevOrigin = process.env.NEXT_DEV_ALLOWED_ORIGIN,
  runtime: NextConfigRuntime = {
    nodeEnv: process.env.NODE_ENV,
    arcotexShadowE2E: process.env.ARCOTEX_SHADOW_E2E,
  },
): NextConfig {
  const temporaryDevOrigin = trustedTemporaryOrigin(rawTemporaryDevOrigin);
  const allowedDevOrigins = ["127.0.0.1"];
  const shadowAliases = arcotexShadowAliases(runtime);

  // Un túnel de desarrollo necesita pedir assets/endpoints internos de Next y
  // ejecutar Server Actions desde su hostname público. El valor es exacto y
  // efímero: no se versiona un dominio ni se abre un wildcard público.
  if (temporaryDevOrigin) allowedDevOrigins.push(temporaryDevOrigin);

  return {
    allowedDevOrigins,
    ...(shadowAliases
      ? {
          distDir: ".next-arcotex-shadow-e2e",
          turbopack: { resolveAlias: shadowAliases },
        }
      : {}),
    // Sin esto, el límite POR DEFECTO de Next.js para el body de una Server
    // Action es 1MB -- muy por debajo de los topes de 5-10MB que la propia app
    // ya valida y prueba (roster/facturas/proveedores/Colaciones/licencias
    // médicas). Sin este ajuste, cualquier archivo real de más de ~1MB nunca
    // llega a esa validación: Next.js lo rechaza antes (auditoría de Vercel
    // readiness -- bloqueador confirmado, no solo teórico).
    experimental: {
      serverActions: {
        bodySizeLimit: "12mb",
        ...(temporaryDevOrigin ? { allowedOrigins: [temporaryDevOrigin] } : {}),
      },
    },
  };
}

const nextConfig = createNextConfig();

export default nextConfig;
