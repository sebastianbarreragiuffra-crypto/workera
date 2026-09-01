import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Tests de seguridad de Fase 5D (PASO 10/20 del encargo): SUPABASE_SERVICE_ROLE_KEY
 * nunca debe poder llegar al navegador. Mismo criterio automatizado ya usado
 * para las credenciales de Workera (src/lib/workera/security.test.ts).
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

test("ningún archivo fuente usa NEXT_PUBLIC_SUPABASE_SERVICE_ROLE (la service_role key nunca debe ser pública)", () => {
  const files = listFilesRecursively(SRC_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (/NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/.test(content)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, [], `Se encontró NEXT_PUBLIC_SUPABASE_SERVICE_ROLE en: ${offenders.join(", ")}`);
});

test("admin-client.ts y user-management.ts declaran server-only", () => {
  const guardedFiles = [
    path.join(import.meta.dirname, "..", "supabase", "admin-client.ts"),
    path.join(import.meta.dirname, "user-management.ts"),
  ];

  for (const filePath of guardedFiles) {
    const content = readFileSync(filePath, "utf8");
    assert.match(
      content,
      /import\s+["']server-only["']/,
      `${filePath} debe importar "server-only"`
    );
  }
});

test("createAdminClient nunca se importa desde un archivo fuera de src/lib/supabase, src/lib/admin o src/lib/sync", () => {
  // src/lib/sync se agregó en Fase 6A: el servicio de ingesta controlada
  // Workera -> Supabase (workera-attendance-sync.ts) es un segundo
  // consumidor legítimo, server-only, de service_role -- misma categoría
  // que src/lib/admin, no una relajación del criterio (sigue siendo una
  // allowlist cerrada de directorios server-only conocidos, no "cualquier
  // archivo").
  const files = listFilesRecursively(SRC_ROOT).filter(
    (f) =>
      !f.includes(`${path.sep}lib${path.sep}supabase${path.sep}`) &&
      !f.includes(`${path.sep}lib${path.sep}admin${path.sep}`) &&
      !f.includes(`${path.sep}lib${path.sep}sync${path.sep}`)
  );
  const offenders: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (/createAdminClient/.test(content)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `createAdminClient (service_role) referenciado fuera de src/lib/supabase|admin|sync en: ${offenders.join(", ")}`
  );
});

test(".env.example no contiene un valor real para SUPABASE_SERVICE_ROLE_KEY", () => {
  const envExamplePath = path.resolve(SRC_ROOT, "..", ".env.example");
  const content = readFileSync(envExamplePath, "utf8");
  const line = content.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_SERVICE_ROLE_KEY="));

  assert.ok(line, "SUPABASE_SERVICE_ROLE_KEY debe estar documentado en .env.example");
  const [, value] = line!.split("=");
  assert.equal(value ?? "", "", "SUPABASE_SERVICE_ROLE_KEY en .env.example debería estar vacío, no un valor real");
});
