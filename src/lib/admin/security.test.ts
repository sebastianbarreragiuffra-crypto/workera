import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertServiceRoleCapability,
  SERVICE_ROLE_CAPABILITIES,
} from "../supabase/service-role-capabilities";

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

/**
 * Los directorios server-only donde `createAdminClient` puede aparecer. Es la
 * misma allowlist cerrada que verifica el test siguiente, escrita una sola vez.
 */
const SERVICE_ROLE_DIRECTORIES = [
  "supabase",
  "admin",
  "sync",
  "rule-engine",
  "expense-ocr",
  "expense-file-scan",
  "expense-capture",
  "expense-bank",
  "expense-accounting",
  "expense-assistant",
  "expense-email",
  "expense-whatsapp",
  "supporting-document-cleanup",
  "staging-preflight",
];

test("los límites que usan privilegios administrativos declaran server-only", () => {
  // La lista se DERIVA de quién referencia `createAdminClient`, en vez de
  // mantenerse a mano. Una lista escrita a mano se queda corta apenas aparece
  // un límite nuevo, y ya se quedó: `mfa-audit.ts` obtiene el cliente admin y
  // no estaba enumerado. Declaraba `server-only`, así que no hubo exposición,
  // pero eso fue suerte y no lo que el test comprobaba.
  const guardedFiles = SERVICE_ROLE_DIRECTORIES.flatMap((directory) =>
    listFilesRecursively(path.join(SRC_ROOT, "lib", directory))
  ).filter((file) => /createAdminClient/.test(readFileSync(file, "utf8")));

  assert.ok(
    guardedFiles.length > 0,
    "no se encontró ningún archivo con createAdminClient: el test dejó de comprobar algo"
  );

  for (const filePath of guardedFiles) {
    const content = readFileSync(filePath, "utf8");
    assert.match(
      content,
      /import\s+["']server-only["']/,
      `${filePath} debe importar "server-only"`
    );
  }
});

test("createAdminClient nunca se importa fuera de los límites server-only auditados", () => {
  // src/lib/sync se agregó en Fase 6A: el servicio de ingesta controlada
  // Workera -> Supabase (workera-attendance-sync.ts) es un segundo
  // consumidor legítimo, server-only, de service_role -- misma categoría
  // que src/lib/admin, no una relajación del criterio (sigue siendo una
  // allowlist cerrada de directorios server-only conocidos, no "cualquier
  // archivo").
  //
  // src/lib/rule-engine se agregó en MB-2 con el mismo criterio: el motor de
  // reglas corre desde el cron (sin sesión de usuario) y escribe
  // `rule_engine_runs`, tabla que deliberadamente no tiene policy de
  // escritura para `authenticated`. Ese directorio contiene EXCLUSIVAMENTE el
  // punto de entrada service_role, para que ningún Route Handler ni Server
  // Action bajo src/app/** tenga que obtener el cliente admin por su cuenta.
  const files = listFilesRecursively(SRC_ROOT).filter((file) =>
    SERVICE_ROLE_DIRECTORIES.every(
      (directory) => !file.includes(`${path.sep}lib${path.sep}${directory}${path.sep}`)
    )
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
    `createAdminClient (service_role) referenciado fuera de los límites auditados en: ${offenders.join(", ")}`
  );
});

test("cada creación del cliente admin declara una capacidad inventariada y un consumidor exacto", () => {
  const repoRoot = path.resolve(SRC_ROOT, "..");
  const adminClientPath = path.join(SRC_ROOT, "lib", "supabase", "admin-client.ts");
  const uses = new Map<string, Set<string>>();
  const nonLiteralCalls: string[] = [];

  for (const file of listFilesRecursively(SRC_ROOT)) {
    if (file === adminClientPath) continue;
    const content = readFileSync(file, "utf8");
    const allCalls = [...content.matchAll(/createAdminClient\(\s*([^)]*)\)/g)];
    const literalCalls = [...content.matchAll(/createAdminClient\(\s*["']([^"']+)["']\s*\)/g)];
    if (allCalls.length !== literalCalls.length) {
      nonLiteralCalls.push(path.relative(repoRoot, file).split(path.sep).join("/"));
      continue;
    }

    const consumer = path.relative(repoRoot, file).split(path.sep).join("/");
    for (const match of literalCalls) {
      const capability = match[1];
      const capabilityUses = uses.get(capability) ?? new Set<string>();
      capabilityUses.add(consumer);
      uses.set(capability, capabilityUses);
    }
  }

  assert.deepEqual(nonLiteralCalls, [], "createAdminClient exige un identificador literal y auditable");
  assert.deepEqual(
    [...uses.keys()].filter((capability) => !(capability in SERVICE_ROLE_CAPABILITIES)),
    [],
    "se encontró una capacidad service_role no registrada"
  );

  for (const [capability, definition] of Object.entries(SERVICE_ROLE_CAPABILITIES)) {
    assert.deepEqual(
      [...(uses.get(capability) ?? [])].sort(),
      [...definition.consumers].sort(),
      `${capability} debe usarse exactamente desde sus consumidores declarados`
    );
    assert.ok(definition.authorization.length > 0, `${capability} debe documentar su autorización previa`);
    assert.ok(definition.resources.length > 0, `${capability} debe inventariar sus recursos privilegiados`);
  }
});

