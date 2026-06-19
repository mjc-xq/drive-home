// Minimap — Canvas2D widget, bottom-right. North-up, player-locked. Shows ONLY
// the three things the spec allows: the road network, the player (dot + facing
// arrow), and DISCOVERED safe zones (--go pips). It NEVER draws danger zones,
// nibblers, or undiscovered safe zones — enforced by data availability (the widget
// has no source for them), not a filter that could regress.
//
// Data sources:
//   - minimap.json  → fetched once; road segments drawn to an offscreen canvas
//                     (guarded: if absent/late, we just skip the road layer).
//   - player pos+facing → read from refs on a throttled ~10 Hz rAF (NOT an atom;
//                     continuous, would thrash the store) via
//                     registry.get(daHilgStore.get(activePlayerIdAtom)).motion.
//   - discoveredSafeZonesAtom → which pips to light.
//   - buildNibblersZones(levelMeta) → the XZ position of each safe-zone id (guarded
//                     dynamic-ish import; if unavailable, pips are simply skipped).
//
// The roads are baked to an offscreen layer once; each rAF tick clears, blits the
// roads translated by the player offset, then draws pips + player. Direct canvas
// draw, no React re-render in the loop.

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { daHilgStore } from '../../state/store.js';
import { registry, levelMeta } from '../../state/refs.js';
import { activePlayerIdAtom } from '../../state/atoms.js';
import { discoveredSafeZonesAtom } from '../state/nibblerAtoms.js';
import { MINIMAP_URL, MINIMAP_SIZE_PX, MINIMAP_VIEW_RADIUS } from '../constants.js';
import { makeMinimapProjector } from '../minimap/minimapTransform.js';
import { buildNibblersZones } from '../zones/zoneConfig.nibblers.js';

// Per-layer road strokes (read from the brand tokens; resolved at draw time so
// theme changes are honored). Drawn back-to-front: walk/curb under road over line.
const LAYER_STYLE = {
  walk: { color: 'rgba(255,255,255,0.10)', width: 1 },
  curb: { color: 'rgba(255,255,255,0.14)', width: 1 },
  drive: { color: 'rgba(255,255,255,0.16)', width: 1.5 },
  road: { color: 'rgba(255,255,255,0.26)', width: 2 },
  line: { color: 'rgba(255,200,61,0.40)', width: 1, dash: [3, 4] }, // --coin center-lines
};
const LAYER_ORDER = ['walk', 'curb', 'drive', 'road', 'line'];

const RAF_INTERVAL_MS = 100; // ~10 Hz redraw

/** Resolve a safe-zone id → [x, z] (recentered) from the nibblers zone config. */
function buildZonePositions() {
  /** @type {Map<string, [number, number]>} */
  const map = new Map();
  try {
    const defs = buildNibblersZones(levelMeta) || [];
    for (const d of defs) {
      if (d && d.type === 'safe' && Array.isArray(d.position)) {
        map.set(d.id, [d.position[0], d.position[2]]);
      }
    }
  } catch {
    /* level meta not loaded / malformed — leave empty, pips just won't draw */
  }
  return map;
}

