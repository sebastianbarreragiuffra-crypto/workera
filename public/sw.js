/* GESTORA PWA: shell mínimo. Nunca persiste datos de negocio ni respuestas autenticadas. */
const CACHE_VERSION = "gestora-shell-v2";
const MAX_RUNTIME_STATIC_ENTRIES = 80;
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/gestora-192.png",
  "/icons/gestora-512.png",
  "/icons/gestora-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

function isCacheableStaticUrl(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith("/_next/static/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/manifest.webmanifest"
    || url.pathname === "/favicon.ico";
}

async function storeRuntimeStaticAsset(cache, request, response) {
  try {
    await cache.put(request, response);
    const keys = await cache.keys();
    const runtimeKeys = keys.filter((key) => new URL(key.url).pathname.startsWith("/_next/static/"));
    const excess = runtimeKeys.length - MAX_RUNTIME_STATIC_ENTRIES;
    if (excess > 0) {
      await Promise.all(runtimeKeys.slice(0, excess).map((key) => cache.delete(key)));
    }
  } catch {
    // Cache Storage es una optimización. Cuota llena, modo privado o una
    // caché corrupta nunca deben convertir una respuesta de red válida en error.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("gestora-shell-") && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Toda navegación es network-only: el HTML autenticado jamás entra al
  // cache. Sin red se responde únicamente la pantalla pública y genérica.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Allowlist cerrada: solo assets inmutables del build e íconos públicos.
  // /api, /auth, Supabase, _next/image, comprobantes, documentos y CSV caen
  // por defecto al fetch normal y nunca se guardan.
  if (!isCacheableStaticUrl(url)) return;
  event.respondWith(
    caches.match(request).catch(() => undefined).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response.ok || response.type !== "basic") return response;
        const copy = response.clone();
        return caches.open(CACHE_VERSION)
          .then((cache) => storeRuntimeStaticAsset(cache, request, copy))
          .catch(() => undefined)
          .then(() => response);
      });
    })
  );
});
