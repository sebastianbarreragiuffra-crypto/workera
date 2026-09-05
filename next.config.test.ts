import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig, { createNextConfig } from "./next.config";
import { MAX_SUPPORTING_DOCUMENT_SIZE_BYTES } from "./src/lib/decisions/documents";

/**
 * Auditoría de Vercel readiness: el límite POR DEFECTO de Next.js para el
 * body de una Server Action es 1MB -- muy por debajo de los topes de 5-10MB
 * que la app ya valida (roster/facturas/proveedores/Colaciones/licencias
 * médicas). Sin `experimental.serverActions.bodySizeLimit`, esos archivos
 * nunca llegan a la validación propia de la app: Next.js los rechaza antes.
 */

function parseSizeLimit(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const match = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i.exec(raw.trim());
  if (!match) throw new Error(`formato de bodySizeLimit no reconocido en este test: "${raw}"`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return value * multiplier;
}

test("next.config.ts configura experimental.serverActions.bodySizeLimit por encima del tope por defecto de 1MB de Next.js", () => {
  const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;
  assert.ok(limit, "debe configurar bodySizeLimit explícitamente -- el default de Next.js (1MB) rompe todos los uploads reales de la app");
  assert.ok(parseSizeLimit(limit) > 1024 * 1024, "debe ser mayor al default de Next.js (1MB)");
});

test("next.config.ts: bodySizeLimit cubre con margen el tope más grande que la app valida (MAX_SUPPORTING_DOCUMENT_SIZE_BYTES, licencias médicas)", () => {
  const limit = nextConfig.experimental!.serverActions!.bodySizeLimit!;
  assert.ok(
    parseSizeLimit(limit) > MAX_SUPPORTING_DOCUMENT_SIZE_BYTES,
    "bodySizeLimit debe ser mayor al tope de la app -- si no, Next.js seguiría rechazando el archivo antes de que la app pueda devolver su propio mensaje de error"
  );
});

test("los túneles de desarrollo se autorizan por hostname exacto, nunca con un wildcard público versionado", () => {
  assert.deepEqual(nextConfig.allowedDevOrigins, ["127.0.0.1"]);
  assert.ok(nextConfig.allowedDevOrigins?.every((origin) => !origin.includes("*")));
});

test("el hostname exacto del túnel habilita también Server Actions sin abrir wildcards", () => {
  const config = createNextConfig("tunnel-example.trycloudflare.com");
  assert.deepEqual(config.allowedDevOrigins, ["127.0.0.1", "tunnel-example.trycloudflare.com"]);
  assert.deepEqual(config.experimental?.serverActions?.allowedOrigins, [
    "tunnel-example.trycloudflare.com",
  ]);
  assert.ok(config.experimental?.serverActions?.allowedOrigins?.every((origin) => !origin.includes("*")));
});

test("un origen temporal inválido no se agrega a ninguna allowlist", () => {
  const config = createNextConfig("*.trycloudflare.com");
  assert.deepEqual(config.allowedDevOrigins, ["127.0.0.1"]);
  assert.equal(config.experimental?.serverActions?.allowedOrigins, undefined);
});
