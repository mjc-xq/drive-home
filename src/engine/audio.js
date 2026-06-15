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
      o1.start(); o2.start(); o3.start(); ns.start();
      eng = { o1, o2, o3, ns, lp, gain, noiseGain };
    } catch (e) { eng = null; }
  }

  function engineUpdate(speed, maxSpeed) {
    if (!eng) return;
    const r = Math.min(1, Math.abs(speed) / (maxSpeed || 1));
    const rr = Math.pow(r, 0.6);            // perceptual: keeps revving across the whole range
    const gear = (rr * 5) % 1;              // pitch climbs within a "gear", drops on the shift
    const f = 56 + rr * 150 + gear * 34;
    eng.o1.frequency.value = f;
    eng.o2.frequency.value = f;
    eng.o3.frequency.value = f / 2;
    eng.lp.frequency.value = 300 + rr * 1500;
    eng.gain.gain.value = 0.012 + rr * 0.06;
    eng.noiseGain.gain.value = rr * 0.035;
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

  return { ensure, engineStart, engineUpdate, engineStop, blip, sfxScoop, sfxChime, sfxThunk, horn };
}
