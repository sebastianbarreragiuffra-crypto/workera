import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Tests de seguridad de Fase 4 (sección 31 del encargo): ninguna credencial
 * de Workera debe poder llegar al navegador. Se verifica de forma
 * automatizada, no solo manual, para que una regresión futura (ej. alguien
 * agrega `NEXT_PUBLIC_WORKERA_API_KEY` sin darse cuenta de la implicancia)
 * falle el test suite en vez de descubrirse en producción.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "..");

function listFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

test("ningún archivo fuente usa NEXT_PUBLIC_WORKERA_* (una credencial de Workera nunca debe ser pública)", () => {
  const files = listFilesRecursively(SRC_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (/NEXT_PUBLIC_WORKERA/.test(content)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, [], `Se encontró NEXT_PUBLIC_WORKERA en: ${offenders.join(", ")}`);
});

test("config.ts, client.ts, mock-client.ts, logging.ts e index.ts declaran server-only", () => {
  const guardedFiles = ["config.ts", "client.ts", "mock-client.ts", "logging.ts", "index.ts"];

  for (const fileName of guardedFiles) {
    const content = readFileSync(path.join(import.meta.dirname, fileName), "utf8");
    assert.match(
      content,
      /import\s+["']server-only["']/,
      `${fileName} debe importar "server-only"`
    );
  }
});

test(".env.example no contiene valores de credencial reales, solo placeholders vacíos", () => {
  const envExamplePath = path.resolve(SRC_ROOT, "..", ".env.example");
  const content = readFileSync(envExamplePath, "utf8");
  const workeraLines = content
    .split("\n")
    .filter((line) => line.startsWith("WORKERA_") && line.includes("="));

  for (const line of workeraLines) {
    const [key, value] = line.split("=");
    if (key === "WORKERA_PROVIDER") continue; // "mock" es un valor de ejemplo válido, no un secreto
    if (key === "WORKERA_REQUEST_TIMEOUT_MS") continue; // valor numérico de ejemplo, no un secreto
    assert.equal(value ?? "", "", `${key} en .env.example debería estar vacío, no un valor real`);
  }
});
