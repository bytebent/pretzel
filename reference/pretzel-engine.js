/*
 * Pretzel engine v0.2 · bytebent
 *
 * A synth that bends a wave on both axes: phase distortion bends time, waveshaping bends level.
 * Batches 02–03 (see plan.md): one line, with the CZ-style warp (Warp = phase distortion) and the
 * shaper after it.
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
 *   - The shaper (Shape 0 and Bias 0 pass the wave unchanged in every family):
 *       Chebyshev  Σ e_k·T_k(x), k = 1…16. Shape fades harmonic k in as Shape^(1 + (k−2)/4), so the
 *                  sound brightens toward the designed spectrum, and the fundamental moves from 1
 *                  to its slider; at Shape 1 the harmonics have exactly the sliders' ratios.
 *                  Tilt and Odd/Even scale all 16 at once.
 *       Fold       Triangle (reflect at ±1), Sine (sin(G·asin x), a sine of the wave's own phase),
 *                  Analog (four Lockhart stages in closed form with Lambert W; Esqueda, Pöntynen,
 *                  Parker & Bilbao 2017). Shape is the fold gain G = 10^Shape, 1 to 10.
 *       Saturate   tanh, arctan, cubic soft clip, f(d·x)/f(d) with drive d = 16·Shape².
 *       Drawn      up to four keyframe curves, morphed; Shape fades the curve in. Each curve keeps
 *                  its antiderivative for antialiasing (batch 04).
 *     Bias offsets the input (x + b)/(1 + |b|), for even harmonics. The Shape envelope, Link (the
 *     Warp envelope also driving Shape), key follow and velocity set Shape per sample.
 *   - Levels are evened out: every block the voice measures the RMS of its wave at the current
 *     Warp and Shape and divides by it to the power 0.7, as in Throat, so a narrow pulse, a window
 *     or a shaper does not move the level by up to 16 dB.
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
  const WARP_FMAX = 1 / 8;      // the chip's pitch cap, made the same for every wave: the steepest part of
                                // a wave never reads the cosine faster than 1/8 of the internal rate
                                // (24 kHz at 48 kHz; for the Saw, a first segment of at least 4 samples)
  const CHEB_LO = 0.3, CHEB_HI = 0.45;   // Chebyshev band limit: harmonic k fades out as k × the wave's
                                // fastest frequency goes from 0.3 to 0.45 of the internal rate
                                // (0.6–0.85 left 10 dB more aliasing: the steep part spreads widely)
  const ADAA_EPS = 1e-6;        // below this input step, ADAA takes the shaper at the midpoint
  const RESO_MAX = 17;          // resonance ratio at Warp 1 (the chip reaches about 17)
  const RESO_NYQ = 0.45;        // resonance formant kept below this share of the host rate
  const RESO_OS = 0.12;         // … and, after the shaper's steepening, below this share of the internal rate
                                // (0.35 let a folded formant alias at −12 dB at MIDI 96; 0.12 equals the host
                                // limit when nothing steepens it)
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
  // the warp's steepest slope, g′, is SLOPE[w]/p (Resonance: k; Saw-pulse at least 1)
  const SLOPE = [0.5, 0.5, 0.5, 1, 0.5, 0, 0.5];
  function maxSlope(w, p, k) { return w === 5 ? k : Math.max(SLOPE[w] / p, 1); }
  // Warp amount (0–1) → pivot, and → resonance ratio
  function pivotOf(a, cap) { return Math.max(0.5 * Math.pow(2, -PIVOT_OCT * a), cap); }
  function resoOf(a, kmax) { return Math.min(Math.pow(RESO_MAX, a), kmax); }

  /* ---------- the shaper ---------- */
  const SHAPERS = ['Chebyshev', 'Fold', 'Saturate', 'Drawn'];
  const FOLDS = ['Triangle', 'Sine', 'Analog'];
  const SATS = ['Tanh', 'Arctan', 'Cubic'];
  const NH = 16;                // Chebyshev harmonics
  const FOLD_MAX = 10;          // fold gain at Shape 1
  const SAT_MAX = 16;           // saturation drive at Shape 1 (d = 16·Shape²)
  const CURVE_N = 256;          // drawn curve table: CURVE_N + 1 points over −1 … 1
  const MAX_KEYS = 4;           // drawn keyframes

  // Lockhart wavefolder (Esqueda, Pöntynen, Parker & Bilbao 2017, eq. 28): R = 15 kΩ, RL = 7.5 kΩ,
  // Is = 1e−17 A, VT = 25.864 mV; four stages between a 1/3 pre-gain and a ×3 post-gain (their §6)
  const LK_VT = 0.025864, LK_A = 2 * 7500 / 15000, LK_B = (2 * 7500 + 15000) / (LK_VT * 15000);
  const LK_LND = Math.log(7500 * 1e-17 / LK_VT);
  // Lambert W (principal branch) of e^L, for any L
  function lambertWexp(L) {
    if (L < 1) {
      const z = Math.exp(L);
      let w = z < 0.3 ? z * (1 - z * (1 - 1.5 * z)) : 0.5 * L + 0.5;
      for (let i = 0; i < 4; i++) { const ew = Math.exp(w); w -= (w * ew - z) / (ew * (w + 1)); }
      return w;
    }
    let w = L - Math.log(L);
    for (let i = 0; i < 4; i++) w -= (w + Math.log(w) - L) * w / (1 + w);
    return w;
  }
  function lockhart(v) {
    if (v === 0) return 0;
    const l = v > 0 ? 1 : -1;
    return LK_A * v - l * LK_VT * lambertWexp(LK_LND + l * LK_B * v);
  }
  function analogFold(v) {
    let u = v / 3;
    for (let i = 0; i < 4; i++) u = lockhart(u);
    return 3 * u;
  }
  // the Analog folder as a table over −ANA_Z … ANA_Z, with its antiderivative: exact enough (checked in
  // the tests), much faster than four Lambert W per sample, and it gives ADAA its antiderivative
  const ANA_Z = 11, ANA_N = 1 << 14, ANA_H = 2 * ANA_Z / ANA_N;
  const ANA = new Float64Array(ANA_N + 1), ANA_F = new Float64Array(ANA_N + 1);
  for (let i = 0; i <= ANA_N; i++) ANA[i] = analogFold(-ANA_Z + i * ANA_H);
  for (let i = 1; i <= ANA_N; i++) ANA_F[i] = ANA_F[i - 1] + 0.5 * ANA_H * (ANA[i - 1] + ANA[i]);
  function anaAt(z) {
    const x = (clamp(z, -ANA_Z, ANA_Z) + ANA_Z) / ANA_H, i = Math.min(ANA_N - 1, Math.floor(x)), f = x - i;
    return ANA[i] + (ANA[i + 1] - ANA[i]) * f;
  }
  function anaF(z) {
    const x = (clamp(z, -ANA_Z, ANA_Z) + ANA_Z) / ANA_H, i = Math.min(ANA_N - 1, Math.floor(x)), f = x - i;
    return ANA_F[i] + ANA_H * f * (ANA[i] + 0.5 * (ANA[i + 1] - ANA[i]) * f);
  }
  const analogTab = { anaAt, anaF, ANA_Z };
  function triFold(v) {
    let t = (v + 1) * 0.25;
    t -= Math.floor(t);
    return 1 - 4 * Math.abs(t - 0.5);
  }
  // antiderivative of the triangle fold: periodic (period 4), piecewise quadratic
  function triFoldF(z) {
    let t = (z + 1) * 0.25;
    t = (t - Math.floor(t)) * 4 - 1;        // −1 … 3
    return t <= 1 ? 0.5 * t * t : 2 * t - 0.5 * t * t - 1;
  }
  // antiderivatives of the saturation curves (log cosh written so it cannot overflow)
  function satCurveF(t, u) {
    const a = Math.abs(u);
    switch (t) {
      // log cosh u: for small u as log1p(2·sinh²(u/2)), which keeps its precision near 0 (the other form
      // lost it there and a Shape envelope closing to 0 crackled at −58 dB); for large u without overflow
      case 0: { if (a < 20) { const h = Math.sinh(0.5 * a); return Math.log1p(2 * h * h); } return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; }
      case 1: return u * Math.atan(u) - 0.5 * Math.log1p(u * u);
      default: return a >= 1 ? (2 / 3) * a - 0.25 : 0.5 * u * u - u * u * u * u / 12;
    }
  }
  // tanh, arctan and cubic soft clip, each scaled so f(d·x)/f(d) has a peak of 1
  function satCurve(t, u) {
    switch (t) {
      case 0: return Math.tanh(u);
      case 1: return Math.atan(u);
      default: return u >= 1 ? 2 / 3 : u <= -1 ? -2 / 3 : u - u * u * u / 3;
    }
  }

  // drawn curves: a table of CURVE_N + 1 values over −1 … 1, and its antiderivative F1 (from −1),
  // exact for the straight lines between table points
  function curveTable(points, smooth) {
    const y = new Float64Array(CURVE_N + 1);
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    for (let i = 0; i <= CURVE_N; i++) {
      const x = -1 + 2 * i / CURVE_N;
      let j = 0;
      while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
      const [x1, y1] = pts[j], [x2, y2] = pts[Math.min(j + 1, pts.length - 1)];
      const f = x2 > x1 ? clamp((x - x1) / (x2 - x1), 0, 1) : 0;
      if (!smooth) { y[i] = y1 + (y2 - y1) * f; continue; }
      // Catmull-Rom through the points
      const y0 = j > 0 ? pts[j - 1][1] : 2 * y1 - y2, y3 = j + 2 < pts.length ? pts[j + 2][1] : 2 * y2 - y1;
      y[i] = clamp(y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0))), -1, 1);
    }
    return y;
  }
  function antiderivative(y) {
    const F = new Float64Array(CURVE_N + 1), h = 2 / CURVE_N;
    for (let i = 1; i <= CURVE_N; i++) F[i] = F[i - 1] + 0.5 * h * (y[i - 1] + y[i]);
    return F;
  }
  function tableAt(y, v) {
    const x = (clamp(v, -1, 1) + 1) * 0.5 * CURVE_N, i = Math.min(CURVE_N - 1, Math.floor(x)), f = x - i;
    return y[i] + (y[i + 1] - y[i]) * f;
  }
  function antiAt(y, F, v) {      // F1 at v (linear between table points, so quadratic inside one)
    const x = (clamp(v, -1, 1) + 1) * 0.5 * CURVE_N, i = Math.min(CURVE_N - 1, Math.floor(x)), f = x - i, h = 2 / CURVE_N;
    return F[i] + h * f * (y[i] + 0.5 * (y[i + 1] - y[i]) * f);
  }
  // the four default keyframes: soft S, terraces, a sine fold, a full-wave rectifier
  const DEFAULT_CURVES = [
    (v) => Math.sin(Math.PI * v / 2),
    (v) => v - Math.sin(4 * Math.PI * v) / (4 * Math.PI),
    (v) => Math.sin(1.5 * Math.PI * v),
    (v) => 2 * Math.abs(v) - 1,
  ].map((f) => { const y = new Float64Array(CURVE_N + 1); for (let i = 0; i <= CURVE_N; i++) y[i] = f(-1 + 2 * i / CURVE_N); return y; });

  // one line's shaper settings for a block. e: Chebyshev weights at Shape 1 (after Tilt, Odd/Even);
  // c: scratch for the weights at the current Shape; dy, dF: the morphed drawn curve and its F1.
  function makeShaper() {
    return {
      fam: 0, sub: 0, bias: 0, fpk: 0, dmax: 1, e: new Float64Array(NH + 1), c: new Float64Array(NH + 2), d: new Float64Array(NH + 3),
      dy: new Float64Array(CURVE_N + 1), dF: new Float64Array(CURVE_N + 1),
    };
  }
  // the shaped value of x (−1 … 1) at Shape s
  function shapeSample(sh, x, s) {
    const b = sh.bias;
    if (s === 0 && b === 0) return x;
    const v = b === 0 ? x : (x + b) / (1 + Math.abs(b));
    switch (sh.fam) {
      case 0: {                         // Chebyshev, by Clenshaw's recurrence
        const c = chebNow(sh, s);
        let b1 = 0, b2 = 0;
        for (let k = NH; k >= 1; k--) { const t = c[k] + 2 * v * b1 - b2; b2 = b1; b1 = t; }
        return v * b1 - b2;
      }
      case 1: {                         // Fold
        const g = Math.pow(FOLD_MAX, s);   // 1 → 10, evenly in log: 1.8 at Shape ¼, 3.2 at ½
        if (sh.sub === 0) return triFold(g * v);
        if (sh.sub === 1) return Math.sin(g * Math.asin(clamp(v, -1, 1)));
        // the Lockhart stages bend slightly even at gain 1; adding back that bend keeps Shape 0 exact
        return anaAt(g * v) - anaAt(v) + v;
      }
      case 2: {                         // Saturate
        const d = SAT_MAX * s * s;
        if (d < 1e-6) return v;
        return satCurve(sh.sub, d * v) / satCurve(sh.sub, d);
      }
      default:                          // Drawn: Shape fades the curve in
        return v + s * (tableAt(sh.dy, v) - v);
    }
  }
  // the Chebyshev weights at Shape s, into sh.c. Harmonic k comes in as Shape^(1 + (k−2)/4), like a
  // waveshaping index (harmonic 2 first and linearly, higher ones later); the fundamental moves in a
  // straight line from 1 to its slider. Every exponent is at least 1, so the weights add up to at
  // most 1. Band limit: harmonic k reads the warped cosine k times as fast, so its fastest frequency
  // is k × the wave's (sh.fpk, a share of the internal rate); it fades out between CHEB_LO and CHEB_HI.
  function chebNow(sh, s) {
    const e = sh.e, c = sh.c, r = Math.sqrt(Math.sqrt(s)), f = sh.fpk;
    let rk = s / r;
    for (let k = 2; k <= NH; k++) {
      rk *= r;
      const fk = k * f;
      c[k] = fk <= CHEB_LO ? e[k] * rk : fk >= CHEB_HI ? 0 : e[k] * rk * (CHEB_HI - fk) / (CHEB_HI - CHEB_LO);
    }
    c[1] = 1 - s + s * e[1];
    return c;
  }
  // antiderivative of Σ c_k·T_k as Chebyshev coefficients d_0 … d_(NH+1):
  // ∫T_1 = (T_0 + T_2)/4, ∫T_n = (T_(n+1)/(n+1) − T_(n−1)/(n−1))/2
  function chebAntiCoeffs(c, d) {
    d.fill(0);
    d[0] += c[1] / 4; d[2] += c[1] / 4;
    for (let n = 2; n <= NH; n++) { d[n + 1] += c[n] / (2 * (n + 1)); d[n - 1] -= c[n] / (2 * (n - 1)); }
    return d;
  }
  function clenshaw0(d, n, v) {        // Σ_(m = 0…n) d_m·T_m(v)
    let b1 = 0, b2 = 0;
    for (let m = n; m >= 1; m--) { const t = d[m] + 2 * v * b1 - b2; b2 = b1; b1 = t; }
    return d[0] + v * b1 - b2;
  }
  // the shaper's antiderivative F(v), in the shaper's own input v (after Bias), at Shape s. For
  // Chebyshev, chebAntiCoeffs must have filled sh.d for this s.
  function shapeAnti(sh, v, s) {
    switch (sh.fam) {
      case 0: return clenshaw0(sh.d, NH + 1, v);
      case 1: {
        const g = Math.pow(FOLD_MAX, s);
        if (sh.sub === 0) return triFoldF(g * v) / g;
        if (sh.sub === 1) {
          // ∫ sin(g·asin v) dv = −cos((g+1)θ)/(2(g+1)) − cos((g−1)θ)/(2(g−1)), θ = asin v; the second term
          // is written as sin²((g−1)θ/2)/(g−1) (same slope), which stays exact as g → 1
          const th = Math.asin(clamp(v, -1, 1)), ep = g - 1, sn = Math.sin(0.5 * ep * th);
          return -Math.cos((g + 1) * th) / (2 * (g + 1)) + (ep === 0 ? 0 : sn * sn / ep);
        }
        return anaF(g * v) / g - anaF(v) + 0.5 * v * v;
      }
      case 2: {
        const d = SAT_MAX * s * s;
        if (d < 1e-6) return 0.5 * v * v;
        return satCurveF(sh.sub, d * v) / (d * satCurve(sh.sub, d));
      }
      default: return 0.5 * (1 - s) * v * v + s * antiAt(sh.dy, sh.dF, v);
    }
  }
  // first-order antiderivative antialiasing (Parker, Zavalishin & Le Bivic 2016) between the last two
  // inputs x0 → x1: the shaper averaged over the straight line between them. Shape 0 and Bias 0 give
  // the plain average, the same half-sample delay as every shaper.
  function shapeADAA(sh, x0, x1, s) {
    const b = sh.bias;
    if (s === 0 && b === 0) return 0.5 * (x0 + x1);
    const k = b === 0 ? 1 : 1 / (1 + Math.abs(b));
    const v0 = (x0 + b) * k, v1 = (x1 + b) * k, dv = v1 - v0;
    if (Math.abs(dv) < ADAA_EPS) return shapeSample(sh, 0.5 * (x0 + x1), s);
    if (sh.fam === 0) chebAntiCoeffs(chebNow(sh, s), sh.d);
    return (shapeAnti(sh, v1, s) - shapeAnti(sh, v0, s)) / dv;
  }
  // how much the shaper steepens the wave at Shape s (its largest slope): a fold of gain g makes every
  // frequency g times higher, a saturator d/f(d) times near zero. The warp's pitch cap and the
  // resonance ratio are divided by it, so a wave going into a hard fold is never steeper than the
  // fold can take. Chebyshev has its own band limit (the harmonic fade) and counts as 1.
  function expansion(sh, s) {
    switch (sh.fam) {
      case 1: return Math.pow(FOLD_MAX, s);
      case 2: { const d = SAT_MAX * s * s; return d < 1e-6 ? 1 : d * (sh.sub === 2 ? 1.5 : 1 / satCurve(sh.sub, d)); }
      case 3: return Math.max(1, 1 - s + s * sh.dmax);
    }
    return 1;
  }
  // Residuals that turn a box-filtered jump or kink into a triangle-filtered one (second order, like
  // polyBLEP and polyBLAMP), for a breakpoint a share τ into the sample: on the sample before (m),
  // this sample (o) and the next (p). The box and the triangle are both centred half a sample back,
  // where ADAA puts its output.
  const res = { m: 0, o: 0, p: 0 };
  function phi2(u) { return u <= -1 ? 0 : u <= 0 ? 0.5 * (1 + u) * (1 + u) : u < 1 ? 1 - 0.5 * (1 - u) * (1 - u) : 1; }
  function q2(u) { return u <= -1 ? 0 : u <= 0 ? (1 + u) * (1 + u) * (1 + u) / 6 : u < 1 ? u + (1 - u) * (1 - u) * (1 - u) / 6 : u; }
  function residuals(t, J, S) {
    // jump J: box gives clamp(m − ts, 0, 1), triangle phi2(m − ½ − ts); ts = t − 1 for this sample
    // kink S (change of slope per sample): box gives the ramp's box average, triangle q2
    const a = 1 - t;
    res.m = J * phi2(-0.5 - t) + S * q2(-0.5 - t);
    res.o = J * (phi2(0.5 - t) - a) + S * (q2(0.5 - t) - 0.5 * a * a);
    res.p = J * (phi2(1.5 - t) - 1) + S * (q2(1.5 - t) - (1 + a - 0.5));
    return res;
  }
  // Chebyshev weights at Shape 1: h_k × k^Tilt, and Odd/Even (> 0 cuts even harmonics, < 0 cuts
  // odd ones above the fundamental). Scaled so they add up to 1: the output never passes ±1
  // (|T_k| ≤ 1), and the harmonics keep exactly the ratios of the sliders.
  function chebWeights(e, h, tilt, oe) {
    let sum = 0;
    for (let k = 1; k <= NH; k++) {
      let g = h[k - 1] * Math.pow(k, tilt);
      if (k % 2 === 0 && oe > 0) g *= 1 - oe;
      if (k % 2 === 1 && k > 1 && oe < 0) g *= 1 + oe;
      e[k] = g; sum += g;
    }
    if (sum < 1e-9) { e.fill(0); e[1] = 1; return; }
    for (let k = 1; k <= NH; k++) e[k] /= sum;
  }
  // the morphed drawn curve: Morph 0–1 runs through the keyframes in order. Linear morphing of the
  // curves and of their antiderivatives with the same weights gives the same result.
  function morphCurves(sh, keys, F, n, m) {
    const x = clamp(m, 0, 1) * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i;
    const a = keys[i], b = keys[i + 1], Fa = F[i], Fb = F[i + 1];
    let mx = 0;
    for (let j = 0; j <= CURVE_N; j++) {
      sh.dy[j] = a[j] + (b[j] - a[j]) * f; sh.dF[j] = Fa[j] + (Fb[j] - Fa[j]) * f;
      if (j) mx = Math.max(mx, Math.abs(sh.dy[j] - sh.dy[j - 1]));
    }
    sh.dmax = mx * CURVE_N / 2;
  }

  // mean, RMS and peak (DC removed) of a line's wave over one cycle (both cycles of a wave pair).
  // The cycle is cut at the warp's breakpoints and each piece gets the same number of points, so
  // a narrow pulse is measured as well as a wide one.
  const lvl = { mean: 0, rms: 1, peak: 1 };
  const cuts = new Float64Array(8);
  function levelOf(w0, w1, win, p, k, sh, sv) {
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
          let x = waveSample(w, win, a + len * (i + 0.5) / LEVEL_PTS, p, k);
          if (sh) x = shapeSample(sh, x, sv);
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

  const core = {
    levelOf, levelGain, WAVES, WINDOWS, warpU, windowW, waveSample, carrier, pivotOf, resoOf, PIVOT_OCT, RESO_MAX,
    maxSlope, SLOPE, WARP_FMAX, CHEB_LO, CHEB_HI, shapeADAA, shapeAnti, analogTab, expansion, residuals, phi2, q2,
    SHAPERS, FOLDS, SATS, NH, CURVE_N, makeShaper, shapeSample, chebWeights, morphCurves, curveTable, antiderivative,
    tableAt, antiAt, lockhart, analogFold, lambertWexp, DEFAULT_CURVES,
  };

  /* ---------- parameters ---------- */
  // ids, defaults and ranges: the one table the C++ core and the UI copy.
  // log: the knob moves logarithmically; curve: knob position^curve; step: whole steps.
  const ENV_DEFAULTS = {
    aenv: { t: [0.005, 0.5, 0.3], l: [1, 0.7, 0], sus: 2, end: 3 },
    wenv: { t: [0.02, 0.8, 0.4], l: [0.8, 0.4, 0], sus: 2, end: 3 },
    senv: { t: [0.02, 0.8, 0.4], l: [0.8, 0.4, 0], sus: 2, end: 3 },
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
    // shaper, line 1
    { id: 'sfamily1', def: 0, min: 0, max: 3, step: 1 },         // SHAPERS
    { id: 'shape1', def: 0, min: 0, max: 1 },                    // drive into the shaper, before the envelope
    { id: 'bias1', def: 0, min: -1, max: 1 },                    // input offset: even harmonics
    ...Array.from({ length: NH }, (_, i) => ({ id: 'h' + (i + 1) + '_1', def: i === 0 ? 1 : 0, min: 0, max: 1 })),   // Chebyshev harmonics
    { id: 'tilt1', def: 0, min: -1, max: 1 },                    // harmonic k × k^Tilt
    { id: 'oddeven1', def: 0, min: -1, max: 1 },                 // > 0 cuts even, < 0 cuts odd (above the fundamental)
    { id: 'fold1', def: 1, min: 0, max: 2, step: 1 },            // FOLDS
    { id: 'sat1', def: 0, min: 0, max: 2, step: 1 },             // SATS
    { id: 'keys1', def: 4, min: 2, max: MAX_KEYS, step: 1 },     // drawn keyframes in use
    { id: 'morph1', def: 0, min: 0, max: 1 },                    // through the drawn keyframes
    { id: 'shapekey1', def: 0.3, min: 0, max: 1 },               // key follow: less shape above middle C
    { id: 'senvdepth1', def: 0, min: -1, max: 1 },
    { id: 'link1', def: 0, min: -1, max: 1 },                    // the Warp envelope also drives Shape
    { id: 'velshape1', def: 0.3, min: 0, max: 1 },
    ...envParams('wenv', 1),
    ...envParams('senv', 1),
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
      this.wenv = new Env(eng, 'wenv1'); this.senv = new Env(eng, 'senv1'); this.aenv = new Env(eng, 'aenv1');
      this.sh = makeShaper();
      this.dcx = 0; this.dcy = 0; this.gain = 1;
      this.x1 = 0;               // the wave one sample back
      this.acc = 0; this.bps = new Float64Array(4);   // split samples: running sum, breakpoints
      this.q0 = 0; this.carry = 0;                     // the sample waiting for its residuals, and the next one's
      this.rm = 0; this.ro = 0; this.rp = 0;           // residuals of this sample's breakpoints
      this.wp = 0.5; this.wk = 1;                      // pivot and resonance ratio, from warpPoint()
      this.k = {};          // per-block settings, filled by settings()
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
      if (!wasActive) { this.ph = 0; this.odd = 0; this.aenv.v = 0; this.wenv.v = 0; this.senv.v = 0; }
      this.wenv.trigger(); this.senv.trigger(); this.aenv.trigger();
      if (!wasActive) this.primeDc();
    }
    release() {
      if (!this.held) return;
      this.held = false;
      this.wenv.release(); this.senv.release(); this.aenv.release();
      if (this.aenv.done && this.aenv.v > 0) this.aenv.fade(0.01);
    }
    // everything that is fixed for one block: pitch, waves, Warp and Shape scaling, the shaper
    settings() {
      const e = this.eng, P = e.p, k = this.k;
      const hz = 440 * Math.pow(2, this.oct + e.pitchOct), note = 69 + 12 * this.oct;
      k.hz = hz; k.inc = hz / e.srOS;
      const vl = 1 - this.vel;
      k.vw = (1 - P[PINDEX.velwarp1] * vl) * Math.min(1, Math.pow(2, -P[PINDEX.warpkey1] * (note - 60) / 12));
      k.vs = (1 - P[PINDEX.velshape1] * vl) * Math.min(1, Math.pow(2, -P[PINDEX.shapekey1] * (note - 60) / 12));
      k.va = (1 - P[PINDEX.velamp1] * vl) * LEVEL;
      k.wbase = P[PINDEX.warp1]; k.wdepth = P[PINDEX.wenvdepth1];
      k.sbase = P[PINDEX.shape1]; k.sdepth = P[PINDEX.senvdepth1]; k.link = P[PINDEX.link1];
      const pr = Math.round(P[PINDEX.pair1]);
      k.w0 = Math.round(P[PINDEX.wave1]); k.w1 = pr > 0 ? pr - 1 : k.w0; k.win = Math.round(P[PINDEX.window1]);
      // pitch cap: the steepest slope SLOPE/p never reads the cosine faster than WARP_FMAX
      k.cap = Math.max(SLOPE[k.w0], SLOPE[k.w1]) * hz / (WARP_FMAX * e.srOS);
      k.kHost = RESO_NYQ * e.sr / hz; k.kOS = RESO_OS * e.srOS / hz; k.lnReso = Math.log(RESO_MAX);
      k.fr = hz / e.srOS;                 // the note as a share of the internal rate
      // where the wave can jump or kink (see render)
      k.splitP = k.w0 === 6 || k.w1 === 6;
      k.splitHalf = k.win >= 2;
      k.splitEnd = k.win !== 0 || k.w0 === 5 || k.w1 === 5 || k.splitP;   // Double pulse at p = ½ jumps at the end
      // the shaper
      const sh = this.sh;
      sh.fam = Math.round(P[PINDEX.sfamily1]); sh.bias = P[PINDEX.bias1];
      sh.sub = sh.fam === 1 ? Math.round(P[PINDEX.fold1]) : sh.fam === 2 ? Math.round(P[PINDEX.sat1]) : 0;
      if (sh.fam === 0) {
        const h = e.harm;
        for (let i = 0; i < NH; i++) h[i] = P[PINDEX.h1_1 + i];
        chebWeights(sh.e, h, P[PINDEX.tilt1], P[PINDEX.oddeven1]);
      } else if (sh.fam === 3) {
        const c = e.curves[0];
        morphCurves(sh, c.keys, c.F, Math.round(P[PINDEX.keys1]), P[PINDEX.morph1]);
      }
      return k;
    }
    // pivot and resonance ratio for Warp amount a and shaper steepening E, into this.wp, this.wk; and
    // the wave's fastest frequency as a share of the internal rate (for the Chebyshev band limit)
    warpPoint(a, E) {
      const k = this.k;
      this.wp = Math.max(0.5 * Math.pow(2, -PIVOT_OCT * a), Math.min(0.5, k.cap * E));
      this.wk = Math.max(1, Math.min(Math.pow(RESO_MAX, a), k.kHost, k.kOS / E));
      this.sh.fpk = k.fr * Math.max(maxSlope(k.w0, this.wp, this.wk), maxSlope(k.w1, this.wp, this.wk));
    }
    warpAt(we) { const k = this.k, a = clamp(k.wbase + k.wdepth * we, 0, 1) * k.vw; return a; }
    shapeAt(we, se) { const k = this.k; return clamp(k.sbase + k.sdepth * se + k.link * we, 0, 1) * k.vs; }
    // start the DC blocker at the wave's mean, so a windowed wave does not thump at note on,
    // and the level at the wave's own
    primeDc() {
      const k = this.settings(), s0 = this.shapeAt(0, 0);
      this.warpPoint(this.warpAt(0), expansion(this.sh, s0));
      const p = this.wp, kr = this.wk;
      const l = levelOf(k.w0, k.w1, k.win, p, kr, this.sh, s0);
      this.dcx = l.mean; this.dcy = 0; this.gain = levelGain(l);
      // the band-limiting pipeline starts at the wave's first value, with nothing pending
      this.x1 = waveSample(k.w0, k.win, 0, p, kr);
      this.q0 = shapeSample(this.sh, this.x1, s0); this.carry = 0;
    }
    // one piece of a split sample: ADAA from xa to the wave just before phase b0 on wave wa, over a
    // share dt of the sample; then the shaped jump and kink at the breakpoint (tb into the sample),
    // whose residuals go to the last sample, this one and the next. Returns the wave just after
    // phase b1 on wave wb (the next piece's start).
    piece(xa, wa, b0, wb, b1, dt, tb, p, kr, s, inc) {
      const win = this.k.win, sh = this.sh, e = 1e-12, d = 1e-3 * inc;
      const xb = waveSample(wa, win, b0 - e, p, kr), xc = waveSample(wb, win, b1 + e, p, kr);
      this.acc += dt * shapeADAA(sh, xa, xb, s);
      const ya = shapeSample(sh, xb, s), yb = shapeSample(sh, xc, s);
      const sa = (ya - shapeSample(sh, waveSample(wa, win, b0 - e - d, p, kr), s)) * 1e3;
      const sb = (shapeSample(sh, waveSample(wb, win, b1 + e + d, p, kr), s) - yb) * 1e3;
      const r = residuals(tb, yb - ya, sb - sa);
      this.rm += r.m; this.ro += r.o; this.rp += r.p;
      return xc;
    }
    render(n, out) {
      const e = this.eng;
      // glide (mono): pitch moves toward the target, per block
      const dOct = this.targetOct - this.oct, step = this.glideStep * n;
      this.oct = step > 0 && Math.abs(dOct) > step ? this.oct + Math.sign(dOct) * step : this.targetOct;
      const k = this.settings(), sh = this.sh;
      const { inc, vw, vs, va, wbase, wdepth, sbase, sdepth, link, w0, w1, win } = k;
      const R = e.dcR;
      // level: measured at the Warp and Shape the block starts with, moved to across the block
      const sb0 = this.shapeAt(this.wenv.v, this.senv.v);
      this.warpPoint(this.warpAt(this.wenv.v), expansion(sh, sb0));
      const g1 = levelGain(levelOf(w0, w1, win, this.wp, this.wk, sh, sb0));
      let g = this.gain;
      const dg = (g1 - g) / n;
      let ph = this.ph, odd = this.odd, dcx = this.dcx, dcy = this.dcy, x1 = this.x1;
      const wenv = this.wenv, senv = this.senv, aenv = this.aenv;
      for (let i = 0; i < n; i++) {
        const we = wenv.next(), se = senv.next(), ae = aenv.next();
        const a = clamp(wbase + wdepth * we, 0, 1) * vw;
        const s = clamp(sbase + sdepth * se + link * we, 0, 1) * vs;
        this.warpPoint(a, expansion(sh, s));
        const p = this.wp, kr = this.wk;
        // advance the phase; the new sample x0 is the naive wave
        const prev = ph, wPrev = odd ? w1 : w0;
        ph += inc;
        let wrapped = false;
        if (ph >= 1) { ph -= 1; odd ^= 1; wrapped = true; }
        const w = odd ? w1 : w0;
        const x0 = 2 * carrier(warpU(w, ph, p, kr)) * windowW(win, ph) - 1;
        // band limit: the shaped wave averaged over the sample (first-order ADAA, a box filter). Where the
        // wave jumps or kinks inside the sample, the sample is split there and each piece is averaged on
        // its own, so a jump goes through the shaper as the jump it is, not as a line through the values
        // between; the jump and kink then get second-order residuals. The CZ waves are smooth at their
        // own breakpoints (the cosine is flat there), so only these split: Double pulse at p and ½ + p,
        // Resonance at the end of the cycle (hard sync), and a window at ½ and at the end of the cycle.
        // (Splitting where the wave is smooth made the steep peaks alias more: −32 instead of −66 dB.)
        const B = this.bps;
        B[0] = k.splitP ? p : 2; B[1] = k.splitHalf ? 0.5 : 2; B[2] = k.splitP ? 0.5 + p : 2;
        const end = wrapped ? 1 : ph;
        let split = wrapped && k.splitEnd;
        for (let j = 0; j < 3; j++) if (B[j] < 1 && B[j] > prev && B[j] <= end) { split = true; break; }
        let cur;
        this.rm = 0; this.ro = 0; this.rp = 0;
        if (!split) cur = shapeADAA(sh, x1, x0, s);
        else {
          this.acc = 0;
          let xa = x1, tp = 0;
          for (let j = 0; j < 3; j++) {
            const b = B[j];
            if (b < 1 && b > prev && b <= end) { const t = (b - prev) / inc; xa = this.piece(xa, wPrev, b, wPrev, b, t - tp, t, p, kr, s, inc); tp = t; }
          }
          if (wrapped) {
            const t = (1 - prev) / inc;
            if (k.splitEnd) { xa = this.piece(xa, wPrev, 1, w, 0, t - tp, t, p, kr, s, inc); tp = t; }
            for (let j = 0; j < 3; j++) {
              const b = B[j];
              if (b < 1 && b <= ph) { const t = (1 - prev + b) / inc; xa = this.piece(xa, w, b, w, b, t - tp, t, p, kr, s, inc); tp = t; }
            }
          }
          this.acc += (1 - tp) * shapeADAA(sh, xa, x0, s);
          cur = this.acc;
        }
        x1 = x0;
        // one more sample of delay, so a breakpoint can correct the sample before it: x is the last
        // sample, finished now
        const x = this.q0 + this.rm;
        this.q0 = cur + this.carry + this.ro; this.carry = this.rp;
        const y = x - dcx + R * dcy; dcx = x; dcy = y;
        g += dg;
        out[i] += y * ae * ae * g * va;
      }
      this.gain = g1;
      this.ph = ph; this.odd = odd; this.x1 = x1;
      this.dcx = dcx; this.dcy = Math.abs(dcy) < 1e-20 ? 0 : dcy;
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
      this.harm = new Float64Array(NH);
      // drawn keyframes per line (line 2 comes in batch 09), with their antiderivatives
      this.curves = [0].map(() => {
        const keys = DEFAULT_CURVES.map((y) => Float64Array.from(y));
        return { keys, F: keys.map(antiderivative) };
      });
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
    // a drawn keyframe: points [[x, y], …] with x and y in −1 … 1; smooth: Catmull-Rom, else straight
    setCurve(line, key, points, smooth) {
      const c = this.curves[line - 1];
      if (!c || key < 0 || key >= MAX_KEYS || !points || points.length < 2) return;
      c.keys[key] = curveTable(points.map(([x, y]) => [clamp(x, -1, 1), clamp(y, -1, 1)]), smooth);
      c.F[key] = antiderivative(c.keys[key]);
    }
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
