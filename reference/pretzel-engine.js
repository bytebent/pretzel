/*
 * Pretzel engine v0.1 · bytebent
 *
 * A synth that bends a wave on both axes: phase distortion bends time, waveshaping bends level.
 * Batch 02 (see plan.md): one line with the CZ-style warp.
 *
 *   - Every wave reads one unipolar cosine, c(u) = (1 − cos 2πu)/2, at a warped phase u = g(φ),
 *     and is then centred. Warp 0 puts the pivot at the middle of the cycle: a pure cosine.
 *   - The CZ waves and windows (hidden ones included), and window on any wave, follow MAME's
 *     µPD933 emulation:
 *
 *         Wave and window formulas ported from MAME src/devices/sound/upd933.cpp
 *         license:BSD-3-Clause, copyright-holders: Devin Acker
 *         Redistribution and use in source and binary forms, with or without modification, are
 *         permitted provided that the conditions of the BSD 3-Clause License are met: the above
 *         copyright notice, this list of conditions and the disclaimer are retained, and the names
 *         of the copyright holders are not used to endorse or promote products derived from it.
 *         THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 *   - Wave pairs alternate two waves on successive cycles, as on the CZ.
 *   - Warp amount has Pretzel's own curve (not the CZ's 0–99 table): the pivot halves every 1/7
 *     of the knob, so brightness grows evenly. It is capped by pitch as the chip does, so the
 *     first segment never gets shorter than 4 internal samples.
 *   - 8-stage envelopes (time and level per stage, sustain point, end point) for Warp and Amp.
 *     Amp gain is the envelope level squared (0.5 is −12 dB).
 *   - Levels are evened out: every block the voice measures the RMS of its wave at the current
 *     Warp and divides by it to the power 0.7, as in Throat, so a narrow pulse or a window does not
 *     drop the level by up to 16 dB.
 *
 * Everything runs at 4x the host rate in fixed 32-sample blocks, then is decimated with a
 * 128-tap windowed-sinc FIR, as in Throat and Syrinx. process() never allocates. Same seed and
 * notes: same output, at any host buffer size.
 *
 * Works in an AudioWorklet and in Node (module.exports) for offline tests.
 */
