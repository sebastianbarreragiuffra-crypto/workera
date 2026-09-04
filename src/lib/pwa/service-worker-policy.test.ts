import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

function loadPolicy() {
  const context = vm.createContext({
    URL,
    Promise,
    self: {
      location: { origin: "https://gestora.example" },
      addEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {},
    fetch() {},
  });
  vm.runInContext(source, context);
  return {
    canCache(url: string): boolean {
      return vm.runInContext(`isCacheableStaticUrl(new URL(${JSON.stringify(url)}))`, context) as boolean;
    },
    precache(): string[] {
      return vm.runInContext("Array.from(PRECACHE_URLS)", context) as string[];
    },
  };
}

test("service worker solo permite assets públicos e inmutables del mismo origen", () => {
  const policy = loadPolicy();
  assert.equal(policy.canCache("https://gestora.example/_next/static/chunks/app-abc.js"), true);
  assert.equal(policy.canCache("https://gestora.example/icons/gestora-192.png"), true);
  assert.equal(policy.canCache("https://gestora.example/manifest.webmanifest"), true);
  assert.equal(policy.canCache("https://gestora.example/favicon.ico"), true);
  assert.equal(policy.canCache("https://otro.example/_next/static/chunks/app-abc.js"), false);
});

test("service worker nunca cachea APIs, auth, PII, comprobantes, documentos ni exportaciones", () => {
  const policy = loadPolicy();
  for (const pathname of [
    "/api/jobs/expense-accounting",
    "/api/expenses/empresa/bank-import",
    "/auth/callback?code=secreto",
    "/login",
    "/empresas/acme/rendiciones",
    "/empresas/acme/rendiciones/comprobantes/receipt-id",
    "/empresas/acme/rendiciones/contabilidad/export-id/csv",
    "/documentos",
    "/licencias/documento/id",
    "/nomina-de-pago/export/id",
    "/_next/image?url=%2Fdocumento-privado.png",
  ]) {
    assert.equal(policy.canCache(`https://gestora.example${pathname}`), false, pathname);
  }
});

test("precache contiene solo la pantalla offline y recursos públicos sin datos de empresa", () => {
  const precache = loadPolicy().precache();
  assert.ok(precache.includes("/offline"));
  assert.ok(precache.every((entry) => entry === "/offline" || entry.startsWith("/icons/") || entry === "/manifest.webmanifest"));
  assert.ok(precache.every((entry) => !/api|auth|empresa|rendicion|documento|nomina|receipt|csv/i.test(entry)));
});

test("navegaciones usan red y solo caen a la pantalla offline; no guardan HTML autenticado", () => {
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /fetch\(request\)\.catch\(\(\) => caches\.match\(OFFLINE_URL\)\)/);
  assert.doesNotMatch(source, /cache\.put\(request,[^\n]+navigate/i);
  assert.doesNotMatch(source, /indexedDB|backgroundsync|sync\.register/i);
});

test("al activar elimina solo caches antiguas de GESTORA", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const deleted: string[] = [];
  const context = vm.createContext({
    URL,
    Promise,
    self: {
      location: { origin: "https://gestora.example" },
      addEventListener(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
      skipWaiting() {},
      clients: { async claim() {} },
    },
    caches: {
      async keys() { return ["gestora-shell-v0", "gestora-shell-v1", "otra-aplicacion-v3"]; },
      async delete(key: string) { deleted.push(key); return true; },
    },
    fetch() {},
  });
  vm.runInContext(source, context);

  let activation: Promise<unknown> | undefined;
  handlers.get("activate")?.({ waitUntil(value: Promise<unknown>) { activation = value; } });
  assert.ok(activation, "activate debe prolongar la vida del worker");
  await activation;
  assert.deepEqual(deleted, ["gestora-shell-v0"]);
});

test("la respuesta de un asset espera a que cache.put termine", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let releasePut: (() => void) | undefined;
  const putFinished = new Promise<void>((resolve) => { releasePut = resolve; });
  const networkResponse = {
    ok: true,
    type: "basic",
    clone() { return { copy: true }; },
  };
  const context = vm.createContext({
    URL,
    Promise,
    self: {
      location: { origin: "https://gestora.example" },
      addEventListener(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      async match() { return undefined; },
      async open() { return { async put() { await putFinished; } }; },
      async keys() { return []; },
      async delete() { return true; },
    },
    async fetch() { return networkResponse; },
  });
  vm.runInContext(source, context);

  let responsePromise: Promise<unknown> | undefined;
  handlers.get("fetch")?.({
    request: {
      method: "GET",
      mode: "no-cors",
      url: "https://gestora.example/_next/static/chunks/app.js",
    },
    respondWith(value: Promise<unknown>) { responsePromise = value; },
  });
  assert.ok(responsePromise, "el asset debe usar respondWith");

  let settled = false;
  responsePromise.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "respondWith no debe terminar antes de cache.put");
  releasePut?.();
  assert.equal(await responsePromise, networkResponse);
});
