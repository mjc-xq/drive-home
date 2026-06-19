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
  attack: '/da-hilg/anims/attack.glb',
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
export const FP_NEAR = 0.16;   // near-plane clips the player's own head (no bone hacks)
export const TP_NEAR = 0.1;
export const CAM_FAR = 600;
export const CAM_FOV = 68;     // base vertical FOV (matches DaHilgApp init); runtime adds speed-FOV
export const TP_PIVOT_HEIGHT = 1.5;  // look pivot ≈ shoulder/neck of a 1.7 m character
export const TP_DISTANCE = 3.8;      // boom length behind the shoulder pivot
export const TP_MIN_DISTANCE = 0.7;  // never let collision pull the boom inside the head
export const TP_COLLISION_SKIN = 0.3; // keep the cam this far off a wall it backs into
export const FP_FORWARD_NUDGE = 0.06;

// Over-the-shoulder framing: push the character off-center so the path ahead
// reads. The pivot (boom anchor + look target) slides right in camera-right space
// and the look target rises slightly so we sight just over the shoulder.
export const TP_SHOULDER_X = 0.55;   // lateral offset (m, +right) — character sits left of center
export const TP_SHOULDER_Y = 0.06;   // look a touch above the pivot for headroom

// Speed-FOV: a gentle widening as realized speed ramps walk → run, for a sense
// of motion. Kept small so it never disorients.
export const SPEED_FOV_GAIN = 5;     // max extra degrees at full run
export const SPEED_FOV_SMOOTH = 4;   // how fast FOV chases the speed target

// Landing dip: a brief vertical settle when slamming back to ground from a fall.
export const LANDING_DIP_VEL = 6;    // |downward velY| (m/s) at touchdown for a full dip
export const LANDING_DIP_MAX = 0.18; // peak camera drop (m)
export const LANDING_DIP_RECOVER = 9; // how fast the dip springs back out

// ── Movement ────────────────────────────────────────────────────────────────
export const WALK_SPEED = 4.6;
export const RUN_SPEED = 8.2;
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
export const AUTOSTEP_HEIGHT = 0.5;      // climb curbs/steps/sidewalks up to this
export const AUTOSTEP_MIN_WIDTH = 0.15;
export const SNAP_TO_GROUND = 0.6;       // hug the hill's slopes so feet stay planted
export const CHARACTER_MASS = 75;

// The character meshes are authored facing +Z (toward the camera in third-person);
// add PI so the visible body faces its travel/look direction (away from the camera).
export const MODEL_FACING_OFFSET = Math.PI;
// Idle clip (a boxer's warmup) is bouncy — slow it to a calm ready-sway, not a dance.
export const IDLE_TIMESCALE = 0.5;

// ── Look ────────────────────────────────────────────────────────────────────
export const LOOK_SENSITIVITY = 0.0022;  // rad per pixel (mouse)
export const TOUCH_LOOK_SENSITIVITY = 0.005;
export const PITCH_MAX = 1.2;            // ± clamp (rad)
export const INVERT_Y = false;

// ── Frame ───────────────────────────────────────────────────────────────────
export const DT_CLAMP = 1 / 30;          // never integrate a hitch larger than this
export const SMOOTH_ACCEL = 14;          // exponential smoothing rates: 1 - exp(-rate*dt)
export const SMOOTH_CAM = 12;            // boom/position follow — a touch of cinematic lag
export const SMOOTH_LOOK = 22;           // look target chases fast so aim stays crisp
export const SMOOTH_BOOM_IN = 60;        // collision shrink: snap in to never clip a wall
export const SMOOTH_BOOM = 7;            // collision ease-out: glide back to full length

// ── Animation ───────────────────────────────────────────────────────────────
export const IDLE_SPEED_EPS = 0.15;      // below this horizontal speed → idle
export const RUN_ANIM_THRESH = 4.5;      // at/above → run clip (between WALK 3.2 and RUN 6)
export const FADE_LOCO = 0.18;
export const FADE_IDLE = 0.2;
export const FADE_JUMP = 0.1;
export const FADE_EMOTE = 0.15;
// Distant non-controlled actors throttle their AnimationMixer — advancing the mixer +
// re-deriving skinning matrices for a far background body is wasted work, and mike/kelli
// are heavy meshes. Beyond ANIM_FAR_DIST m a non-player actor re-skins at ~ANIM_FAR_DT
// cadence instead of every frame (invisible at distance).
export const ANIM_FAR_DIST = 32;
export const ANIM_FAR_DT = 1 / 20;

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
