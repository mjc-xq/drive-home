import * as THREE from 'three';

// Canonical animation clip manifest. The public clip GLBs share the 24 Mixamo-style
// bone names used by the family, but Meshy-generated characters do NOT all share the
// same local rest pose. Binding by name is fine only after we retarget rotations by
// the source->target rest-pose delta below.

// 'attack' is an aggressive looping clip used by the Nibblers swarm when clinging —
// the family never triggers it as an emote, but every character can load/retarget it.
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
const RETARGETED_CLIP_CACHE = new Map();

function isHipsPositionTrack(trackName) {
  if (!trackName.endsWith('.position')) return false;
  const target = trackName.slice(0, -'.position'.length);
  return target === 'Hips' || target.endsWith('/Hips');
}

function trackNodeName(trackName) {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    return parsed.nodeName?.split('/').pop() || '';
  } catch {
    const path = trackName.slice(0, trackName.lastIndexOf('.'));
    return path.split('/').pop();
  }
}

function findNamedObject(root, name) {
  return root?.getObjectByName?.(name) || null;
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

/**
 * Clone a shared clip, remove unsafe channels, then convert local bone rotations from
 * the clip source rest pose to the target character rest pose.
 *
 * Meshy rigs can have matching bone names but very different local rest rotations
 * around the hips/spine. Applying the source animation's absolute local quaternions
 * directly is what makes waists look snapped or twisted. For each bone:
 *
 *   sourceDelta = inverse(sourceRest) * sourceAnimated
 *   targetAnimated = targetRest * sourceDelta
 *
 * The Hips position track gets the same rest-offset treatment so bob/root motion stays
 * relative to the target rig instead of replacing its bind offset.
 *
 * @param {import('three').AnimationClip} clip
 * @param {import('three').Object3D|null|undefined} sourceRoot clip GLB scene/root
 * @param {import('three').Object3D|null|undefined} targetRoot character clone/root
 * @param {string} targetKey stable character/rig key for cache reuse
 * @returns {import('three').AnimationClip}
 */
export function retargetSkinSafeClip(clip, sourceRoot, targetRoot, targetKey = '') {
  if (!clip || !sourceRoot || !targetRoot || !targetKey) return skinSafeClip(clip);

  const cacheKey = `${targetKey}:${clip.uuid}`;
  const cached = RETARGETED_CLIP_CACHE.get(cacheKey);
  if (cached) return cached;

  const safe = clip.clone();
  safe.tracks = safe.tracks.filter((track) => {
    if (track.name.endsWith('.scale')) return false;
    if (track.name.endsWith('.position') && !isHipsPositionTrack(track.name)) return false;
    return true;
  });

  const sourceQ = new THREE.Quaternion();
  const sourceRestInvQ = new THREE.Quaternion();
  const targetRestQ = new THREE.Quaternion();
  const retargetedQ = new THREE.Quaternion();
  const deltaQ = new THREE.Quaternion();
  const sourceRestP = new THREE.Vector3();
  const targetRestP = new THREE.Vector3();

  for (const track of safe.tracks) {
    const name = trackNodeName(track.name);
    const sourceNode = findNamedObject(sourceRoot, name);
    const targetNode = findNamedObject(targetRoot, name);
    if (!sourceNode || !targetNode) continue;

    if (track.name.endsWith('.quaternion')) {
      sourceRestInvQ.copy(sourceNode.quaternion).invert();
      targetRestQ.copy(targetNode.quaternion);
      for (let i = 0; i < track.values.length; i += 4) {
        sourceQ.fromArray(track.values, i);
        deltaQ.copy(sourceRestInvQ).multiply(sourceQ);
        retargetedQ.copy(targetRestQ).multiply(deltaQ).normalize();
        retargetedQ.toArray(track.values, i);
      }
    } else if (isHipsPositionTrack(track.name)) {
      sourceRestP.copy(sourceNode.position);
      targetRestP.copy(targetNode.position);
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] = targetRestP.x + (track.values[i] - sourceRestP.x);
        track.values[i + 1] = targetRestP.y + (track.values[i + 1] - sourceRestP.y);
        track.values[i + 2] = targetRestP.z + (track.values[i + 2] - sourceRestP.z);
      }
    }
  }

  safe.resetDuration();
  RETARGETED_CLIP_CACHE.set(cacheKey, safe);
  return safe;
}
