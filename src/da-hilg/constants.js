// All tunables for Da Hilg in one place. Pure data, no imports — every module
// reads from here so there are no magic numbers scattered across systems.
// Units are meters / seconds / radians. The character rig is ~1.70 m tall.

// ── Characters ──────────────────────────────────────────────────────────────
export const CHARACTERS = ['mike', 'kelli', 'cece', 'drew'];
export const CHARACTER_LABELS = { mike: 'Mike', kelli: 'Kelli', cece: 'Cece', drew: 'Drew' };
// Optional one-line flavor for HUD tiles.
export const CHARACTER_BLURB = { mike: 'Dad', kelli: 'Mom', cece: 'Kid', drew: 'Kid' };

// Optimized, meshopt-compressed assets served from public/da-hilg/ (stable URLs).
export const CHARACTER_URL = {
  mike: '/da-hilg/mike.glb',
  kelli: '/da-hilg/kelli.glb',
  cece: '/da-hilg/cece.glb',
  drew: '/da-hilg/drew.glb',
};
export const ANIM_URL = {
  idle: '/da-hilg/anims/idle.glb',
  walk: '/da-hilg/anims/walk.glb',
  run: '/da-hilg/anims/run.glb',
  jump: '/da-hilg/anims/jump.glb',
  dance: '/da-hilg/anims/dance.glb',
  wave: '/da-hilg/anims/wave.glb',
  cheer: '/da-hilg/anims/cheer.glb',
};
export const LEVEL_URL = '/da-hilg/level.glb';
export const LEVEL_META_URL = '/da-hilg/level.meta.json';

// Dev fast-path: load the raw uncompressed export instead of the built level.
// Kept false in production; flip locally if the meshopt pipeline is mid-tune.
export const DEV_RAW_LEVEL = false;

// ── Body / capsule (1.70 m humanoid) ────────────────────────────────────────
// Rapier CapsuleCollider args are [halfHeight, radius] where halfHeight is the
// half-height of the *cylinder* segment. Total height = 2*(halfHeight+radius).
export const CAPSULE_RADIUS = 0.3;
export const CAPSULE_HALF_HEIGHT = 0.55; // total = 2*(0.55+0.30) = 1.70 m
export const CAPSULE_CENTER_Y = 0.85;    // capsule center above feet (feet at body y=0)

// ── Camera ──────────────────────────────────────────────────────────────────
export const EYE_HEIGHT = 1.62;
export const FP_NEAR = 0.18;   // near-plane clips the player's own head (no bone hacks)
export const TP_NEAR = 0.1;
export const CAM_FAR = 600;
export const CAM_FOV = 75;
export const TP_PIVOT_HEIGHT = 1.45;
export const TP_DISTANCE = 4.5;
export const TP_MIN_DISTANCE = 0.6;
export const TP_COLLISION_SKIN = 0.25;
export const FP_FORWARD_NUDGE = 0.06;

// ── Movement ────────────────────────────────────────────────────────────────
export const WALK_SPEED = 3.2;
export const RUN_SPEED = 6.0;
export const ACCEL_GROUND = 14;
export const ACCEL_AIR = 3;
export const JUMP_VELOCITY = 5.2;
export const GRAVITY = -18;
export const MAX_FALL = -40;
export const COYOTE_TIME = 0.12;   // seconds of grace to jump after leaving ground
export const JUMP_BUFFER = 0.1;    // seconds a queued jump stays valid

// ── Rapier KinematicCharacterController ─────────────────────────────────────
export const KCC_OFFSET = 0.01;          // collider skin width
export const MAX_SLOPE_CLIMB_DEG = 50;
export const MIN_SLOPE_SLIDE_DEG = 38;
export const AUTOSTEP_HEIGHT = 0.35;     // climb curbs/steps up to this
export const AUTOSTEP_MIN_WIDTH = 0.2;
export const SNAP_TO_GROUND = 0.3;
export const CHARACTER_MASS = 75;

// ── Look ────────────────────────────────────────────────────────────────────
export const LOOK_SENSITIVITY = 0.0022;  // rad per pixel (mouse)
export const TOUCH_LOOK_SENSITIVITY = 0.005;
export const PITCH_MAX = 1.2;            // ± clamp (rad)
export const INVERT_Y = false;

// ── Frame ───────────────────────────────────────────────────────────────────
export const DT_CLAMP = 1 / 30;          // never integrate a hitch larger than this
export const SMOOTH_ACCEL = 14;          // exponential smoothing rates: 1 - exp(-rate*dt)
export const SMOOTH_CAM = 14;
export const SMOOTH_BOOM = 12;

// ── Animation ───────────────────────────────────────────────────────────────
export const IDLE_SPEED_EPS = 0.15;      // below this horizontal speed → idle
export const RUN_ANIM_THRESH = 3.2;      // at/above → run clip
export const FADE_LOCO = 0.18;
export const FADE_IDLE = 0.2;
export const FADE_JUMP = 0.1;
export const FADE_EMOTE = 0.15;

// ── NPC AI ──────────────────────────────────────────────────────────────────
export const NOTICE_RADIUS = 20;
export const TOUCH_DIST = 1.4;
export const GREET_DIST = 2.5;
export const RETREAT_MS = 3000;
export const COOLDOWN_MS = 2000;
export const SWITCH_GRACE_MS = 1500;     // freshly-controlled actor can't be tagged yet
export const WANDER_DWELL_MIN = 2.5;
export const WANDER_DWELL_MAX = 5.0;
export const NPC_SCAN_INTERVAL = 0.25;   // re-evaluate targeting every 0.25 s
export const STUCK_TIME = 0.6;           // realized<<desired for this long → unstick nudge

// ── Scoring ─────────────────────────────────────────────────────────────────
export const SCORE_FIRST_GREET = 100;
export const SCORE_EMOTE_NEAR = 10;

// ── HUD accent palette (mirrors the driving HUD tokens) ─────────────────────
export const COLORS = {
  nav: '#2D8CFF',     // primary / progress
  go: '#2BE84F',      // positive / greeted / safe
  jump: '#9B7BFF',    // character / switch
  reverse: '#FF5247', // exit / tag / danger
  coin: '#FFC83D',    // score
  hudGlass: 'rgba(8,10,14,.66)',
  hudLine: 'rgba(255,255,255,.18)',
};

// ── Reserved for the Nibblers mode (inert in the framework) ─────────────────
// The framework ships these hooks so Nibblers layers on without a rewrite.
export const ZONE_TYPES = ['safe', 'notice', 'trigger', 'danger', 'damage', 'speed', 'noCombat'];
export const HEALTH_MAX = 100;