test("una capacidad desconocida falla cerrada también en runtime", () => {
  assert.doesNotThrow(() => assertServiceRoleCapability("expense-ocr-worker"));
  assert.throws(
    () => assertServiceRoleCapability("capacidad-inventada"),
    /Capacidad service_role no registrada/
  );
});

test("el límite OCR privilegiado es server-only y ninguna ruta obtiene createAdminClient", () => {
  const ocrRoot = path.join(SRC_ROOT, "lib", "expense-ocr");
  for (const filePath of listFilesRecursively(ocrRoot)) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
  const appFiles = listFilesRecursively(path.join(SRC_ROOT, "app"));
  assert.deepEqual(
    appFiles.filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8"))),
    [],
    "ningún Route Handler ni Server Action debe obtener service_role directamente"
  );
});

test("el límite privilegiado de comprobantes es server-only y ninguna acción obtiene createAdminClient", () => {
  const captureRoot = path.join(SRC_ROOT, "lib", "expense-capture");
  for (const filePath of listFilesRecursively(captureRoot)) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
  const appFiles = listFilesRecursively(path.join(SRC_ROOT, "app"));
  assert.deepEqual(
    appFiles.filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8"))),
    [],
    "ninguna Server Action debe obtener service_role directamente"
  );
});

test("el importador bancario privilegiado es server-only y ninguna acción obtiene createAdminClient", () => {
  const bankRoot = path.join(SRC_ROOT, "lib", "expense-bank");
  for (const filePath of listFilesRecursively(bankRoot)) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
  const appFiles = listFilesRecursively(path.join(SRC_ROOT, "app"));
  assert.deepEqual(
    appFiles.filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8"))),
    [],
    "ninguna Server Action debe obtener service_role directamente"
  );
});

test("el worker contable mantiene service_role detrás de un límite server-only", () => {
  const accountingRoot = path.join(SRC_ROOT, "lib", "expense-accounting");
  const privileged = listFilesRecursively(accountingRoot).filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8")));
  assert.ok(privileged.length > 0, "debe existir un único punto de entrada privilegiado contable");
  for (const filePath of privileged) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
  const appFiles = listFilesRecursively(path.join(SRC_ROOT, "app"));
  assert.deepEqual(appFiles.filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8"))), []);
});

test("la retención del asistente mantiene service_role detrás de un límite server-only", () => {
  const assistantRoot = path.join(SRC_ROOT, "lib", "expense-assistant");
  const privileged = listFilesRecursively(assistantRoot).filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8")));
  assert.equal(privileged.length, 1, "debe existir un único punto de entrada privilegiado para la purga");
  assert.match(readFileSync(privileged[0], "utf8"), /import\s+["']server-only["']/);
  const appFiles = listFilesRecursively(path.join(SRC_ROOT, "app"));
  assert.deepEqual(appFiles.filter((filePath) => /createAdminClient/.test(readFileSync(filePath, "utf8"))), []);
});

test("el conector privilegiado de correo es server-only", () => {
  const emailRoot = path.join(SRC_ROOT, "lib", "expense-email");
  for (const filePath of listFilesRecursively(emailRoot)) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
});

test("el conector privilegiado de WhatsApp es server-only", () => {
  const whatsappRoot = path.join(SRC_ROOT, "lib", "expense-whatsapp");
  for (const filePath of listFilesRecursively(whatsappRoot)) {
    assert.match(readFileSync(filePath, "utf8"), /import\s+["']server-only["']/, `${filePath} debe ser server-only`);
  }
});

test(".env.example no contiene un valor real para SUPABASE_SERVICE_ROLE_KEY", () => {
  const envExamplePath = path.resolve(SRC_ROOT, "..", ".env.example");
  const content = readFileSync(envExamplePath, "utf8");
  const line = content.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_SERVICE_ROLE_KEY="));

  assert.ok(line, "SUPABASE_SERVICE_ROLE_KEY debe estar documentado en .env.example");
  const [, value] = line!.split("=");
  assert.equal(value ?? "", "", "SUPABASE_SERVICE_ROLE_KEY en .env.example debería estar vacío, no un valor real");
});

test("src/lib/rule-engine solo contiene el punto de entrada service_role, nunca lógica de negocio", () => {
  // El valor de la allowlist depende de que este directorio se mantenga
  // mínimo y auditable. Si crece, deja de ser una excepción justificable.
  const ruleEngineDir = path.join(SRC_ROOT, "lib", "rule-engine");
  const files = listFilesRecursively(ruleEngineDir).filter((f) => !f.endsWith(".test.ts"));

  assert.deepEqual(
    files.map((f) => path.basename(f)).sort(),
    ["service.ts"],
    "src/lib/rule-engine debe contener únicamente service.ts (el wrapper de service_role)"
  );

  const content = readFileSync(path.join(ruleEngineDir, "service.ts"), "utf8");
  assert.match(content, /import\s+["']server-only["']/, "service.ts debe importar server-only");
});
