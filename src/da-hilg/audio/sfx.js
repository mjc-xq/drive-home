// Tiny WebAudio helper for Da Hilg — no external lib, no asset files. Every cue
// is a short oscillator/noise blip synthesised on the fly so the game ships zero
// audio bytes. The whole module is STUB-SAFE: if the browser has no AudioContext
// (or it is blocked), every function degrades to a silent no-op and never throws.
//
// Autoplay policy: browsers refuse to start an AudioContext until a user gesture.
// initAudio() must therefore be called from a real gesture (the pointer-lock
// click on desktop, the first touch on mobile). Until then all cues are silent.
//
// Volumes come from settingsAtom (read imperatively via the shared store) so the
// HUD sliders take effect immediately; we also expose setVolumes() for the menu
// to push values eagerly on change.

import { daHilgStore } from '../state/store.js';
import { settingsAtom } from '../state/atoms.js';

/** @type {AudioContext|null} */
let ctx = null;
/** Master/SFX/Music gain stages. master → destination; sfx & music → master. */
let masterGain = null;
let sfxGain = null;
let musicGain = null;
/** Ambience nodes (lazy, started on demand). */
let ambienceNodes = null;
/** Cached settings volumes, kept in sync via setVolumes(). */
const vol = { master: 0.8, sfx: 0.9, music: 0.5 };

/** Pull the latest volumes from the store (safe before the store has them). */
function readVolumesFromStore() {
  try {
    const s = daHilgStore.get(settingsAtom);
    if (s) {
      if (typeof s.master === 'number') vol.master = s.master;
      if (typeof s.sfx === 'number') vol.sfx = s.sfx;
      if (typeof s.music === 'number') vol.music = s.music;
    }
  } catch {
    /* store not ready — keep defaults */
  }
}

/** Apply cached volumes to the live gain nodes (if the graph exists). */
function applyVolumes() {
  if (!ctx) return;
  const t = ctx.currentTime;
  // clamp to [0..1] so a bad slider value can never blow an ear out
  const clamp = (v) => Math.max(0, Math.min(1, v));
  if (masterGain) masterGain.gain.setTargetAtTime(clamp(vol.master), t, 0.02);
  if (sfxGain) sfxGain.gain.setTargetAtTime(clamp(vol.sfx), t, 0.02);
  if (musicGain) musicGain.gain.setTargetAtTime(clamp(vol.music) * 0.6, t, 0.05);
}

/**
 * Create the AudioContext + gain graph. MUST be called from a user gesture.
 * Idempotent and exception-safe: a second call just resumes a suspended ctx.
 */
export function initAudio() {
  if (ctx) {
    // Already built — a later gesture may need to resume a suspended context.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no WebAudio → stay silent
    ctx = new AC();
    masterGain = ctx.createGain();
    sfxGain = ctx.createGain();
    musicGain = ctx.createGain();
    sfxGain.connect(masterGain);
    musicGain.connect(masterGain);
    masterGain.connect(ctx.destination);
    readVolumesFromStore();
    applyVolumes();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {
    ctx = null; // give up quietly; all cues become no-ops
  }
}

/** True only when we have a running context to make sound with. */
function ready() {
  return !!ctx && ctx.state === 'running';
}

/**
 * Core blip: a single oscillator with a fast attack / exponential decay envelope.
 * @param {object} o
 * @param {number} o.freq      start frequency (Hz)
 * @param {number} [o.freqTo]  optional glide target (Hz)
 * @param {number} [o.dur]     duration (s)
 * @param {number} [o.gain]    peak gain (0..1)
 * @param {OscillatorType} [o.type]
 * @param {number} [o.delay]   start offset (s)
 * @param {number} [o.pan]     stereo pan (-1..1)
 */
function blip({ freq, freqTo, dur = 0.12, gain = 0.25, type = 'sine', delay = 0, pan = 0 }) {
  if (!ready()) return;
  try {
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (typeof freqTo === 'number') {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), now + dur);
    }
    // fast attack, smooth exponential tail (avoids clicks)
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let tail = g;
    if (typeof StereoPannerNode !== 'undefined' && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);
      g.connect(p);
      tail = p;
    }
    osc.connect(g);
    tail.connect(sfxGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  } catch {
    /* never let audio crash a frame */
  }
}

