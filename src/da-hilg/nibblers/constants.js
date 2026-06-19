// All Nibblers tunables in one place. Pure data, no imports. Units: meters /
// seconds / radians. The swarm is a flat typed-array sim (see swarm/swarmState.js).
//
// As of the NPC rework the horde is no longer a VAT InstancedMesh. The SoA sim is
// unchanged (it stays the single source of truth for marked/active/attached counts,
// penalties, health, scatter, stomp), but it is now CAPPED to a small pool of REAL
// skinned NPC characters (Cece + Drew, the two light Meshy bodies) driven by real
// AnimationMixers so they move like people with smoothly cross-faded clips. The
// active count is CPU-throttled by a rolling frame-time average (see render/throttle.js).

// ── Capacity / scale ────────────────────────────────────────────────────────
// MAX_NIBBLERS is the SoA capacity AND the hard ceiling on simultaneously-mounted
// real NPCs — kept small because each one is a skinned clone with its own mixer
// (NOT a GPU instance). The throttle servos the live count inside [MIN, MAX].
export const NIBBLER_NPC_MAX = 32;        // hard cap on real NPC characters in the pool
export const NIBBLER_NPC_MIN = 6;         // throttle never drops the cap below this
export const MAX_NIBBLERS = NIBBLER_NPC_MAX; // SoA capacity == pool size (one slot ↔ one NPC)
// The horde reads as mini-clones (the Nibblers look) even though each is a real skinned
// NPC — kept small so a pile clings believably to the 1.7 m player capsule. Slightly
// larger than the old VAT clones since these carry full detail.
export const NIBBLER_SCALE_MIN = 0.28;
export const NIBBLER_SCALE_MAX = 0.36;

// ── CPU throttle (rolling frame-time → dynamic active cap) ──────────────────
// Each frame we fold the real frame time into an exponential moving average. If the
// average climbs past the budget the active cap ramps DOWN (fewer NPCs animate); if
// frames are smooth it ramps back UP toward NIBBLER_NPC_MAX. This keeps the horde as
// large as the machine can sustain without dropping frames.
export const NIBBLER_FRAME_BUDGET_MS = 19; // target avg ms/frame (~52 fps headroom band)
export const NIBBLER_FRAME_SLACK_MS = 3;   // dead-band: only adjust outside budget ± slack
export const NIBBLER_FRAME_EMA = 0.1;      // EMA weight for the new frame sample (0..1)
export const NIBBLER_CAP_RAMP_DOWN = 18;   // cap units shed per second when over budget
export const NIBBLER_CAP_RAMP_UP = 4;      // cap units added per second when smooth

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
// Slots kept free for fall/scatter/attached. With a small NPC pool the throttle cap
// (render/throttle.js) is the real limiter, so this only needs a couple of slots of
// headroom so a freshly-attached NPC never starves a new spawn.
export const ACTIVE_RESERVE = 4;          // keep slots for fall/scatter/attached

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
export const CLING_NIBBLER_HALF = -0.05;  // feet press slightly INTO the skin (contact, not floating)
export const CLING_LAYER_STEP = 0.06;     // layers stay near the surface (perpendicular clingers fan out)
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

// The real-NPC pool uses ONLY the two light Meshy bodies — cece (~5.6k verts) and
// drew (~13k). mike/kelli are 128k-vert and far too heavy to clone × the pool size.
// charIx values that the spawner assigns (indices into NIBBLER_CHARS / CHARACTER_URL):
//   2 = cece, 3 = drew. Order is the spawn rotation.
export const NIBBLER_NPC_CHARS = ['cece', 'drew'];
export const NIBBLER_NPC_CHAR_IX = [2, 3]; // their indices in NIBBLER_CHARS
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
