import type { NextConfig } from "next";

const temporaryDevOrigin = process.env.NEXT_DEV_ALLOWED_ORIGIN?.trim();
const allowedDevOrigins = ["127.0.0.1"];

// Un túnel de desarrollo necesita pedir los assets internos de Next desde su
// propio hostname. El valor se entrega al iniciar `next dev`; no se versiona un
// dominio efímero ni se abre un wildcard para todos los túneles públicos.
if (temporaryDevOrigin && /^[a-z0-9.-]+$/i.test(temporaryDevOrigin)) {
  allowedDevOrigins.push(temporaryDevOrigin);
}

const nextConfig: NextConfig = {
  allowedDevOrigins,
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