/** Short filtered-noise burst — used for footsteps and whooshes. */
function noiseBurst({ dur = 0.1, gain = 0.15, type = 'lowpass', freq = 900, delay = 0 }) {
  if (!ready()) return;
  try {
    const now = ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(sfxGain);
    src.start(now);
    src.stop(now + dur + 0.02);
  } catch {
    /* no-op on failure */
  }
}

// ── Public cue surface (all guarded no-ops when audio unavailable) ───────────

/** Footstep — soft low thud; gated to grounded+moving by the caller. */
export function footstep() {
  noiseBurst({ dur: 0.07, gain: 0.08, type: 'lowpass', freq: 420 });
}

/** Greet success — rising friendly two-note chime. */
export function greetChime(pan = 0) {
  blip({ freq: 523.25, dur: 0.12, gain: 0.22, type: 'triangle', pan });           // C5
  blip({ freq: 783.99, dur: 0.18, gain: 0.22, type: 'triangle', delay: 0.1, pan }); // G5
}

/** NPC tagged you — soft playful descending boop. */
export function tagBoop() {
  blip({ freq: 360, freqTo: 180, dur: 0.16, gain: 0.2, type: 'square' });
}

/** Zone enter — gentle soft ping. */
export function zonePing() {
  blip({ freq: 660, freqTo: 880, dur: 0.16, gain: 0.16, type: 'sine' });
}

/** Emote fired — short airy whoosh. */
export function emoteWhoosh() {
  noiseBurst({ dur: 0.22, gain: 0.12, type: 'bandpass', freq: 1400 });
}

/** Win — celebratory rising arpeggio sting. */
export function winSting() {
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) =>
    blip({ freq: f, dur: 0.26, gain: 0.24, type: 'triangle', delay: i * 0.1 }),
  );
}

/**
 * Update cached volumes and push them to the live graph. Safe to call any time;
 * the HUD menu calls this on slider change so audio reacts immediately.
 * @param {{master?:number,sfx?:number,music?:number}} v
 */
export function setVolumes(v) {
  if (v && typeof v === 'object') {
    if (typeof v.master === 'number') vol.master = v.master;
    if (typeof v.sfx === 'number') vol.sfx = v.sfx;
    if (typeof v.music === 'number') vol.music = v.music;
  }
  applyVolumes();
}

/**
 * Start the low ambient bed — a couple of detuned low oscillators + airy noise,
 * routed through the music gain so the Music slider controls it. Idempotent.
 */
export function startAmbience() {
  if (!ready() || ambienceNodes) return;
  try {
    const now = ctx.currentTime;
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = 'sine';
    oscB.type = 'sine';
    oscA.frequency.setValueAtTime(110, now);
    oscB.frequency.setValueAtTime(110 * 1.5 + 0.4, now); // slight detune → movement
    const bedGain = ctx.createGain();
    bedGain.gain.setValueAtTime(0.0001, now);
    bedGain.gain.exponentialRampToValueAtTime(0.04, now + 1.5); // slow fade-in
    oscA.connect(bedGain);
    oscB.connect(bedGain);
    bedGain.connect(musicGain);
    oscA.start(now);
    oscB.start(now);
    ambienceNodes = { oscA, oscB, bedGain };
  } catch {
    ambienceNodes = null;
  }
}

/** Fade out and tear down the ambient bed. Safe if ambience never started. */
export function stopAmbience() {
  if (!ambienceNodes || !ctx) return;
  try {
    const now = ctx.currentTime;
    const { oscA, oscB, bedGain } = ambienceNodes;
    bedGain.gain.cancelScheduledValues(now);
    bedGain.gain.setTargetAtTime(0.0001, now, 0.3);
    oscA.stop(now + 1.2);
    oscB.stop(now + 1.2);
  } catch {
    /* ignore */
  } finally {
    ambienceNodes = null;
  }
}
