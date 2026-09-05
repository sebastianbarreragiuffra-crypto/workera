import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REQUEST_SURFACES, requestSurfaceKey } from "./request-surfaces";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const APP_ROOT = path.join(REPO_ROOT, "src", "app");
const HTTP_METHOD = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return routeFiles(fullPath);
    return entry === "route.ts" ? [fullPath] : [];
  });
}

function normalizedRoute(filePath: string): string {
  const segments = path.relative(APP_ROOT, path.dirname(filePath)).split(path.sep)
    .filter((segment) => !/^\(.+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

function localSourceClosure(sourcePath: string, source: string, seen = new Set<string>()): string[] {
  const imports = [...source.matchAll(/(?:from\s+|import\s+)["'](@\/[^"']+|\.{1,2}\/[^"']+)["']/g)]
    .map((match) => match[1]);
  return imports.flatMap((specifier) => {
    const base = specifier.startsWith("@/")
      ? path.join(REPO_ROOT, "src", specifier.slice(2))
      : path.resolve(path.dirname(sourcePath), specifier);
    const candidate = `${base}.ts`;
    if (!existsSync(candidate) || seen.has(candidate)) return [];
    seen.add(candidate);
    const imported = readFileSync(candidate, "utf8");
    return [imported, ...localSourceClosure(candidate, imported, seen)];
  });
}

test("cada método de cada Route Handler está inventariado una sola vez", () => {
  const discovered = routeFiles(APP_ROOT).flatMap((filePath) => {
    const route = normalizedRoute(filePath);
    const methods = [...readFileSync(filePath, "utf8").matchAll(HTTP_METHOD)].map((match) => match[1]);
    assert.ok(methods.length > 0, `${path.relative(REPO_ROOT, filePath)} no exporta un método HTTP reconocido`);
    return methods.map((method) => `${method} ${route}`);
  }).sort();
  const registered = REQUEST_SURFACES.map(requestSurfaceKey).sort();

  assert.equal(new Set(registered).size, registered.length, "el inventario contiene una ruta/método duplicado");
  assert.deepEqual(registered, discovered);
});

test("la ruta declarada, el archivo y el feature flag coinciden con el código", () => {
  for (const surface of REQUEST_SURFACES) {
    const sourcePath = path.join(REPO_ROOT, surface.source);
    assert.ok(existsSync(sourcePath), `${surface.source} no existe`);
    assert.equal(normalizedRoute(sourcePath), surface.route, `${surface.source} declara una URL incorrecta`);
    const source = readFileSync(sourcePath, "utf8");
    assert.match(source, new RegExp(`export\\s+(?:async\\s+)?function\\s+${surface.method}\\b`));
    if (surface.featureFlag) {
      const evidence = [source, ...localSourceClosure(sourcePath, source)];
      assert.ok(
        evidence.some((candidate) => candidate.includes(surface.featureFlag!)),
        `${surface.source} ni su configuración directa consultan ${surface.featureFlag}`
      );
    }
    if (surface.authentication === "CRON_SECRET") {
      assert.match(source, /isValidCronSecret(?:Header)?/, `${surface.source} debe revalidar CRON_SECRET`);
    }
  }
});

test("webhooks mutables tienen firma, límite, replay ledger, cuota y flag fail-closed", () => {
  const webhooks = REQUEST_SURFACES.filter((surface) => surface.kind === "WEBHOOK" && surface.mutates);
  assert.ok(webhooks.length > 0);
  for (const surface of webhooks) {
    assert.equal(surface.authentication, "WEBHOOK_SIGNATURE");
    assert.ok(surface.maxBodyBytes !== null && surface.maxBodyBytes <= 1024 * 1024);
    assert.equal(surface.idempotency, "PROVIDER_EVENT_LEDGER");
    assert.equal(surface.abuseControl, "PROVIDER_LEDGER_AND_QUOTA");
    assert.ok(surface.featureFlag, `${requestSurfaceKey(surface)} necesita un feature flag`);
    assert.ok(surface.blockers.includes("ANTIMALWARE_PROVIDER"), `${requestSurfaceKey(surface)} no puede habilitar archivos sin un escáner real`);
  }
});

test("toda brecha de rate limit queda marcada como bloqueo y no puede esconderse", () => {
  for (const surface of REQUEST_SURFACES.filter((item) => (item.abuseControl as string) === "MISSING")) {
    assert.ok(
      (surface.blockers as readonly string[]).includes("APPLICATION_RATE_LIMIT"),
      `${requestSurfaceKey(surface)} declara rate limit ausente sin bloquear el piloto`
    );
  }
});

test("los limites de aplicacion declarados tienen evidencia directa en el handler", () => {
  for (const surface of REQUEST_SURFACES.filter((item) => item.abuseControl === "DATABASE_RATE_LIMIT")) {
    const sourcePath = path.join(REPO_ROOT, surface.source);
    const source = readFileSync(sourcePath, "utf8");
    const evidence = [source, ...localSourceClosure(sourcePath, source)].join("\n");
    assert.match(
      evidence,
      /authorize(?:ExpenseDataAccess|SupportingDocumentDownload|WorkforceDataAccess)|enforceWorkforceActionRateLimit/,
      `${requestSurfaceKey(surface)} no consume el limite`,
    );
    assert.ok(
      surface.auditControl === "DATA_ACCESS_LEDGER" || surface.auditControl === "JOB_LEDGER",
      `${requestSurfaceKey(surface)} debe auditar el acceso o la ejecución`,
    );
    assert.ok(
      !(surface.blockers as readonly string[]).includes("APPLICATION_RATE_LIMIT")
        && !(surface.blockers as readonly string[]).includes("EXPORT_AUDIT"),
      `${requestSurfaceKey(surface)} conserva un bloqueo de entrega ya resuelto`,
    );
  }
});

test("archivos laborales protegidos no redirigen a signed URLs ni se renderizan inline", () => {
  for (const route of [
    "/licencias/documento/[documentId]",
    "/nomina-de-pago/proveedores/descargar",
  ]) {
    const surface = REQUEST_SURFACES.find((item) => item.route === route);
    assert.ok(surface);
    const sourcePath = path.join(REPO_ROOT, surface.source);
    const source = readFileSync(sourcePath, "utf8");
    const evidence = [source, ...localSourceClosure(sourcePath, source)].join("\n");
    assert.doesNotMatch(source, /createSignedUrl|NextResponse\.redirect/, route);
    assert.match(source, /\.download\(access\.storagePath!?\)/, route);
    assert.match(evidence, /application\/octet-stream/, route);
    assert.match(evidence, /Content-Disposition/, route);
  }

  const documents = REQUEST_SURFACES.find((item) => item.route === "/licencias/documento/[documentId]");
  assert.ok(documents?.blockers.includes("ANTIMALWARE_PROVIDER"));
});

test("exportaciones laborales consumen cuota antes de leer o construir datos", () => {
  for (const route of [
    "/dashboard/export-asistencia",
    "/nomina-de-pago/export/[batchId]",
    "/nomina-de-pago/proveedores/descargar",
  ]) {
    const surface = REQUEST_SURFACES.find((item) => item.route === route);
    assert.ok(surface);
    const source = readFileSync(path.join(REPO_ROOT, surface.source), "utf8");
    const guard = source.indexOf("authorizeWorkforceDataAccess(");
    const costlyRead = Math.max(
      source.indexOf("buildAttendanceExportData("),
      source.indexOf('.from("payroll_batch_items")'),
      source.indexOf('.from("supplier-master-files")'),
    );
    assert.ok(guard >= 0 && costlyRead > guard, `${route} debe autorizar antes de leer datos`);
  }
});

test("datos empresariales nunca usan un tenant NONE", () => {
  for (const surface of REQUEST_SURFACES.filter((item) => !["PUBLIC", "AUTH"].includes(item.dataClass))) {
    assert.notEqual(surface.tenantScope, "NONE", `${requestSurfaceKey(surface)} carece de alcance tenant`);
  }
});
