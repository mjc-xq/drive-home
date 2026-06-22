import * as THREE from 'three';

// Canonical animation clip manifest. The public clip GLBs share the 24 Mixamo-style
// bone names used by the family, but Meshy-generated characters do NOT all share the
// same local rest pose. Binding by name is fine only after we retarget rotations by
// the source->target rest-pose delta below.

// 'attack' is an aggressive looping clip used by the Nibblers swarm when clinging —
// the family never triggers it as an emote, but every character can load/retarget it.
export const CLIP_KEYS = ['idle', 'walk', 'run', 'jump', 'dance', 'wave', 'cheer', 'attack', 'climb', 'crawl', 'stumble', 'hit', 'knockdown'];

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
  climb: 'repeat', // nibblers clinging/climbing on a body
  crawl: 'repeat', // downed player dragging along the ground
  stumble: 'repeat', // staggering under the swarm load
  hit: 'once', // flinch
  knockdown: 'once', // the fall when first overwhelmed
};

// Whether an emote holds until interrupted (dance) or plays once (wave/cheer).
export const EMOTE_HELD = { dance: true, wave: false, cheer: false };

// Optional per-character signature dance override (cut for v1 — all map to the
// shared 'dance'; left here so Nibblers/polish can re-enable without plumbing).
export const SIGNATURE_DANCE = { mike: 'dance', kelli: 'dance', cece: 'dance', drew: 'dance' };

// Map an emote key (1/2/3 or HUD) to its clip key.
export const EMOTE_SLOT = { 1: 'wave', 2: 'cheer', 3: 'dance' };

// Clips whose feet must stay on the ground. The family rigs are pure FK (no foot IK),
// so ANY Hips-Y motion in a clip lifts the whole chain — feet included — off the
// grounded motion.pos origin: the body floats AND the feet-anchored clinging nibblers
// detach. For these clips we pin Hips Y to its frame-0 value (see retargetSkinSafeClip).
// jump/climb/crawl intentionally keep their vertical motion; knockdown is clamped (it
// may sink toward the ground as the body falls, but must never rise above standing).
const GROUNDED_FLAT_Y = new Set([
  'idle', 'walk', 'run', 'dance', 'wave', 'cheer', 'stumble', 'attack', 'hit',
]);

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

// Legacy DONOR clip rigs (dad/family-anims/jack-hartmann — Jump/Wave/Cheer/Stumble) name the
// trunk Spine/Spine01/Spine02/neck; the canonical shared Mixamo skeleton uses Spine/Spine1/
// Spine2/Neck. Without this map those torso/neck tracks find no target bone and are skipped,
// shipping a frozen mid-back + neck on the family bodies (mirrors the Unity builder's alias).
const DONOR_BONE_ALIAS = {
  Spine01: 'Spine1',
  Spine02: 'Spine2',
  Spine03: 'Spine2',
  neck: 'Neck',
  Neck01: 'Neck',
};

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
 * @param {string} clipKey canonical clip key (idle/walk/dance/...) — drives the grounded
 *   Hips-Y flatten so the feet stay planted on the family's FK rigs
 * @returns {import('three').AnimationClip}
 */
export function retargetSkinSafeClip(clip, sourceRoot, targetRoot, targetKey = '', clipKey = '') {
  if (!clip || !sourceRoot || !targetRoot || !targetKey) return skinSafeClip(clip);

  const cacheKey = `${targetKey}:${clipKey}:${clip.uuid}`;
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
  const dropTracks = new Set();

  for (const track of safe.tracks) {
    const name = trackNodeName(track.name);
    const sourceNode = findNamedObject(sourceRoot, name);
    let targetNode = findNamedObject(targetRoot, name);
    if (!targetNode && DONOR_BONE_ALIAS[name]) {
      const canon = DONOR_BONE_ALIAS[name];
      targetNode = findNamedObject(targetRoot, canon);
      // Rename the track to the canonical bone so THREE.PropertyBinding binds it at runtime —
      // otherwise the retargeted values point at a non-existent 'Spine01' and the torso freezes.
      if (targetNode) track.name = track.name.replace(name, canon);
    }
    // Drop tracks that bind to NO target bone (foreign fingers/leaves: *HandThumb*, head_end,
    // headfront): leaving them makes THREE warn 'No target node found' and animates nothing.
    if (!sourceNode || !targetNode) { dropTracks.add(track); continue; }

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
      // Keep the feet on the ground (FK rig — no foot IK). Grounded clips get Hips Y
      // pinned to frame 0 so a dance/strut/flinch can't lift the body off motion.pos
      // (which is what made emotes float and the clinging nibblers detach). Knockdown
      // is only clamped: it may drop toward the ground but must never rise above
      // standing rest, so the "fall" reads without popping the body upward first.
      if (GROUNDED_FLAT_Y.has(clipKey)) {
        const groundedY = track.values[1];
        for (let i = 1; i < track.values.length; i += 3) track.values[i] = groundedY;
      } else if (clipKey === 'knockdown') {
        const restY = track.values[1];
        for (let i = 1; i < track.values.length; i += 3) {
          if (track.values[i] > restY) track.values[i] = restY;
        }
      }
    }
  }

  if (dropTracks.size) safe.tracks = safe.tracks.filter((t) => !dropTracks.has(t));
  safe.resetDuration();
  RETARGETED_CLIP_CACHE.set(cacheKey, safe);
  return safe;
}
