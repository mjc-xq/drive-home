// One-time device-capability tier. The renderer was applying a fixed dpr={[1,2]} and a
// fixed 4096² shadow map to everything from an M-series desktop to a base iPhone — and
// on iOS a dpr-2 buffer on a 3× Retina screen is ~4× the fragments, the #1 mobile stall.
// We detect a coarse tier ONCE at module load (cheap signals only, no per-frame cost) and
// expose render budgets the Canvas + SceneEnv read for their initial config. Manual
// toggles (perfMode, grass, facades) still override; this only sets smarter defaults.

function detect() {
  // SSR / headless safety: assume desktop-high.
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { tier: 'high', dprMax: 2, shadowSize: 4096, maxNpc: 32, isIOS: false };
  }
  const ua = navigator.userAgent || '';
  // iOS (incl. iPadOS reporting as Mac with a touch screen).
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4; // GB (Chromium only; undefined → assume 4)
  const mobile = isIOS || coarse;

  let tier;
  if (mobile && (cores <= 4 || mem <= 4)) tier = 'low';
  else if (mobile || cores <= 4 || mem <= 4) tier = 'mid';
  else tier = 'high';

  const byTier = {
    // dprMax: hard cap on the drawing-buffer scale (fill is the mobile limiter).
    // shadowSize: directional shadow map (only paid when graphics/shadows are on).
    // maxNpc: ceiling for the mounted Nibbler pool (skinned-clone memory pressure).
    low: { dprMax: 1.25, shadowSize: 1024, maxNpc: 14 },
    mid: { dprMax: 1.5, shadowSize: 2048, maxNpc: 24 },
    high: { dprMax: 2, shadowSize: 4096, maxNpc: 32 },
  }[tier];

  return { tier, isIOS, ...byTier };
}

export const deviceTier = detect();