(function (root) {
  'use strict';

  const OS = 4;                 // internal oversampling
  const BLOCK = 32;             // fixed internal block (host samples) = latency
  const FIR_LEN = 128;          // decimation filter taps (at 4x rate)
  const MAX_VOICES = 8;         // Poly voices (to be confirmed by the Mac benchmark, batch 05)
  const TWO_PI = 2 * Math.PI;
  const LEVEL = 0.35;           // one voice at full amp envelope
  const PIVOT_OCT = 7;          // Warp 1 puts the pivot 7 octaves below the middle (1/256 of a cycle)
  const PIVOT_MIN_SAMPLES = 4;  // the chip's pitch cap: first segment at least this many internal samples
  const RESO_MAX = 17;          // resonance ratio at Warp 1 (the chip reaches about 17)
  const RESO_NYQ = 0.45;        // resonance formant kept below this share of the host rate
  const LEVEL_POW = 0.7;        // loudness evened by the wave's RMS to this power, as in Throat
  const LEVEL_MAX = 4;          // at most +12 dB of evening out
  const LEVEL_PTS = 16;         // points per piece of the cycle used to measure the wave's level
  const LEVEL_PEAK = 4;         // evening out never pushes a wave's peak past this (a cosine's is 1)
  const DC_HZ = 5;              // per-line DC blocker
  const COS_N = 4096;           // cosine table size

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /* ---------- the carrier ---------- */
  // unipolar cosine c(u) = (1 − cos 2πu)/2 over one cycle, read with linear interpolation
  const COS = new Float64Array(COS_N + 1);
  for (let i = 0; i <= COS_N; i++) COS[i] = (1 - Math.cos(TWO_PI * i / COS_N)) / 2;
  function carrier(u) {
    const x = u * COS_N, i = Math.floor(x), f = x - i;
    const j = i < 0 ? 0 : i >= COS_N ? COS_N - 1 : i;
    return COS[j] + (COS[j + 1] - COS[j]) * f;
  }

  /* ---------- the CZ waves and windows (from MAME upd933.cpp, BSD-3-Clause) ---------- */
  const WAVES = ['Saw', 'Square', 'Pulse', 'Double sine', 'Saw-pulse', 'Resonance', 'Double pulse'];
  const WINDOWS = ['None', 'Saw', 'Triangle', 'Trapezoid', 'Pulse', 'Double saw'];

  // warped phase u (0–1) for wave w at phase φ (0–1), pivot p (0 < p ≤ 0.5) and resonance ratio k
  function warpU(w, ph, p, k) {
    switch (w) {
      case 0:   // saw: rises over [0, p), falls over [p, 1)
        return ph < p ? 0.5 * ph / p : 0.5 + 0.5 * (ph - p) / (1 - p);
      case 1: { // square: each half rises over [0, p), then holds; the second half is offset by 0.5
        const half = ph < 0.5 ? 0 : 0.5, h = ph - half;
        return half + (h < p ? 0.5 * h / p : 0.5);
      }
      case 2:   // pulse: one full cosine over [0, 2p), then holds at the bottom
        return ph < 2 * p ? ph / (2 * p) : 1;
      case 3:   // double sine: a full cosine over [0, p), another over [p, 1)
        return ph < p ? ph / p : (ph - p) / (1 - p);
      case 4:   // saw-pulse: rises over [0, 0.5), falls over [0.5, 0.5 + p), then holds at the bottom
        return ph < 0.5 ? ph : ph < 0.5 + p ? 0.5 + 0.5 * (ph - 0.5) / p : 1;
      case 5: { // resonance: k times the frequency, hard-synced to the cycle
        const u = k * ph;
        return u - Math.floor(u);
      }
      case 6: { // double pulse (hidden): each half rises over [0, p), then holds at the bottom
        const h = ph < 0.5 ? ph : ph - 0.5;
        return h < p ? 0.5 * h / p : 1;
      }
    }
    return ph;
  }
  // window level (0–1) at phase φ
  function windowW(win, ph) {
    switch (win) {
      case 1: return 1 - ph;                                          // saw: falls
      case 2: return ph < 0.5 ? 2 * ph : 2 - 2 * ph;                  // triangle: rises, then falls
      case 3: return ph < 0.5 ? 1 : 2 - 2 * ph;                       // trapezoid: flat, then falls
      case 4: return ph < 0.5 ? 1 - 2 * ph : 0;                       // pulse (hidden): falls, then 0
      case 5: return ph < 0.5 ? 2 * ph : 2 * ph - 1;                  // double saw (hidden): rises twice
    }
    return 1;
  }
  // one sample of a wave, centred: −1 … +1 (a window adds DC, removed by the line's DC blocker)
  function waveSample(w, win, ph, p, k) {
    return 2 * carrier(warpU(w, ph, p, k)) * windowW(win, ph) - 1;
  }
  // Warp amount (0–1) → pivot, and → resonance ratio
  function pivotOf(a, cap) { return Math.max(0.5 * Math.pow(2, -PIVOT_OCT * a), cap); }
  function resoOf(a, kmax) { return Math.min(Math.pow(RESO_MAX, a), kmax); }

  // mean, RMS and peak (DC removed) of a line's wave over one cycle (both cycles of a wave pair).
  // The cycle is cut at the warp's breakpoints and each piece gets the same number of points, so
  // a narrow pulse is measured as well as a wide one.
  const lvl = { mean: 0, rms: 1, peak: 1 };
  const cuts = new Float64Array(8);
  function levelOf(w0, w1, win, p, k) {
    let nc = 0;
    for (const c of [0, p, 2 * p, 0.5, 0.5 + p, 1]) if (c <= 1) cuts[nc++] = c;
    cuts.subarray(0, nc).sort();
    let m = 0, s = 0, hi = -Infinity, lo = Infinity;
    const n = w1 === w0 ? 1 : 2;
    for (let c = 0; c < n; c++) {
      const w = c ? w1 : w0;
      for (let j = 1; j < nc; j++) {
        const a = cuts[j - 1], len = cuts[j] - a;
        if (len <= 0) continue;
        for (let i = 0; i < LEVEL_PTS; i++) {
          const x = waveSample(w, win, a + len * (i + 0.5) / LEVEL_PTS, p, k);
          m += x * len; s += x * x * len;
          if (x > hi) hi = x; if (x < lo) lo = x;
        }
      }
    }
    m /= n * LEVEL_PTS; s /= n * LEVEL_PTS;
    lvl.mean = m; lvl.rms = Math.sqrt(Math.max(s - m * m, 1e-12)); lvl.peak = Math.max(hi - m, m - lo, 1e-6);
    return lvl;
  }
  // evening-out gain: RMS to the power 0.7, never more than +12 dB, and never pushing the peak
  // past LEVEL_PEAK (a narrow pulse is spiky: matching its RMS would make it clip)
  function levelGain(l) { return clamp(Math.min(Math.pow(Math.SQRT1_2 / l.rms, LEVEL_POW), LEVEL_PEAK / l.peak), 1 / LEVEL_MAX, LEVEL_MAX); }

  const core = { levelOf, levelGain, WAVES, WINDOWS, warpU, windowW, waveSample, carrier, pivotOf, resoOf, PIVOT_OCT, RESO_MAX };

  /* ---------- parameters ---------- */
  // ids, defaults and ranges: the one table the C++ core and the UI copy.
  // log: the knob moves logarithmically; curve: knob position^curve; step: whole steps.
  const ENV_DEFAULTS = {
    aenv: { t: [0.005, 0.5, 0.3], l: [1, 0.7, 0], sus: 2, end: 3 },
    wenv: { t: [0.02, 0.8, 0.4], l: [0.8, 0.4, 0], sus: 2, end: 3 },
  };
  function envParams(name, line) {
    const d = ENV_DEFAULTS[name], out = [];
    for (let s = 1; s <= 8; s++) {
      out.push({ id: name + line + 't' + s, def: s <= d.t.length ? d.t[s - 1] : 0.1, min: 0, max: 10, curve: 3 });
      out.push({ id: name + line + 'l' + s, def: s <= d.l.length ? d.l[s - 1] : 0, min: 0, max: 1 });
    }
    out.push({ id: name + line + 'sus', def: d.sus, min: 0, max: 8, step: 1 });   // 0: no sustain
    out.push({ id: name + line + 'end', def: d.end, min: 1, max: 8, step: 1 });
    return out;
  }
  const PARAMS = [
    // voice
    { id: 'mode', def: 1, min: 0, max: 1, step: 1 },             // 0 mono, 1 poly (8 voices)
    { id: 'glide', def: 0, min: 0, max: 2, curve: 3 },           // s, mono only
    // line 1
    { id: 'wave1', def: 0, min: 0, max: 6, step: 1 },            // WAVES
    { id: 'pair1', def: 0, min: 0, max: 7, step: 1 },            // 0 none, else WAVES[n − 1] on odd cycles
    { id: 'window1', def: 0, min: 0, max: 5, step: 1 },          // WINDOWS, on any wave
    { id: 'warp1', def: 0, min: 0, max: 1 },                     // warp amount before the envelope
    { id: 'warpkey1', def: 0.3, min: 0, max: 1 },                // key follow: less warp above middle C
    { id: 'wenvdepth1', def: 1, min: -1, max: 1 },
    { id: 'velwarp1', def: 0.3, min: 0, max: 1 },
    { id: 'velamp1', def: 0.7, min: 0, max: 1 },
    ...envParams('wenv', 1),
    ...envParams('aenv', 1),
    // pitch and output
    { id: 'transpose', def: 0, min: -24, max: 24, step: 1 },
    { id: 'bendrange', def: 2, min: 2, max: 24, step: 1 },
    { id: 'volume', def: -6, min: -48, max: 6 },                 // dB
  ];
  const PINDEX = {};
  PARAMS.forEach((p, i) => { PINDEX[p.id] = i; });

  // normalised 0–1 knob position ↔ value, for the bench and the plugin
  function toNorm(d, v) {
    if (d.log) return Math.log(v / d.min) / Math.log(d.max / d.min);
    const x = (v - d.min) / (d.max - d.min);
    return d.curve ? Math.pow(clamp(x, 0, 1), 1 / d.curve) : x;
  }
  function fromNorm(d, n) {
    n = clamp(n, 0, 1);
    if (d.log) return d.min * Math.pow(d.max / d.min, n);
    return d.min + (d.max - d.min) * (d.curve ? Math.pow(n, d.curve) : n);
  }

  function makeFir() {
    const h = new Float32Array(FIR_LEN);
    const fc = 0.5 / OS * 0.92, M = (FIR_LEN - 1) / 2;
    let sum = 0;
    for (let n = 0; n < FIR_LEN; n++) {
      const x = n - M;
      const s = x === 0 ? 2 * fc : Math.sin(TWO_PI * fc * x) / (Math.PI * x);
      const a = TWO_PI * n / (FIR_LEN - 1);
      const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
      h[n] = s * w; sum += h[n];
    }
    for (let n = 0; n < FIR_LEN; n++) h[n] /= sum;
    return h;
  }

  /* ---------- 8-stage envelope ---------- */
  // Each stage travels in a straight line from where the envelope is to the stage's level, in the
  // stage's time. It holds at the sustain stage while the key is down; a release jumps to the
  // stage after the sustain point. At the end stage it stops and holds that level.
  class Env {
    constructor(eng, name) {
      this.eng = eng; this.base = PINDEX[name + 't1'];
      this.v = 0; this.stage = 0; this.inc = 0; this.left = 0; this.target = 0;
      this.hold = false; this.done = true; this.held = false;
    }
    sus() { return Math.round(this.eng.p[this.base + 16]); }
    end() { return Math.round(this.eng.p[this.base + 17]); }
    seg() {
      const p = this.eng.p, t = p[this.base + this.stage * 2], n = Math.max(1, Math.round(t * this.eng.srOS));
      this.target = p[this.base + this.stage * 2 + 1];
      this.inc = (this.target - this.v) / n; this.left = n; this.hold = false;
    }
    trigger() { this.stage = 0; this.done = false; this.held = true; this.seg(); }
    release() {
      this.held = false;
      if (this.done) return;
      const sus = Math.min(this.sus(), this.end());
      if (sus > 0 && this.stage < sus) {
        if (sus >= this.end()) { this.fade(0.01); return; }   // sustain is the end: fade out
        this.stage = sus; this.seg();
      } else if (this.hold) { this.stage++; this.seg(); }
    }
    fade(t) {     // a short straight line to 0, then done
      this.stage = this.end() - 1; this.done = false; this.hold = false;
      const n = Math.max(1, Math.round(t * this.eng.srOS));
      this.target = 0; this.inc = -this.v / n; this.left = n;
    }
    next() {
      if (this.done || this.hold) return this.v;
      this.v += this.inc;
      if (--this.left <= 0) {
        this.v = this.target;
        const s = this.stage + 1;                   // the stage just reached, 1-based
        if (s >= this.end()) this.done = true;
        else if (s === this.sus() && this.held) this.hold = true;
        else { this.stage = s; this.seg(); }
      }
      return this.v;
    }
  }

  /* ---------- one voice: one line for now ---------- */
  class Voice {
    constructor(eng) {
      this.eng = eng;
      this.note = -1; this.held = false; this.active = false; this.age = 0;
      this.vel = 1; this.oct = 0; this.targetOct = 0; this.glideStep = 0;
      this.ph = 0; this.odd = 0;
      this.wenv = new Env(eng, 'wenv1'); this.aenv = new Env(eng, 'aenv1');
      this.dcx = 0; this.dcy = 0; this.gain = 1;
    }
    // glide: a straight line in pitch that arrives in the Glide time, whatever the interval
    setTarget(note, glide) {
      this.note = note;
      this.targetOct = (note - 69) / 12;
      const g = this.eng.p[PINDEX.glide];
      if (!glide || g <= 0) { this.oct = this.targetOct; this.glideStep = 0; }
      else this.glideStep = Math.abs(this.targetOct - this.oct) / (g * this.eng.srOS);
    }
    trigger(vel) {
      const wasActive = this.active;
      this.vel = clamp(vel / 127, 0, 1);
      this.active = true; this.held = true; this.age = ++this.eng.ageCounter;
      if (!wasActive) { this.ph = 0; this.odd = 0; this.aenv.v = 0; this.wenv.v = 0; }
      this.wenv.trigger(); this.aenv.trigger();
      if (!wasActive) this.primeDc();
    }
    release() {
      if (!this.held) return;
      this.held = false;
      this.wenv.release(); this.aenv.release();
      if (this.aenv.done && this.aenv.v > 0) this.aenv.fade(0.01);
    }
    // start the DC blocker at the wave's mean, so a windowed wave does not thump at note on,
    // and the level at the wave's own
    primeDc() {
      const P = this.eng.p, w0 = Math.round(P[PINDEX.wave1]), pr = Math.round(P[PINDEX.pair1]);
      const s = this.shapeNow(0), l = levelOf(w0, pr > 0 ? pr - 1 : w0, Math.round(P[PINDEX.window1]), s.p, s.k);
      this.dcx = l.mean; this.dcy = 0; this.gain = levelGain(l);
    }
    // pivot and resonance ratio for a Warp envelope value
    shapeNow(we) {
      const e = this.eng, P = e.p;
      const hz = 440 * Math.pow(2, this.oct + e.pitchOct);
      const note = 69 + 12 * this.oct;
      const key = Math.min(1, Math.pow(2, -P[PINDEX.warpkey1] * (note - 60) / 12));
      const vw = 1 - P[PINDEX.velwarp1] * (1 - this.vel);
      const a = clamp(P[PINDEX.warp1] + P[PINDEX.wenvdepth1] * we, 0, 1) * vw * key;
      const cap = Math.min(0.5, PIVOT_MIN_SAMPLES * hz / e.srOS);
      const kmax = Math.max(1, RESO_NYQ * e.sr / hz);
      return { p: pivotOf(a, cap), k: resoOf(a, kmax), hz };
    }
    render(n, out) {
      const e = this.eng, P = e.p;
      // glide (mono): pitch moves toward the target, per block
      const dOct = this.targetOct - this.oct, step = this.glideStep * n;
      this.oct = step > 0 && Math.abs(dOct) > step ? this.oct + Math.sign(dOct) * step : this.targetOct;
      const hz = 440 * Math.pow(2, this.oct + e.pitchOct), inc = hz / e.srOS;
      const note = 69 + 12 * this.oct;
      const key = Math.min(1, Math.pow(2, -P[PINDEX.warpkey1] * (note - 60) / 12));
      const vw = (1 - P[PINDEX.velwarp1] * (1 - this.vel)) * key;
      const va = (1 - P[PINDEX.velamp1] * (1 - this.vel)) * LEVEL;
      const base = P[PINDEX.warp1], depth = P[PINDEX.wenvdepth1];
      const cap = Math.min(0.5, PIVOT_MIN_SAMPLES * hz / e.srOS), lnCap = Math.log2(cap / 0.5);
      const kmaxLn = Math.log(Math.max(1, RESO_NYQ * e.sr / hz)), lnReso = Math.log(RESO_MAX);
      const w0 = Math.round(P[PINDEX.wave1]), pr = Math.round(P[PINDEX.pair1]);
      const w1 = pr > 0 ? pr - 1 : w0, win = Math.round(P[PINDEX.window1]);
      const R = e.dcR;
      // level: measured at the Warp the block starts with, moved to across the block
      const a0 = clamp(base + depth * this.wenv.v, 0, 1) * vw;
      const g1 = levelGain(levelOf(w0, w1, win, 0.5 * Math.pow(2, Math.max(-PIVOT_OCT * a0, lnCap)), Math.exp(Math.min(a0 * lnReso, kmaxLn))));
      let g = this.gain;
      const dg = (g1 - g) / n;
      let ph = this.ph, odd = this.odd, dcx = this.dcx, dcy = this.dcy;
      const wenv = this.wenv, aenv = this.aenv;
      for (let i = 0; i < n; i++) {
        const we = wenv.next(), ae = aenv.next();
        const a = clamp(base + depth * we, 0, 1) * vw;
        const p = 0.5 * Math.pow(2, Math.max(-PIVOT_OCT * a, lnCap));
        const k = Math.exp(Math.min(a * lnReso, kmaxLn));
        const x = 2 * carrier(warpU(odd ? w1 : w0, ph, p, k)) * windowW(win, ph) - 1;
        const y = x - dcx + R * dcy; dcx = x; dcy = y;
        g += dg;
        out[i] += y * ae * ae * g * va;
        ph += inc;
        if (ph >= 1) { ph -= 1; odd ^= 1; }
      }
      this.gain = g1;
      this.ph = ph; this.odd = odd; this.dcx = dcx; this.dcy = Math.abs(dcy) < 1e-20 ? 0 : dcy;
      if (aenv.done && (!this.held || aenv.v === 0)) { this.active = false; this.held = false; }
    }
  }

  /* ---------- the engine ---------- */
  class PretzelEngine {
    constructor(sampleRate, seed) {
      this.sr = sampleRate; this.srOS = sampleRate * OS;
      this.seed = (seed >>> 0) || 0x9e3779b9;   // used from batch 09 (Noise, random LFO)
      this.p = new Float64Array(PARAMS.length);
      PARAMS.forEach((d, i) => { this.p[i] = d.def; });
      this.fir = makeFir();
      this.hist = new Float32Array(FIR_LEN * 2); this.hw = 0;
      this.os = new Float32Array(BLOCK * OS);
      this.blkL = new Float32Array(BLOCK); this.blkR = new Float32Array(BLOCK); this.blkPos = BLOCK;
      this.ageCounter = 0; this.quietBlocks = 0;
      this.stack = [];
      this.bendNorm = 0; this.pitchOct = 0;
      this.dcR = 1 - TWO_PI * DC_HZ / this.srOS;
      this.dc = { x: 0, y: 0, R: 1 - TWO_PI * 10 / sampleRate };
      this.volSm = Math.pow(10, PARAMS[PINDEX.volume].def / 20);
      this.smooth = 1 - Math.exp(-BLOCK / (0.02 * sampleRate));
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(this));
      this.info = { voices: 0, idle: true };
    }

    static get LATENCY() { return BLOCK; }
    static get PARAMS() { return PARAMS; }

    setParam(id, v) {
      const i = PINDEX[id];
      if (i === undefined || !Number.isFinite(v)) return;
      const d = PARAMS[i];
      this.p[i] = clamp(d.step ? Math.round(v / d.step) * d.step : v, d.min, d.max);
      if (id === 'mode') this.allNotesOff();
    }
    getParam(id) { return this.p[PINDEX[id]]; }
    setBend(norm) { this.bendNorm = clamp(norm, -1, 1); }

    noteOn(note, vel) {
      if (vel <= 0) { this.noteOff(note); return; }
      if (this.p[PINDEX.mode] === 0) {
        const v = this.voices[0];
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        this.stack.push(note);
        const legato = v.active && v.held;
        v.setTarget(note, legato && this.p[PINDEX.glide] > 0);
        if (!legato) { v.setTarget(note, false); v.trigger(vel); }
        return;
      }
      for (const v of this.voices) if (v.active && v.note === note) { v.setTarget(note, false); v.trigger(vel); return; }
      let pick = null;
      for (const v of this.voices) if (!v.active) { pick = v; break; }
      if (!pick) { for (const v of this.voices) if (!v.held && (!pick || v.age < pick.age)) pick = v; }
      if (!pick) { for (const v of this.voices) if (!pick || v.age < pick.age) pick = v; }
      pick.setTarget(note, false);
      pick.trigger(vel);
    }
    noteOff(note) {
      if (this.p[PINDEX.mode] === 0) {
        const i = this.stack.indexOf(note); if (i >= 0) this.stack.splice(i, 1);
        const v = this.voices[0];
        if (!v.active || v.note !== note) return;
        if (this.stack.length) v.setTarget(this.stack[this.stack.length - 1], this.p[PINDEX.glide] > 0);
        else v.release();
        return;
      }
      for (const v of this.voices) if (v.note === note && v.held) v.release();
    }
    allNotesOff() {
      this.stack.length = 0;
      for (const v of this.voices) v.release();
    }

    processBlock() {
      const d = this.dc;
      const busy = this.voices.some(v => v.active);
      if (!busy && this.quietBlocks > 0 && Math.abs(d.y) < 1e-12 && Math.abs(d.x) < 1e-12) {
        this.blkL.fill(0); this.blkR.fill(0); d.x = d.y = 0;
        this.info.voices = 0; this.info.idle = true;
        return;
      }
      this.pitchOct = this.p[PINDEX.transpose] / 12 + this.bendNorm * this.p[PINDEX.bendrange] / 12;
      this.volSm += (Math.pow(10, this.p[PINDEX.volume] / 20) - this.volSm) * this.smooth;
      const nOS = BLOCK * OS, o = this.os;
      o.fill(0);
      let count = 0;
      for (const v of this.voices) if (v.active) { v.render(nOS, o); count++; }
      this.quietBlocks = count === 0 ? this.quietBlocks + 1 : 0;
      this.info.voices = count; this.info.idle = false;
      // decimate (symmetric FIR), DC block, volume, clip; mono for now, same on both sides
      const L = FIR_LEN, H = FIR_LEN / 2, h = this.fir, hs = this.hist, vol = this.volSm;
      let hw = this.hw;
      for (let j = 0, k = 0; j < BLOCK; j++) {
        for (let q = 0; q < OS; q++, k++) { hs[hw] = hs[hw + L] = o[k]; hw = hw + 1 === L ? 0 : hw + 1; }
        let acc = 0;
        for (let t = 0, u = hw + L - 1; t < H; t++, u--) acc += h[t] * (hs[hw + t] + hs[u]);
        const y = acc - d.x + d.R * d.y; d.x = acc; d.y = y;
        const s = y * vol;
        this.blkL[j] = this.blkR[j] = s > 1 ? 1 : s < -1 ? -1 : s;
      }
      this.hw = hw;
      if (Math.abs(d.y) < 1e-20) d.y = 0;
    }

    // host calls with any n; work happens in fixed BLOCK chunks
    process(outL, outR, n) {
      let pos = this.blkPos;
      for (let j = 0; j < n; j++) {
        if (pos === BLOCK) { this.processBlock(); pos = 0; }
        outL[j] = this.blkL[pos];
        if (outR) outR[j] = this.blkR[pos];
        pos++;
      }
      this.blkPos = pos;
    }
  }

  PretzelEngine.BLOCK = BLOCK; PretzelEngine.OS = OS; PretzelEngine.MAX_VOICES = MAX_VOICES;
  PretzelEngine.toNorm = toNorm; PretzelEngine.fromNorm = fromNorm;
  if (typeof module !== 'undefined' && module.exports) module.exports = { PretzelEngine, PARAMS, core };
  else root.PretzelEngine = PretzelEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
