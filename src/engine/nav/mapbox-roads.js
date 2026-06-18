import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const TILESET_ID = 'mapbox.mapbox-streets-v8';
const ROAD_LAYER = 'road';
const MAX_WEB_MERCATOR_LAT = 85.05112878;
const START_ZOOM = 14;
const MIN_ZOOM = 11;
const MAX_TILES_PER_BOX = 42;
const TILE_BATCH_SIZE = 8;
const TILE_TIMEOUT_MS = 8000;
const D2R = Math.PI / 180;

const DRIVABLE_CLASSES = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'street', 'street_limited',
  'service',
]);

function mapboxToken() {
  return (import.meta.env && import.meta.env.VITE_MAPBOX_TOKEN) || '';
}

export function hasMapboxRoadToken() {
  return !!mapboxToken();
}

export async function fetchMapboxRoadBox(ctx, x, z, r) {
  const token = mapboxToken();
  if (!token) return null;

  const plan = planRoadTiles(ctx, x, z, r);
  const segs = [];
  const seen = new Set();
  const failures = [];
  let loadedTiles = 0;

  for (let i = 0; i < plan.tiles.length; i += TILE_BATCH_SIZE) {
    const batch = plan.tiles
      .slice(i, i + TILE_BATCH_SIZE)
      .map(tile => fetchTileRoads(ctx, tile, token, segs, seen));
    const results = await Promise.allSettled(batch);
    for (const result of results) {
      if (result.status === 'fulfilled') loadedTiles += result.value;
      else failures.push(result.reason);
    }
  }

  if (!loadedTiles && failures.length) {
    const status = failures.map(e => e && e.status).find(Boolean);
    const err = new Error('mapbox road tiles unavailable');
    if (status) err.status = status;
    throw err;
  }

  return { source: 'mapbox', segs, zoom: plan.zoom, tileCount: plan.tiles.length, loadedTiles };
}

async function fetchTileRoads(ctx, tile, token, segs, seen) {
  const response = await fetchWithTimeout(mapboxTileUrl(tile, token), TILE_TIMEOUT_MS);
  if (response.status === 404) return 1;
  if (!response.ok) {
    const err = new Error(`mapbox tile ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.arrayBuffer();
  appendRoadSegs(ctx, data, tile, segs, seen);
  return 1;
}

function mapboxTileUrl(tile, token) {
  return `https://api.mapbox.com/v4/${TILESET_ID}/${tile.z}/${tile.x}/${tile.y}.mvt?access_token=${encodeURIComponent(token)}`;
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
}

function appendRoadSegs(ctx, data, tile, segs, seen) {
  const vt = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = vt.layers[ROAD_LAYER];
  if (!layer) return;

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2 || !isDrivableRoad(feature.properties)) continue;

    const extent = feature.extent || layer.extent || 4096;
    for (const line of feature.loadGeometry()) {
      let prev = null;
      for (const p of line) {
        const cur = tilePointToWorld(ctx, tile, extent, p.x, p.y);
        if (prev) pushUniqueSeg(segs, seen, prev, cur);
        prev = cur;
      }
    }
  }
}

function isDrivableRoad(props) {
  return DRIVABLE_CLASSES.has(props && props.class);
}

function tilePointToWorld(ctx, tile, extent, px, py) {
  const n = 2 ** tile.z;
  const lon = ((tile.x + px / extent) / n) * 360 - 180;
  const mercY = (tile.y + py / extent) / n;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY))) / D2R;
  const w = ctx.geo.geoToWorld(lat, lon);
  return [w[0], w[1]];
}

function pushUniqueSeg(segs, seen, a, b) {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5) return;

  const ak = `${Math.round(a[0] * 2)},${Math.round(a[1] * 2)}`;
  const bk = `${Math.round(b[0] * 2)},${Math.round(b[1] * 2)}`;
  const key = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
  if (seen.has(key)) return;

  seen.add(key);
  segs.push([[a[0], a[1]], [b[0], b[1]]]);
}

