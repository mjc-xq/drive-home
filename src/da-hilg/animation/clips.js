// Canonical animation clip manifest. All four characters share a byte-identical
// 24-bone Mixamo rig, so the shared clips in public/da-hilg/anims/ bind to any of
// them with zero remapping. Clip GLBs are already renamed to these keys and have
// stripRootXZ applied to walk/run at build time (see scripts/build_dahilg_assets.mjs).

// 'attack' is an aggressive looping clip used by the Nibblers swarm when clinging —
// the family never triggers it as an emote, but every rig loads it (shared 24-bone rig).
export const CLIP_KEYS = ['idle', 'walk', 'run', 'jump', 'dance', 'wave', 'cheer', 'attack'];

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
  attack: 'repeat', // nibblers flail/slam continuously while clinging
};

// Whether an emote holds until interrupted (dance) or plays once (wave/cheer).
export const EMOTE_HELD = { dance: true, wave: false, cheer: false };

// Optional per-character signature dance override (cut for v1 — all map to the
// shared 'dance'; left here so Nibblers/polish can re-enable without plumbing).
export const SIGNATURE_DANCE = { mike: 'dance', kelli: 'dance', cece: 'dance', drew: 'dance' };

// Map an emote key (1/2/3 or HUD) to its clip key.
export const EMOTE_SLOT = { 1: 'wave', 2: 'cheer', 3: 'dance' };

const SKIN_SAFE_CLIP_CACHE = new WeakMap();

function isHipsPositionTrack(trackName) {
  if (!trackName.endsWith('.position')) return false;
  const target = trackName.slice(0, -'.position'.length);
  return target === 'Hips' || target.endsWith('/Hips');
}

/**
 * Clone a shared Mixamo clip into the subset safe to retarget across the family rigs.
 * Bone rotations carry the motion. Non-Hips position tracks carry source bind offsets
 * and can tear mismatched waists; scale tracks are redundant unit rows today and risky
 * if a future export bakes non-unit bone scale.
 * @param {import('three').AnimationClip} clip
 * @returns {import('three').AnimationClip}
 */
export function skinSafeClip(clip) {
  const cached = SKIN_SAFE_CLIP_CACHE.get(clip);
  if (cached) return cached;

  const safe = clip.clone();
  safe.tracks = safe.tracks.filter((track) => {
    if (track.name.endsWith('.scale')) return false;
    if (track.name.endsWith('.position') && !isHipsPositionTrack(track.name)) return false;
    return true;
  });
  safe.resetDuration();
  SKIN_SAFE_CLIP_CACHE.set(clip, safe);
  return safe;
}
