const VERSION = "2026-06-19a";   // bumped to force-evict the bad cache-first tile cache (dahill-*-v2) from the reverted SW change
const SHELL_CACHE = `dahill-shell-${VERSION}`;
const ASSET_CACHE = `dahill-assets-${VERSION}`;
const MODEL_CACHE = `dahill-models-${VERSION}`;
const MAP_CACHE = `dahill-map-data-${VERSION}`;

const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

const DAY = 24 * 60 * 60;
const LIMITS = {
  assets: { maxEntries: 180, maxAgeSeconds: 30 * DAY },
  models: { maxEntries: 48, maxAgeSeconds: 180 * DAY },
  mapData: { maxEntries: 1400, maxAgeSeconds: 12 * 60 * 60 },
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, MODEL_CACHE, MAP_CACHE]);

  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.map((name) => (keep.has(name) ? undefined : caches.delete(name)))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, { fallbackUrl: "/index.html" }));
    return;
  }

  if (isModelAsset(url)) {
    event.respondWith(cacheFirst(request, MODEL_CACHE, LIMITS.models));
    return;
  }

  if (isMapDataRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, MAP_CACHE, LIMITS.mapData));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, LIMITS.assets));
  }
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isModelAsset(url) {
  if (!isSameOrigin(url)) return false;
  return /\.(glb|gltf|usdz)$/i.test(url.pathname);
}

function isStaticAsset(url) {
  if (!isSameOrigin(url)) return false;
  return (
    url.pathname.startsWith("/assets/") ||
    /\.(css|js|mjs|json|wasm|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|ico|ktx2)$/i.test(
      url.pathname,
    )
  );
}

function isMapDataRequest(url) {
  const host = url.hostname;
  const path = url.pathname;

  if (host === "api.mapbox.com") {
    return (
      path.includes("/v4/") ||
      path.includes("/tiles/") ||
      path.includes("/styles/v1/") ||
      path.endsWith(".mvt") ||
      path.endsWith(".vector.pbf")
    );
  }

  if (host === "tile.googleapis.com") return true;
  if (host === "maps.gstatic.com") return true;
  if (host === "maps.googleapis.com" && path === "/maps/api/js") return true;
  if (host === "www.gstatic.com" && path.includes("/draco/")) return true;
  if (host === "cdn.jsdelivr.net" && path.includes("/basis/")) return true;

  return false;
}

async function cacheFirst(request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);
  const cached = await matchFresh(cache, request, options.maxAgeSeconds);
  if (cached) return cached;

  const response = await fetch(request);
  await cacheUsableResponse(cache, request, response);
  trimCache(cacheName, options.maxEntries);
  return response;
}

async function staleWhileRevalidate(request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);
  const cached = await matchFresh(cache, request, options.maxAgeSeconds);

  const refreshed = fetch(request)
    .then(async (response) => {
      await cacheUsableResponse(cache, request, response);
      trimCache(cacheName, options.maxEntries);
      return response;
    })
    .catch(() => cached);

  return cached || refreshed;
}

async function networkFirst(request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    await cacheUsableResponse(cache, request, response);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (options.fallbackUrl) {
      const fallback = await cache.match(options.fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function matchFresh(cache, request, maxAgeSeconds) {
  const cached = await cache.match(request);
  if (!cached) return undefined;

  const fetchedAt = Number(cached.headers.get("sw-fetched-at") || "0");
  if (!maxAgeSeconds || !fetchedAt || Date.now() - fetchedAt <= maxAgeSeconds * 1000) {
    return cached;
  }

  await cache.delete(request);
  return undefined;
}

async function cacheUsableResponse(cache, request, response) {
  if (!response) return;
  if (response.type !== "opaque" && !response.ok) return;

  if (response.type === "opaque") {
    await cache.put(request, response.clone());
    return;
  }

  const headers = new Headers(response.headers);
  headers.set("sw-fetched-at", String(Date.now()));

  const cachedResponse = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  await cache.put(request, cachedResponse);
}

async function trimCache(cacheName, maxEntries) {
  if (!maxEntries) return;

  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const deletes = [];

  while (keys.length > maxEntries) {
    deletes.push(cache.delete(keys.shift()));
  }

  await Promise.all(deletes);
}