function planRoadTiles(ctx, x, z, r) {
  const bounds = roadBoxBounds(ctx, x, z, r);

  for (let zoom = START_ZOOM; zoom >= MIN_ZOOM; zoom--) {
    let tiles = tilesForBounds(bounds, zoom);
    if (tiles.length <= MAX_TILES_PER_BOX || zoom === MIN_ZOOM) {
      if (tiles.length > MAX_TILES_PER_BOX) tiles = centerSortTiles(tiles, bounds.center, zoom).slice(0, MAX_TILES_PER_BOX);
      return { zoom, tiles, bounds };
    }
  }

  return { zoom: MIN_ZOOM, tiles: [], bounds };
}

function roadBoxBounds(ctx, x, z, r) {
  const samples = [
    [x, z],
    [x - r, z - r], [x + r, z - r], [x - r, z + r], [x + r, z + r],
    [x - r, z], [x + r, z], [x, z - r], [x, z + r],
  ];
  const geos = samples
    .map(p => ctx.geo.worldToGeo(p[0], p[1]))
    .filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lon));
  const center = geos[0] || { lat: 0, lon: 0 };
  const lats = geos.map(g => clamp(g.lat, -MAX_WEB_MERCATOR_LAT, MAX_WEB_MERCATOR_LAT));

  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    lonIntervals: lonIntervalsFor(geos.map(g => g.lon)),
    center,
  };
}

function tilesForBounds(bounds, z) {
  const n = 2 ** z;
  const y0 = latToTileY(bounds.north, z);
  const y1 = latToTileY(bounds.south, z);
  const ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
  const byKey = new Map();

  for (const interval of bounds.lonIntervals) {
    const xmin = lon360ToTileX(interval.west360, z);
    const xmax = lon360ToTileX(interval.east360, z);
    for (let y = ymin; y <= ymax; y++) {
      for (let x = xmin; x <= xmax; x++) {
        const tx = ((x % n) + n) % n;
        byKey.set(`${z}/${tx}/${y}`, { z, x: tx, y });
      }
    }
  }

  return [...byKey.values()];
}

function centerSortTiles(tiles, center, z) {
  const n = 2 ** z;
  const cx = lon360ToTileX(normLon360(center.lon), z);
  const cy = latToTileY(center.lat, z);
  return [...tiles].sort((a, b) => tileDist(a, cx, cy, n) - tileDist(b, cx, cy, n));
}

function tileDist(tile, cx, cy, n) {
  const dx = Math.min(Math.abs(tile.x - cx), n - Math.abs(tile.x - cx));
  const dy = tile.y - cy;
  return dx * dx + dy * dy;
}

function lonIntervalsFor(lons) {
  const vals = lons
    .filter(Number.isFinite)
    .map(normLon360)
    .sort((a, b) => a - b);
  if (!vals.length) return [{ west360: 0, east360: 360 }];
  if (vals.length === 1) return [{ west360: vals[0], east360: vals[0] }];

  let maxGap = -1, gapIdx = 0;
  for (let i = 0; i < vals.length; i++) {
    const next = vals[(i + 1) % vals.length];
    const gap = (next - vals[i] + 360) % 360;
    if (gap > maxGap) { maxGap = gap; gapIdx = i; }
  }

  const start = vals[(gapIdx + 1) % vals.length];
  const end = vals[gapIdx];
  if (start <= end) return [{ west360: start, east360: end }];
  return [{ west360: start, east360: 360 }, { west360: 0, east360: end }];
}

function normLon360(lon) {
  return (((lon + 180) % 360) + 360) % 360;
}

function lon360ToTileX(lon360, z) {
  const n = 2 ** z;
  const x = Math.floor((Math.min(360 - 1e-10, Math.max(0, lon360)) / 360) * n);
  return clamp(x, 0, n - 1);
}

function latToTileY(lat, z) {
  const n = 2 ** z;
  const phi = clamp(lat, -MAX_WEB_MERCATOR_LAT, MAX_WEB_MERCATOR_LAT) * D2R;
  const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
  return clamp(y, 0, n - 1);
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

export const _test = {
  isDrivableRoad,
  lonIntervalsFor,
  planRoadTiles,
};
