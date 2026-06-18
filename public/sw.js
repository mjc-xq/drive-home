const VERSION = "2026-06-18b";
// Only the SHELL cache is versioned: index.html and friends live at STABLE urls
// but change content per deploy, so they must be re-fetched. Everything else is
// content-addressed — Vite stamps a content hash into every asset/model filename,
// and map tiles are immutable per coordinate — so those caches are UNVERSIONED
// and survive deploys. That's what makes an asset "downloaded once": an unchanged
// GLB keeps its hashed url across releases and is served straight from cache, and
// only genuinely-changed files (new hash) are ever fetched again.
const SHELL_CACHE = `dahill-shell-${VERSION}`;
const ASSET_CACHE = "dahill-assets-v2";
const MODEL_CACHE = "dahill-models-v2";
const MAP_CACHE = "dahill-map-tiles-v2";

const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

const DAY = 24 * 60 * 60;
const LIMITS = {
  assets: { maxEntries: 220, maxAgeSeconds: 120 * DAY },
  models: { maxEntries: 64, maxAgeSeconds: 180 * DAY },
  // Heavy photoreal/vector tiles, cached by a session-stripped key (see
  // tileCacheKey) so the SAME tile is reused across views, drives and reloads
  // instead of re-downloading. Generous ceiling; LRU-trimmed.
  mapTiles: { maxEntries: 3000, maxAgeSeconds: 30 * DAY },
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

  // Heavy immutable tile PAYLOADS: cache-first under a session-stripped key, so a
  // tile fetched once is reused on every later view/drive/reload (no re-download).
  if (isMapTileContent(url)) {
    event.respondWith(cacheFirst(request, MAP_CACHE, { ...LIMITS.mapTiles, keyUrl: tileCacheKey(url) }));
    return;
  }

  // Tile METADATA (root/subtree tileset json, styles, the Maps SDK): these carry
  // the rotating session, so keep them fresh — serve cache instantly but refresh.
  if (isMapDataRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, MAP_CACHE, LIMITS.mapTiles));
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

// The heavy, immutable tile PAYLOADS within isMapDataRequest — content-addressed
// per coordinate, so they're safe to cache-first and reuse indefinitely. Excludes
// the rotating tileset/style/SDK metadata, which stays stale-while-revalidate.
function isMapTileContent(url) {
  const host = url.hostname;
  const path = url.pathname;

  // Google Photorealistic 3D Tiles: the glTF payloads (the bandwidth hog).
  if (host === "tile.googleapis.com") return /\.glb($|\?)/i.test(path) || path.includes("/files/");
  // Mapbox vector tiles.
  if (host === "api.mapbox.com") return /\.(mvt|pbf)$/i.test(path) || path.includes("/tiles/");
  // Static Google map sprites/imagery + the versioned, immutable decoder libs.
  if (host === "maps.gstatic.com") return true;
  if (host === "www.gstatic.com" && path.includes("/draco/")) return true;
  if (host === "cdn.jsdelivr.net" && path.includes("/basis/")) return true;

  return false;
}

// A cache key for tile content with the volatile auth params stripped, so the
// SAME tile requested under a different session/key (e.g. after a reload) is a
// cache HIT. The original request — auth intact — is still what gets fetched.
function tileCacheKey(url) {
  const u = new URL(url.href);
  for (const param of ["session", "key", "access_token", "pb"]) u.searchParams.delete(param);
  return u.href;
}

async function cacheFirst(request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);
  // options.keyUrl lets tiles be stored/looked-up under a session-stripped key
  // while still being fetched with the original (authenticated) request.
  const key = options.keyUrl || request;
  const cached = await matchFresh(cache, key, options.maxAgeSeconds);
  if (cached) return cached;

  const response = await fetch(request);
  await cacheUsableResponse(cache, key, response);
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
