import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SERVICE_ROLE_CAPABILITIES } from "../supabase/service-role-capabilities";
import {
  RPC_CONSUMER_SURFACES,
  STORAGE_CONSUMER_SURFACES,
  storageConsumerKey,
} from "./data-surfaces";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const LITERAL_RPC = /\.rpc\(\s*["']([^"']+)["']/g;
const DYNAMIC_RPC = /\.rpc\(\s*rpc\s*,/g;
const STORAGE_CALL = /\.storage\s*\.\s*from\(\s*([^)]+?)\s*\)\s*\.\s*(upload|download|remove|createSignedUrl)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return sourceFiles(fullPath);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [fullPath];
  });
}

function relativeSource(filePath: string): `src/${string}.ts` {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/") as `src/${string}.ts`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function literalRpcNames(source: string): string[] {
  return uniqueSorted([...source.matchAll(LITERAL_RPC)].map((match) => match[1]));
}

function resolveBucket(source: string, expression: string): string {
  const trimmed = expression.trim();
  const literal = trimmed.match(/^["']([^"']+)["']$/);
  if (literal) return literal[1];

  assert.match(trimmed, /^[A-Z][A-Z0-9_]*$/, `bucket Storage no resoluble: ${trimmed}`);
  const declaration = new RegExp(`(?:const|let)\\s+${trimmed}\\s*=\\s*["']([^"']+)["']`).exec(source);
  assert.ok(declaration, `falta resolver el bucket ${trimmed}`);
  return declaration[1];
}

test("todo consumidor RPC esta inventariado con sus nombres exactos", () => {
  const discovered = new Map<string, string[]>();
  for (const filePath of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(filePath, "utf8");
    if (!source.includes(".rpc(")) continue;
    discovered.set(relativeSource(filePath), literalRpcNames(source));
  }

  const registered = new Map<string, string[]>(RPC_CONSUMER_SURFACES.map((surface) => [
    surface.source,
    uniqueSorted(surface.literalRpcs),
  ] as const));

  assert.equal(registered.size, RPC_CONSUMER_SURFACES.length, "hay una fuente RPC duplicada");
  assert.deepEqual([...registered.keys()].sort(), [...discovered.keys()].sort());
  for (const [source, names] of discovered) assert.deepEqual(registered.get(source), names, source);

  const registeredNames = uniqueSorted(RPC_CONSUMER_SURFACES.flatMap((surface) => [
    ...surface.literalRpcs,
    ...surface.dynamicRpcs,
  ]));
  assert.equal(RPC_CONSUMER_SURFACES.length, 31);
  assert.equal(registeredNames.length, 97);
});

test("los RPC dinamicos tienen un conjunto cerrado comprobable", () => {
  for (const surface of RPC_CONSUMER_SURFACES) {
    const source = readFileSync(path.join(REPO_ROOT, surface.source), "utf8");
    const dynamicCalls = [...source.matchAll(DYNAMIC_RPC)].length;
    assert.equal(dynamicCalls, surface.dynamicRpcs.length > 0 ? 1 : 0, surface.source);
    assert.deepEqual(
      uniqueSorted(surface.dynamicRpcs),
      [...surface.dynamicRpcs].sort(),
      `${surface.source} repite un RPC dinamico`,
    );
    for (const rpcName of surface.dynamicRpcs) {
      assert.match(source, new RegExp(`["']${rpcName}["']`), `${surface.source} no demuestra ${rpcName}`);
      assert.ok(!(surface.literalRpcs as readonly string[]).includes(rpcName), `${surface.source} duplica ${rpcName}`);
    }
  }
});

test("cada identidad RPC privilegiada referencia una capability registrada", () => {
  for (const surface of RPC_CONSUMER_SURFACES) {
    if (surface.executionIdentity === "SESSION") {
      assert.equal(surface.capability, null, surface.source);
      continue;
    }
    assert.ok(surface.capability, `${surface.source} no declara capability`);
    assert.ok(
      Object.hasOwn(SERVICE_ROLE_CAPABILITIES, surface.capability),
      `${surface.source} usa una capability desconocida`,
    );
  }
});

test("la deuda RPC legacy y controles sensibles nunca quedan ocultos", () => {
  for (const surface of RPC_CONSUMER_SURFACES) {
    if (surface.tenantScope === "LEGACY_ARCOTEX") {
      assert.ok(surface.blockers.includes("LABOR_MULTI_TENANCY"), surface.source);
    }
    if (surface.auditControl === "PARTIAL" && surface.dataClass !== "AUTH") {
      assert.ok(surface.blockers.length > 0, `${surface.source} oculta auditoria parcial sin deuda`);
    }
  }
});

test("el control plane declara su cuota distribuida sin deuda contradictoria", () => {
  const platformSurfaces = RPC_CONSUMER_SURFACES.filter((surface) =>
    surface.domain === "platform"
    && (surface.source.includes("plataforma/actions") || surface.source.includes("action-rate-limit"))
  );
  assert.equal(platformSurfaces.length, 2);
  for (const surface of platformSurfaces) {
    assert.ok(!(surface.blockers as readonly string[]).includes("APPLICATION_RATE_LIMIT"), surface.source);
  }
  assert.ok(platformSurfaces.some((surface) =>
    (surface.literalRpcs as readonly string[]).includes("consume_platform_action_rate_limit")
  ));
});

test("cada operacion Storage esta inventariada con bucket y ocurrencias exactas", () => {
  const discovered = new Map<string, number>();
  for (const filePath of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(STORAGE_CALL)) {
      const key = storageConsumerKey({
        source: relativeSource(filePath),
        bucket: resolveBucket(source, match[1]),
        operation: match[2] as "upload" | "download" | "remove" | "createSignedUrl",
      });
      discovered.set(key, (discovered.get(key) ?? 0) + 1);
    }
  }

  const registered = new Map(STORAGE_CONSUMER_SURFACES.map((surface) => [
    storageConsumerKey(surface),
    surface.occurrences,
  ] as const));
  assert.equal(registered.size, STORAGE_CONSUMER_SURFACES.length, "hay una operacion Storage duplicada");
  assert.deepEqual([...registered.keys()].sort(), [...discovered.keys()].sort());
  for (const [key, count] of discovered) assert.equal(registered.get(key), count, key);
  assert.equal([...discovered.values()].reduce((sum, count) => sum + count, 0), 15);
});

test("Storage sensible conserva cuarentena o explicita su bloqueo", () => {
  for (const surface of STORAGE_CONSUMER_SURFACES) {
    if (surface.securityState === "PRIVATE_UNSCANNED") {
      assert.ok(surface.blockers.includes("ANTIMALWARE_PROVIDER"), surface.source);
    }
    if (surface.tenantScope === "LEGACY_ARCOTEX") {
      assert.ok(surface.blockers.includes("LABOR_MULTI_TENANCY"), surface.source);
    }
    if (surface.executionIdentity === "SERVICE_ROLE_CAPABILITY") {
      assert.notEqual(surface.tenantScope, "NONE", surface.source);
    }
  }
});
