// All Nibblers tunables in one place. Pure data, no imports. Units: meters /
// seconds / radians. The swarm is a flat typed-array sim (see swarm/swarmState.js),
// rendered as ONE InstancedMesh sampling a Vertex Animation Texture.

// ── Capacity / scale ────────────────────────────────────────────────────────
export const MAX_NIBBLERS = 512;          // SoA capacity + InstancedMesh count
export const NIBBLER_SCALE_MIN = 0.1;     // 10% of a 1.7 m human
export const NIBBLER_SCALE_MAX = 0.15;    // 15%

// ── Per-nibbler FSM states (integers in the Uint8 state array) ──────────────
export const S_DESPAWN = 0;
export const S_SPAWN = 1;
export const S_WANDER = 2;
export const S_NOTICE = 3;
export const S_RUN = 4;
export const S_JUMP = 5;
export const S_ATTACHED = 6;
export const S_FALL = 7;
export const S_SCATTER = 8;

// ── VAT clip bands (column offsets into the animation texture) ──────────────
// Must match nibbler.vat.json emitted by scripts/build_nibbler_vat.mjs.
export const CLIP_IDLE = 0;
export const CLIP_RUN = 1;
export const CLIP_JUMP = 2;
export const CLIP_EMOTE = 3;

// ── Attraction timeline (seconds-marked → target active count) ──────────────
// Spec bands: 0-30s 2-5, 30-60s 10-20, 60-90s 25-40, 90-120s 50-80, 120s+ 100+.
export const ATTRACTION = [
  { t: 30, lo: 2, hi: 5 },
  { t: 60, lo: 10, hi: 20 },
  { t: 90, lo: 25, hi: 40 },
  { t: 120, lo: 50, hi: 80 },
];
export const ATTRACTION_GROWTH = 1.5;     // extra active/sec past 120s
export const ACTIVE_RESERVE = 64;         // keep slots for fall/scatter/attached

// ── Spawner ─────────────────────────────────────────────────────────────────
export const SPAWN_RING_MIN = 8;          // spawn this far from the player…
export const SPAWN_RING_MAX = 16;         // …to this far
export const SPAWN_RATE_MAX = 14;         // nibblers spawned per second (cap)
export const DESPAWN_RADIUS = 42;         // cull idle wanderers past this
export const SPAWN_BEHIND_BIAS = 0.7;     // prefer spawning off camera-forward

// ── Behavior radii / speeds ─────────────────────────────────────────────────
export const NOTICE_RADIUS = 14;
export const NIBBLER_RUN_SPEED = 4.5;
export const NIBBLER_WANDER_SPEED = 1.1;
export const NIBBLER_ACCEL = 10;
export const SEP_RADIUS = 0.6;            // separation / spatial-hash cell size
export const SEP_STRENGTH = 3.0;
export const NIBBLER_GRAVITY = -18;
export const JUMP_RADIUS = 2.0;           // start a lunge-jump within this
export const NIBBLER_JUMP_VEL = 4.0;
export const NIBBLER_LUNGE = 5.0;         // horizontal boost during a jump
export const JUMP_COOLDOWN = 1.0;
export const EMOTE_RATE = 1.5;            // VAT phase advance / sec (loops)

// ── Attach test (capsule-vs-point against the player) ───────────────────────
export const ATTACH_RADIUS = 0.3;
export const ATTACH_PAD = 0.35;
export const ATTACH_HEIGHT_BAND = 1.4;    // vertical reach around the capsule

// ── Movement penalties (a = attachedCount) ──────────────────────────────────
export const SPEED_MUL_K = 70;            // speedMul = clamp(1/(1+a/K), MIN, 1)
export const SPEED_MUL_MIN = 0.12;
export const JUMP_MUL_K = 45;             // jumpMul  = clamp(1/(1+a/K)^1.3, MIN, 1)
export const JUMP_MUL_MIN = 0.05;
export const VIS_K = 260;                 // visibility = clamp(1-(a/K)^0.85, MIN, 1)
export const VIS_POW = 0.85;
export const VIS_MIN = 0.18;

// ── Health drain ────────────────────────────────────────────────────────────
export const HEALTH_DRAIN_PER_ATTACH = 0.04; // HP/s per attached, capped
export const HEALTH_DRAIN_CAP = 2.5;         // HP/s max
export const HEALTH_COMMIT_HZ = 1.5;

// ── Stomp ───────────────────────────────────────────────────────────────────
export const STOMP_DESCEND_VEL = -1.5;    // must be falling faster than this
export const STOMP_RADIUS = 1.0;
export const STOMP_BOUNCE = 3.0;

// ── Scatter (safe-zone panic) ───────────────────────────────────────────────
export const SCATTER_SPEED = 8;
export const PANIC_FLEE = 7;
export const PANIC_POP = 3.5;
export const SCATTER_TIME = 1.2;

// ── Assets ──────────────────────────────────────────────────────────────────
export const NIBBLER_PROXY_URL = '/da-hilg/nibblers/nibbler.proxy.glb';
export const NIBBLER_VAT_JSON_URL = '/da-hilg/nibblers/nibbler.vat.json';
export const MINIMAP_URL = '/da-hilg/minimap.json';

// Per-character tints (cheap way to tell the four apart in one InstancedMesh).
// Order matches char index 0..3 = mike/kelli/cece/drew.
export const NIBBLER_TINTS = [
  [0.62, 0.74, 1.0],  // mike — cool blue
  [1.0, 0.78, 0.5],   // kelli — warm
  [1.0, 0.55, 0.85],  // cece — pink
  [0.6, 1.0, 0.7],    // drew — green
];

// ── Minimap ─────────────────────────────────────────────────────────────────
export const MINIMAP_VIEW_RADIUS = 80;    // meters shown around the player
export const MINIMAP_SIZE_PX = 180;
