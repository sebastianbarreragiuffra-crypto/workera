import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Sin esto, el límite POR DEFECTO de Next.js para el body de una Server
  // Action es 1MB -- muy por debajo de los topes de 5-10MB que la propia app
  // ya valida y prueba (roster/facturas/proveedores/Colaciones/licencias
  // médicas). Sin este ajuste, cualquier archivo real de más de ~1MB nunca
  // llega a esa validación: Next.js lo rechaza antes (auditoría de Vercel
  // readiness -- bloqueador confirmado, no solo teórico).
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
