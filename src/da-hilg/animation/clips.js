// Canonical animation clip manifest. All four characters share a byte-identical
// 24-bone Mixamo rig, so the seven clips in public/da-hilg/anims/ bind to any of
// them with zero remapping. Clip GLBs are already renamed to these keys and have
// stripRootXZ applied to walk/run at build time (see scripts/build_dahilg_assets.mjs).

export const CLIP_KEYS = ['idle', 'walk', 'run', 'jump', 'dance', 'wave', 'cheer'];

export const LOCOMOTION_KEYS = ['idle', 'walk', 'run', 'jump'];
export const EMOTE_KEYS = ['dance', 'wave', 'cheer'];

// THREE loop semantics per clip. 'once' clips clamp on their last frame and
// raise the mixer 'finished' event so the emote system can return to locomotion.
export const CLIP_LOOP = {
  idle: 'repeat',
  walk: 'repeat',
  run: 'repeat',
  jump: 'once',
  dance: 'repeat',
  wave: 'once',
  cheer: 'once',
};

// Whether an emote holds until interrupted (dance) or plays once (wave/cheer).
export const EMOTE_HELD = { dance: true, wave: false, cheer: false };

// Optional per-character signature dance override (cut for v1 — all map to the
// shared 'dance'; left here so Nibblers/polish can re-enable without plumbing).
export const SIGNATURE_DANCE = { mike: 'dance', kelli: 'dance', cece: 'dance', drew: 'dance' };

// Map an emote key (1/2/3 or HUD) to its clip key.
export const EMOTE_SLOT = { 1: 'wave', 2: 'cheer', 3: 'dance' };