/** Build the offscreen road layer from minimap.json. Returns {canvas, proj} or null. */
function buildRoadLayer(json) {
  const worldHalf = json?.worldHalfExtent || 220;
  const layers = json?.layers || {};
  const size = MINIMAP_SIZE_PX;
  // Bake at the same px/m as the live view so blitting is a 1:1 translate.
  const proj = makeMinimapProjector(worldHalf, size, MINIMAP_VIEW_RADIUS);

  // Oversize the offscreen canvas to the full world so any player offset still has
  // road to show at the edges: world span = 2*worldHalf meters → px.
  const worldPx = Math.ceil(2 * worldHalf * proj.pxPerMeter) + size;
  const off = document.createElement('canvas');
  off.width = worldPx;
  off.height = worldPx;
  const ctx = off.getContext('2d');
  if (!ctx) return null;

  // Offscreen origin: world (0,0) sits at the canvas center.
  const cx = worldPx / 2;
  const cz = worldPx / 2;
  const s = proj.pxPerMeter;

  for (const layer of LAYER_ORDER) {
    const segs = layers[layer];
    if (!Array.isArray(segs) || segs.length === 0) continue;
    const style = LAYER_STYLE[layer];
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash || []);
    ctx.beginPath();
    for (const seg of segs) {
      // each seg is a flat [x,z,x,z,...] polyline/segment list
      if (!Array.isArray(seg) || seg.length < 4) continue;
      let started = false;
      for (let k = 0; k + 1 < seg.length; k += 2) {
        const px = cx + seg[k] * s;
        const py = cz - seg[k + 1] * s; // north-up
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  return { canvas: off, worldPx, cx, cz, pxPerMeter: s, proj };
}

export default function Minimap() {
  const discovered = useAtomValue(discoveredSafeZonesAtom);
  const canvasRef = useRef(null);
  const roadRef = useRef(null); // { canvas, cx, cz, pxPerMeter, proj } | null
  const zonePosRef = useRef(null); // Map<id,[x,z]>
  const discoveredRef = useRef(discovered);
  discoveredRef.current = discovered;

  // Resolve safe-zone positions; recompute whenever discoveries change so a pip
  // discovered after level load (e.g. safe_home, derived from levelMeta) resolves.
  if (zonePosRef.current == null) {
    zonePosRef.current = buildZonePositions();
  }
  useEffect(() => {
    zonePosRef.current = buildZonePositions();
  }, [discovered]);

  // Fetch + bake roads once.
  useEffect(() => {
    let alive = true;
    fetch(MINIMAP_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive || !json) return;
        roadRef.current = buildRoadLayer(json);
      })
      .catch(() => {
        /* minimap.json absent/late — roads just won't draw; player+pips still do */
      });
    return () => {
      alive = false;
    };
  }, []);

  // ~10 Hz redraw loop reading refs directly (NOT atoms).
  useEffect(() => {
    const size = MINIMAP_SIZE_PX;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.scale(dpr, dpr);

    const liveProj = makeMinimapProjector(220, size, MINIMAP_VIEW_RADIUS);
    const half = size / 2;
    let raf = 0;
    let last = -Infinity;

    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (t - last < RAF_INTERVAL_MS) return;
      last = t;

      // active player pose from refs
      const id = daHilgStore.get(activePlayerIdAtom);
      const actor = id ? registry.get(id) : undefined;
      const pos = actor?.motion?.pos;
      const px = pos ? pos.x : 0;
      const pz = pos ? pos.z : 0;
      const facing = actor?.motion?.facing || 0;

      ctx.clearRect(0, 0, size, size);

      // square clip so off-map content doesn't bleed past the chrome
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.clip();

      // faint backdrop
      ctx.fillStyle = 'rgba(6,8,12,0.5)';
      ctx.fillRect(0, 0, size, size);

      // roads: blit the baked world layer, translated so the player sits center
      const road = roadRef.current;
      if (road) {
        const s = road.pxPerMeter;
        // world (px,pz) lives at (road.cx + px*s, road.cz - pz*s) in the offscreen.
        const srcX = road.cx + px * s - half;
        const srcY = road.cz - pz * s - half;
        ctx.drawImage(road.canvas, srcX, srcY, size, size, 0, 0, size, size);
      }

      // discovered safe-zone pips (--go), player-locked north-up
      const zonePos = zonePosRef.current;
      const ids = discoveredRef.current || [];
      if (zonePos && ids.length) {
        ctx.fillStyle = '#2BE84F';
        ctx.shadowColor = 'rgba(43,232,79,0.8)';
        ctx.shadowBlur = 6;
        for (const zid of ids) {
          const p = zonePos.get(zid);
          if (!p) continue;
          let [mx, my] = liveProj.worldToMap(p[0], p[1], px, pz);
          // clamp off-screen pips to the rim so distant discoveries still read
          mx = Math.max(7, Math.min(size - 7, mx));
          my = Math.max(7, Math.min(size - 7, my));
          ctx.beginPath();
          // diamond
          ctx.moveTo(mx, my - 4);
          ctx.lineTo(mx + 4, my);
          ctx.lineTo(mx, my + 4);
          ctx.lineTo(mx - 4, my);
          ctx.closePath();
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }

      // player: --jump dot + facing arrow at center. On a north-up map the arrow
      // rotates by the world facing (atan2(sin,cos)); 0 = facing +Z (south/down).
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(facing); // +Z down convention → facing rotates the arrow on screen
      ctx.fillStyle = '#9B7BFF';
      ctx.beginPath();
      ctx.moveTo(0, -7); // tip points "up" before rotate; facing offset below
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // center dot core
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(half, half, 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const count = Array.isArray(discovered) ? discovered.length : 0;

  return (
    <div
      className="nb-minimap nb-panel"
      style={{ width: MINIMAP_SIZE_PX + 10, height: MINIMAP_SIZE_PX + 10 }}
      aria-label={`Minimap — ${count} safe zones discovered`}
    >
      <canvas
        ref={canvasRef}
        style={{ width: MINIMAP_SIZE_PX, height: MINIMAP_SIZE_PX }}
      />
      <span className="nb-minimap-n" aria-hidden="true">
        N
      </span>
      {count > 0 && (
        <span className="nb-minimap-count" aria-hidden="true">
          {count}
        </span>
      )}
    </div>
  );
}
