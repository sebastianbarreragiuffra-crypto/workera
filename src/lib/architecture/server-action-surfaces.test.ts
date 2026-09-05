import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SERVER_ACTION_SURFACES } from "./server-action-surfaces";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const APP_ROOT = path.join(REPO_ROOT, "src", "app");
const EXPORTED_ACTION = /^export\s+(?:async\s+)?function\s+(\w+)\b/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return sourceFiles(fullPath);
    if (!/\.tsx?$/.test(entry)) return [];
    const source = readFileSync(fullPath, "utf8");
    return /^\s*["']use server["'];?/m.test(source) ? [fullPath] : [];
  });
}

function relativeSource(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function exportedActions(source: string): string[] {
  return [...source.matchAll(EXPORTED_ACTION)].map((match) => match[1]);
}

function actionSegments(source: string): Array<{ name: string; body: string }> {
  const matches = [...source.matchAll(EXPORTED_ACTION)];
  return matches.map((match, index) => ({
    name: match[1],
    body: source.slice(match.index!, matches[index + 1]?.index ?? source.length),
  }));
}

test("los 16 archivos y 74 Server Actions estan inventariados exactamente", () => {
  const discovered = new Map(sourceFiles(APP_ROOT).map((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return [relativeSource(filePath), exportedActions(source).sort()] as const;
  }));
  const registered = new Map<string, string[]>(SERVER_ACTION_SURFACES.map((surface) => [
    surface.source,
    [...surface.actions].sort(),
  ] as const));

  assert.equal(registered.size, SERVER_ACTION_SURFACES.length, "hay un archivo duplicado en el inventario");
  assert.deepEqual([...registered.keys()].sort(), [...discovered.keys()].sort());
  for (const [source, actions] of discovered) assert.deepEqual(registered.get(source), actions, source);
  assert.equal([...discovered.values()].flat().length, 74);
});

test("cada perfil conserva evidencia de autenticacion/autorizacion en su fuente", () => {
  for (const surface of SERVER_ACTION_SURFACES) {
    const sourcePath = path.join(REPO_ROOT, surface.source);
    assert.ok(existsSync(sourcePath), `${surface.source} no existe`);
    const source = readFileSync(sourcePath, "utf8");
    for (const evidence of surface.authorizationEvidence) {
      assert.ok(source.includes(evidence), `${surface.source} perdio ${evidence}`);
    }
  }
});

test("toda accion tenant-aware explicita resuelve empresa mediante el contexto de sesion", () => {
  for (const surface of SERVER_ACTION_SURFACES.filter((item) => item.tenantScope === "EXPLICIT_COMPANY")) {
    const source = readFileSync(path.join(REPO_ROOT, surface.source), "utf8");
    assert.match(source, /getExpenseCompanyContextFromClient/);
    assert.ok(!(surface.blockers as readonly string[]).includes("LABOR_MULTI_TENANCY"));
  }
});

test("la deuda legacy y la ausencia de rate limit nunca quedan ocultas", () => {
  for (const surface of SERVER_ACTION_SURFACES) {
    if (surface.tenantScope === "LEGACY_ARCOTEX") {
      assert.ok(surface.blockers.includes("LABOR_MULTI_TENANCY"), surface.source);
    }
    if (surface.abuseControl === "MISSING") {
      assert.ok(surface.blockers.includes("APPLICATION_RATE_LIMIT"), surface.source);
    }
  }
});

test("los limites distribuidos declarados tienen evidencia en la frontera", () => {
  for (const surface of SERVER_ACTION_SURFACES.filter((item) => item.abuseControl === "DATABASE_RATE_LIMIT")) {
    const source = readFileSync(path.join(REPO_ROOT, surface.source), "utf8");
    assert.match(source, /consumePlatformActionRateLimit\(/, surface.source);
    assert.ok(!(surface.blockers as readonly string[]).includes("APPLICATION_RATE_LIMIT"), surface.source);
  }
});

test("ninguna accion decide rol o permiso desde FormData", () => {
  const forbidden = /formData\.get\(["'](?:role|permission|permissions|isAdmin|isPrivileged|companyId|actorId|userId)["']\)/;
  for (const filePath of sourceFiles(APP_ROOT)) {
    assert.doesNotMatch(readFileSync(filePath, "utf8"), forbidden, relativeSource(filePath));
  }
});

test("archivos y JSON de reintento se autorizan antes de procesar contenido", () => {
  const costlyInput = /validateExpenseReceiptFile\(|file\.arrayBuffer\(|JSON\.parse\(/;
  const authorization = /await\s+require\w*\(|await\s+getCurrentProfile\(|await\s+getExpenseCompanyContextFromClient\(/;

  for (const filePath of sourceFiles(APP_ROOT)) {
    const source = readFileSync(filePath, "utf8");
    for (const action of actionSegments(source)) {
      const costlyIndex = action.body.search(costlyInput);
      if (costlyIndex < 0) continue;
      const authorizationIndex = action.body.search(authorization);
      assert.ok(
        authorizationIndex >= 0 && authorizationIndex < costlyIndex,
        `${relativeSource(filePath)}#${action.name} procesa bytes/JSON antes de autorizar`
      );
    }
  }
});

test("toda familia que sube archivos declara un maximo de hasta 10 MiB", () => {
  for (const surface of SERVER_ACTION_SURFACES.filter((item) => item.uploadMaxBytes !== null)) {
    assert.ok(surface.uploadMaxBytes! > 0 && surface.uploadMaxBytes! <= 10 * 1024 * 1024, surface.source);
    const source = readFileSync(path.join(REPO_ROOT, surface.source), "utf8");
    assert.match(source, /file\.size|validateExpenseReceiptFile|uploadSupportingDocument/);
  }
});

test("uploads laborales autorizan el trabajador y acotan tamaño antes de leer todos los bytes", () => {
  for (const sourceName of [
    "src/app/(app)/documentos/actions.ts",
    "src/app/(app)/revision-diaria/actions.ts",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, sourceName), "utf8");
    const action = actionSegments(source).find((item) => item.body.includes("uploadSupportingDocument("));
    assert.ok(action, `${sourceName} debe conservar su acción de upload`);
    const access = action.body.indexOf("assertEmployeeAccessAllowed(");
    const max = action.body.indexOf("MAX_SUPPORTING_DOCUMENT_SIZE_BYTES");
    const bytes = action.body.indexOf("file.arrayBuffer(");
    assert.ok(access >= 0 && max >= 0 && bytes > access && bytes > max, `${sourceName} debe autorizar/acotar antes de leer bytes`);
  }
});
