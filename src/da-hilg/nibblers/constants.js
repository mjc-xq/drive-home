// All Nibblers tunables in one place. Pure data, no imports. Units: meters /
// seconds / radians. The swarm is a flat typed-array sim (see swarm/swarmState.js),
// rendered as ONE InstancedMesh sampling a Vertex Animation Texture.

// ── Capacity / scale ────────────────────────────────────────────────────────
export const MAX_NIBBLERS = 512;          // SoA capacity + InstancedMesh count
export const NIBBLER_SCALE_MIN = 0.2;     // 20% of a 1.7 m human
export const NIBBLER_SCALE_MAX = 0.3;     // 30%

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
// Must match the BANDS order in scripts/build_nibbler_vat.mjs + nibbler.vat.json.
// Band order: [idle, run, attack, dance]. ATTACK is a downward ground-slam emote and
// DANCE is the family love-pop dance — the two horde moods (menacing vs. partying).
export const CLIP_IDLE = 0;
export const CLIP_RUN = 1;
export const CLIP_ATTACK = 2;
export const CLIP_DANCE = 3;

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

// ── Cling placement (attached nibblers riding the body surface) ─────────────
// Anchors tile the player capsule from feet→head: ANGULAR_SLOTS columns around the
// body × stacked layers. Each layer pushes the cling a little further out so a big
// pile covers the body (concentric shells) instead of fighting for one ring.
export const CLING_ANGULAR_SLOTS = 7;     // angular columns around the body axis
export const CLING_NIBBLER_HALF = 0.18;   // nibbler half-size → sits proud of the skin
export const CLING_LAYER_STEP = 0.16;     // each concentric layer this much further out
export const CLING_Y_BOTTOM = 0.18;       // lowest anchor band (m above feet)
export const CLING_Y_TOP = 1.72;          // highest anchor band (m above feet, ~head)

// ── Jump-eject (player jump flings the cling off for a beat, then it re-clings) ─
export const EJECT_WINDOW = 0.45;         // seconds the eject pulse lasts
export const EJECT_OUT = 0.7;             // peak outward shove from the body axis (m)
export const EJECT_UP = 0.45;             // peak upward shove (m)
export const EJECT_VELY_TRIGGER = 1.0;    // player velY crossing up past this also fires

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
export const HEALTH_REGEN = 5;               // HP/s recovered when nothing is attached
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
// Per-character VAT: the build bakes one textured proxy + pos/nrm/color textures per
// family member (mike/kelli/cece/drew) into public/da-hilg/nibblers/. The combined
// manifest (nibbler.vat.json) maps each character key to its assets; the runtime reads
// proxy/texture URLs from there. NIBBLER_CHARS is the canonical order (charIx 0..3).
export const NIBBLER_ASSET_BASE = '/da-hilg/nibblers/';
export const NIBBLER_CHARS = ['mike', 'kelli', 'cece', 'drew'];
export const NIBBLER_PROXY_URL = (key) => `${NIBBLER_ASSET_BASE}nibbler.${key}.proxy.glb`;
export const NIBBLER_VAT_JSON_URL = '/da-hilg/nibblers/nibbler.vat.json';
export const MINIMAP_URL = '/da-hilg/minimap.json';

// Per-character tints — now a FAINT variety nudge layered on top of the REAL baseColor
// texture (the dominant look). Kept near-white so each member reads as themselves; a
// gentle hue separates them in a dense pile. Order = char index 0..3 = mike/kelli/cece/drew.
export const NIBBLER_TINTS = [
  [0.92, 0.96, 1.0],  // mike — faint cool
  [1.0, 0.96, 0.9],   // kelli — faint warm
  [1.0, 0.94, 0.98],  // cece — faint pink
  [0.94, 1.0, 0.95],  // drew — faint green
];

// ── Minimap ─────────────────────────────────────────────────────────────────
export const MINIMAP_VIEW_RADIUS = 80;    // meters shown around the player
export const MINIMAP_SIZE_PX = 180;
