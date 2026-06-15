// All audio is tiny procedural WebAudio — no samples. The AudioContext is
// created lazily on a user gesture (entering a mode) so iOS lets it play.
export function createAudio() {
  let AC = null;
  let eng = null;

  function ensure() {
    try {
      if (!AC) {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        // iOS moves the context to 'interrupted'/'suspended' on a phone call,
        // Siri, route change or backgrounding; auto-resume so audio doesn't go
        // permanently silent for the rest of the session.
        AC.onstatechange = () => { if (AC.state !== 'running') AC.resume().catch(() => {}); };
      }
      AC.resume();
    } catch (e) { /* no audio is fine */ }
  }

  // Engine note: two detuned saws + a sub-octave square through a lowpass,
  // plus a bandpassed noise bed for intake/road texture.
  function engineStart() {
    try {
      ensure();
      if (!AC || eng) return;
      const o1 = AC.createOscillator(); o1.type = 'sawtooth';
      const o2 = AC.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 11;
      const o3 = AC.createOscillator(); o3.type = 'square';
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.2;
      const gain = AC.createGain(); gain.gain.value = 0;
      o1.connect(lp); o2.connect(lp); o3.connect(lp); lp.connect(gain); gain.connect(AC.destination);
      const nb = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const ns = AC.createBufferSource(); ns.buffer = nb; ns.loop = true;
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
      const noiseGain = AC.createGain(); noiseGain.gain.value = 0;
      ns.connect(bp); bp.connect(noiseGain); noiseGain.connect(AC.destination);
      // tyre-screech voice: the SAME looping noise through a tight high band, gated by
      // a gain we ride from the drift amount — silent until the tail steps out.
      const sbp = AC.createBiquadFilter(); sbp.type = 'bandpass'; sbp.frequency.value = 1550; sbp.Q.value = 5.5;
      const screechGain = AC.createGain(); screechGain.gain.value = 0;
      ns.connect(sbp); sbp.connect(screechGain); screechGain.connect(AC.destination);
      o1.start(); o2.start(); o3.start(); ns.start();
      eng = { o1, o2, o3, ns, lp, gain, noiseGain, screechGain, lastThrottle: 0 };
    } catch (e) { eng = null; }
  }

  function engineUpdate(speed, maxSpeed, throttle) {
    if (!eng) return;
    const th = throttle || 0;
    const r = Math.min(1, Math.abs(speed) / (maxSpeed || 1));
    const rr = Math.pow(r, 0.6);            // perceptual: keeps revving across the whole range
    const gear = (rr * 5) % 1;              // pitch climbs within a "gear", drops on the shift
    const f = (56 + rr * 150 + gear * 34) * (1 + th * 0.05);   // load lifts the note a touch
    eng.o1.frequency.value = f;
    eng.o2.frequency.value = f;
    eng.o3.frequency.value = f / 2;
    eng.lp.frequency.value = 300 + rr * 1500 + th * 600;       // open the filter under throttle (brighter pull)
    eng.gain.gain.value = 0.012 + rr * 0.06 + th * 0.014;      // a touch louder on the gas
    eng.noiseGain.gain.value = rr * 0.035 + th * 0.02;         // intake roar when flooring it
    if (th > 0.5 && eng.lastThrottle <= 0.5) sfxWhoosh(0.5);   // audible "tip-in" when you stab the gas
    eng.lastThrottle = th;
  }

  // ride the tyre-screech gain from a 0..1 slip amount (called each frame while drifting)
  function screech(level) {
    if (!eng || !AC) return;
    try { eng.screechGain.gain.setTargetAtTime(Math.min(0.09, (level || 0) * 0.09), AC.currentTime, 0.04); } catch (e) { }
  }

  // a short filtered-noise swell — tip-in / near-miss "whoosh"
  function sfxWhoosh(v) {
    try {
      if (!AC) return; const t = AC.currentTime, vol = 0.03 + (v || 0.5) * 0.06;
      const nb = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.34), AC.sampleRate), d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const ns = AC.createBufferSource(); ns.buffer = nb;
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(380, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 0.28);
      const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.08); g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      ns.connect(bp); bp.connect(g); g.connect(AC.destination); ns.start(); ns.stop(t + 0.36);
    } catch (e) { }
  }

  function engineStop() {
    try {
      if (eng) { eng.o1.stop(); eng.o2.stop(); eng.o3.stop(); eng.ns.stop(); }
    } catch (e) { /* already stopped */ }
    eng = null;
  }

  function blip() {
    try {
      if (!AC) return;
      const o = AC.createOscillator(), g = AC.createGain();
      o.frequency.value = 740; o.type = 'sine';
      g.gain.setValueAtTime(0.12, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.18);
      o.frequency.exponentialRampToValueAtTime(1500, AC.currentTime + 0.15);
      o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + 0.2);
    } catch (e) { }
  }

  function sfxScoop() {
    try {
      if (!AC) return;
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(240, AC.currentTime);
      o.frequency.exponentialRampToValueAtTime(90, AC.currentTime + 0.09);
      g.gain.setValueAtTime(0.14, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.12);
      o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + 0.13);
    } catch (e) { }
  }

  // collision "thunk": a low sine drop + a short band-passed noise crunch, volume v∈0..1
  function sfxThunk(v) {
    try {
      if (!AC) return;
      const t = AC.currentTime, vol = 0.05 + (v || 0.5) * 0.22;
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.18);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g); g.connect(AC.destination); o.start(); o.stop(t + 0.24);
      const nb = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.16), AC.sampleRate), d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const ns = AC.createBufferSource(); ns.buffer = nb;
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.7;
      const ng = AC.createGain(); ng.gain.setValueAtTime(vol * 0.7, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      ns.connect(bp); bp.connect(ng); ng.connect(AC.destination); ns.start(); ns.stop(t + 0.18);
    } catch (e) { }
  }
  // two stacked squares — a friendly car horn
  function horn() {
    try {
      if (!AC) return; const t = AC.currentTime;
      for (const fr of [440, 554]) {
        const o = AC.createOscillator(), g = AC.createGain();
        o.type = 'square'; o.frequency.value = fr;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 0.02);
        g.gain.setValueAtTime(0.045, t + 0.3); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        o.connect(g); g.connect(AC.destination); o.start(); o.stop(t + 0.42);
      }
    } catch (e) { }
  }

  function sfxChime(notes) {
    try {
      if (!AC) return;
      notes.forEach((f, i) => {
        const o = AC.createOscillator(), g = AC.createGain();
        o.frequency.value = f; o.type = 'sine';
        const t0 = AC.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
        o.connect(g); g.connect(AC.destination); o.start(t0); o.stop(t0 + 0.25);
      });
    } catch (e) { }
  }

  // ---- looping procedural arcade soundtrack (the joyride tune) ----
  // A simple synthwave groove: a I–V–vi–IV loop with a bouncing bass, chord stabs, a
  // square-wave arp and a noise-drum bus, scheduled ahead of time off AC.currentTime so
  // it stays tight. The master filter opens with speed so the music lifts on the blast.
  let music = null;
  function startMusic() {
    try {
      ensure();
      if (!AC || music) return;
      const out = AC.createGain(); out.gain.value = 0; out.connect(AC.destination);
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.5; lp.connect(out);
      music = { out, lp, step: 0, timer: 0, nextT: AC.currentTime + 0.12 };
      out.gain.linearRampToValueAtTime(0.15, AC.currentTime + 1.4);   // gentle fade-in
      const bpm = 112, sp8 = (60 / bpm) / 2;            // 8th-note grid
      const chords = [[220.0, 261.6, 329.6], [164.8, 207.7, 246.9], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];  // Am E F G
      const bassRoot = [110.0, 82.4, 87.3, 98.0];
      const tone = (type, f, t, dur, g, dest) => {
        const o = AC.createOscillator(), gg = AC.createGain();
        o.type = type; o.frequency.value = f;
        gg.gain.setValueAtTime(0.0001, t); gg.gain.linearRampToValueAtTime(g, t + 0.012);
        gg.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(gg); gg.connect(dest || music.lp); o.start(t); o.stop(t + dur + 0.03);
      };
      const kick = t => {
        const o = AC.createOscillator(), gg = AC.createGain();
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
        gg.gain.setValueAtTime(0.5, t); gg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        o.connect(gg); gg.connect(music.out); o.start(t); o.stop(t + 0.16);
      };
      const hat = t => {
        const nb = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.03), AC.sampleRate), d = nb.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const ns = AC.createBufferSource(); ns.buffer = nb;
        const hp = AC.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
        const hg = AC.createGain(); hg.gain.value = 0.06;
        ns.connect(hp); hp.connect(hg); hg.connect(music.out); ns.start(t); ns.stop(t + 0.03);
      };
      const sched = () => {
        if (!music) return;
        const ahead = AC.currentTime + 0.14;
        while (music.nextT < ahead) {
          const t = music.nextT, s = music.step, bar = Math.floor(s / 8) % 4, beat = s % 8, ch = chords[bar];
          tone('sawtooth', bassRoot[bar] * (beat % 4 === 2 ? 1.5 : 1), t, 0.2, 0.11);     // bouncing bass
          if (beat === 0 || beat === 4) ch.forEach(f => tone('triangle', f, t, 0.36, 0.045));  // chord stab
          tone('square', ch[s % 3] * 2, t, 0.11, 0.028);                                  // arp
          if (beat === 0 || beat === 4) kick(t);
          if (beat % 2 === 1) hat(t);
          music.step++; music.nextT += sp8;
        }
      };
      music.timer = setInterval(sched, 30);
      sched();
    } catch (e) { music = null; }
  }
  function stopMusic() {
    try {
      if (!music) return;
      clearInterval(music.timer);
      const m = music; music = null;
      try { m.out.gain.cancelScheduledValues(AC.currentTime); m.out.gain.setTargetAtTime(0.0001, AC.currentTime, 0.12); } catch (e) { }
      setTimeout(() => { try { m.out.disconnect(); } catch (e) { } }, 500);
    } catch (e) { music = null; }
  }
  function setMusic(on) { if (on) startMusic(); else stopMusic(); return !!music; }
  function musicOn() { return !!music; }
  function musicSpeed(frac) { if (music && music.lp) { try { music.lp.frequency.setTargetAtTime(1100 + clamp01(frac) * 2800, AC.currentTime, 0.25); } catch (e) { } } }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  return { ensure, engineStart, engineUpdate, engineStop, screech, sfxWhoosh, blip, sfxScoop, sfxChime, sfxThunk, horn, startMusic, stopMusic, setMusic, musicOn, musicSpeed };
}
