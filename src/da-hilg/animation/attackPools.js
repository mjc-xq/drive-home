// Per-character attack pools — the dynamic fighting model. A press advances a flowing
// multi-hit combo (within a combo window); every Nth swing escalates to the character's
// FINISHER, and a dedicated kick is a separate input. Pure data + one tiny picker, no engine
// coupling — the keys map straight onto the per-character override clips wired in
// ANIM_OVERRIDE_URL (mike boxer / kelli aerial / cece capoeira / drew flamboyant). Reversible
// by deleting this file and reverting requestPunch.

export const ATTACK_POOLS = {
  mike: { combo: ['attack', 'attack2', 'attack3'], kick: 'attack4', finisher: 'attack5' },
  kelli: { combo: ['attack', 'attack2', 'attack3'], kick: 'attack4', finisher: 'attack5' },
  cece: { combo: ['attack', 'attack2', 'attack3'], kick: 'attack4', finisher: 'attack5' },
  drew: { combo: ['attack', 'attack2', 'attack3'], kick: 'attack4', finisher: 'attack5' },
};

export const COMBO_WINDOW_MS = 900; // press again within this to advance the combo
export const ATTACK_COOLDOWN_MS = 240; // min ms between swings (spam gate)
export const FINISHER_EVERY = 5; // every Nth swing in a chain escalates to the finisher

const DEFAULT_POOL = ATTACK_POOLS.mike;

/**
 * Pick the attack clip key for a character at a given swing index in the current chain.
 * Every FINISHER_EVERY-th swing is the finisher; otherwise the 3-hit combo cycles.
 * @param {string} character mike|kelli|cece|drew
 * @param {number} swing 0-based monotonic swing counter within a combo chain
 * @returns {string} a clip key (attack|attack2|attack3|attack4|attack5)
 */
export function pickAttackKey(character, swing) {
  const pool = ATTACK_POOLS[character] || DEFAULT_POOL;
  if (FINISHER_EVERY > 0 && swing > 0 && (swing + 1) % FINISHER_EVERY === 0) return pool.finisher;
  return pool.combo[swing % pool.combo.length];
}

/** The character's dedicated kick key (bound to a separate input). */
export function kickKey(character) {
  return (ATTACK_POOLS[character] || DEFAULT_POOL).kick;
}
