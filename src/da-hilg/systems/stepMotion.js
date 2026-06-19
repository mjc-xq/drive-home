// stepMotion — THE single Rapier KinematicCharacterController apply site. Runs
// for EVERY actor each frame (player + NPCs are identical here; they differ only
// in the Intent their controller produced). No other module may call
// computeColliderMovement.
//
// Contract (CONTRACTS.md §stepMotion):
//   • intent.move is already a WORLD-space XZ direction (magnitude 0..1) — the
//     controller baked in the camera-relative mapping, so we DON'T rotate by yaw.
//   • integrate horizontal accel (ground vs air), gravity + coyote/buffer jump,
//   • computeColliderMovement(collider, desired,
//       EXCLUDE_SENSORS | EXCLUDE_KINEMATIC, undefined, undefined),
//   • read computedMovement(), setNextKinematicTranslation(t + mv),
//   • computedGrounded() resets velY,
//   • write motion.{pos,velX,velY,velZ,speed,facing,grounded,lastGroundedT},
//   • facing: player → camera yaw; NPC → travel direction (slerped).
//
// dt is already clamped by the caller (GameSystems uses DT_CLAMP).

import {
  WALK_SPEED,
  RUN_SPEED,
  ACCEL_GROUND,
  ACCEL_AIR,
  JUMP_VELOCITY,
  GRAVITY,
  MAX_FALL,
  COYOTE_TIME,
  JUMP_BUFFER,
  CAPSULE_CENTER_Y,
  MODEL_FACING_OFFSET,
} from '../constants.js';
// Nibblers swarm penalty: {1,1,1} in greet mode (no-op), scaled by attached count
// in nibblers mode. Framework-level coupling kept to this one read site each.
import { nibblerPenalty } from '../nibblers/mode.js';

// Reused scratch so the per-frame loop never allocates.
const _desired = { x: 0, y: 0, z: 0 };

/** Shortest-arc angle lerp for NPC facing (radians). */
function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * @param {import('../actors/actorRegistry.js').Actor} actor
 * @param {import('../controllers/Controller.js').Intent} intent
 * @param {object} ctx per-frame context (see CONTRACTS.md); needs ctx.rapier, ctx.dt, ctx.now, ctx.cameraRig
 */
export function stepMotion(actor, intent, ctx) {
  const ref = actor.ref;
  // Skip until this actor's physics handles exist (refs null for a frame or two
  // while <Physics> boots and GLBs stream).
  if (!ref || !ref.kcc || !ref.rigid || !ref.collider) return;

  const dt = ctx.dt;
  const now = ctx.now; // ms
  const m = actor.motion;
  const kcc = ref.kcc;
  const rigid = ref.rigid;
  const collider = ref.collider;
  const rapier = ctx.rapier;

  // ── 1. Target horizontal velocity from the (already world-space) move dir ──
  let mx = intent.move.x;
  let mz = intent.move.z;
  const mag = Math.hypot(mx, mz);
  if (mag > 1) {
    mx /= mag;
    mz /= mag;
  }
  const speed = (intent.run ? RUN_SPEED : WALK_SPEED) * nibblerPenalty.speedMul;
  const targetVX = mx * speed;
  const targetVZ = mz * speed;

  // ── 2. Accelerate toward target (frame-rate-independent), ground vs air ──
  const wasGrounded = m.grounded;
  const accel = wasGrounded ? ACCEL_GROUND : ACCEL_AIR;
  const k = 1 - Math.exp(-accel * dt);
  m.velX += (targetVX - m.velX) * k;
  m.velZ += (targetVZ - m.velZ) * k;

  // ── 3. Vertical: gravity + jump with coyote time + jump buffer ──
  if (wasGrounded) m.lastGroundedT = now;
  const canCoyote = now - m.lastGroundedT <= COYOTE_TIME * 1000;
  const bufferedJump =
    intent.jump ||
    (m.jumpBufferedT >= 0 && now - m.jumpBufferedT <= JUMP_BUFFER * 1000);
  // Remember a fresh jump press so it survives the last few airborne frames.
  if (intent.jump) m.jumpBufferedT = now;

  if (bufferedJump && (wasGrounded || canCoyote)) {
    m.velY = JUMP_VELOCITY * nibblerPenalty.jumpMul;
    m.lastGroundedT = -1; // consume coyote
    m.jumpBufferedT = -1; // consume buffer
  } else if (m.jumpBufferedT >= 0 && now - m.jumpBufferedT > JUMP_BUFFER * 1000) {
    m.jumpBufferedT = -1; // buffer expired
  }

  // Small stick-down force keeps us hugging ground/steps when grounded.
  if (wasGrounded && m.velY < 0) m.velY = -2;
  m.velY += GRAVITY * dt;
  if (m.velY < MAX_FALL) m.velY = MAX_FALL;

  // ── 4. Solve collide-and-slide via the KCC (the ONLY call site) ──
  _desired.x = m.velX * dt;
  _desired.y = m.velY * dt;
  _desired.z = m.velZ * dt;
  kcc.computeColliderMovement(
    collider,
    _desired,
    rapier.QueryFilterFlags.EXCLUDE_SENSORS | rapier.QueryFilterFlags.EXCLUDE_KINEMATIC,
    undefined,
    undefined,
  );
  const mv = kcc.computedMovement();
  const grounded = kcc.computedGrounded();

  // KCC clamped vertical (hit floor/ceiling) → don't accumulate gravity.
  if (grounded && m.velY < 0) m.velY = 0;
  if (mv.y > _desired.y + 1e-4 && m.velY < 0) m.velY = 0; // landed / stepped up

  // ── 5. Apply (kinematic interpolation) ──
  const t = rigid.translation(); // RigidBody origin = capsule CENTER
  rigid.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });

  // ── 6. Write motion fields read by animation/camera/AI ──
  // motion.pos is the actor's FEET (camera/eyeWorld/AI all assume feet). The
  // RigidBody origin is the capsule center, so subtract the center offset.
  m.pos.set(t.x + mv.x, t.y + mv.y - CAPSULE_CENTER_Y, t.z + mv.z);
  m.grounded = grounded;
  if (grounded) m.lastGroundedT = now;
  // Realized planar speed (what actually moved this frame) — drives the anim FSM.
  m.speed = Math.hypot(mv.x, mv.z) / Math.max(dt, 1e-5);

  // ── 7. Facing: player snaps to camera yaw; NPC slerps toward travel dir ──
  if (actor.role === 'player') {
    m.facing = ctx.cameraRig.yaw;
  } else if (Math.hypot(m.velX, m.velZ) > 0.1) {
    const travel = Math.atan2(m.velX, m.velZ);
    m.facing = angleLerp(m.facing, travel, 1 - Math.exp(-12 * dt));
  }

  // Keep the visual group oriented to facing (+ the model's authored-forward
  // offset so the body faces its travel/look direction, not the camera).
  if (ref.group) ref.group.rotation.y = m.facing + MODEL_FACING_OFFSET;
}

export default stepMotion;
