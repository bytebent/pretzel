// Reference engine tests. Run: node tests/engine-test.js
'use strict';
const path = require('path');
const { PretzelEngine, PARAMS, core } = require(path.join(__dirname, '..', 'reference', 'pretzel-engine.js'));
const { env } = require(path.join(__dirname, '..', 'reference', 'presets.js'));

let failed = 0, count = 0;
function check(name, ok, detail) {
  count++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failed++;
}

const SR = 48000;
function render(seconds, setup, opts) {
  opts = opts || {};
  const e = new PretzelEngine(SR, 1234);
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n), R = new Float32Array(n);
  setup(e);
  const bl = opts.block || 128;
  const tl = new Float32Array(bl), tr = new Float32Array(bl);
  for (let i = 0; i < n; i += bl) {
    if (opts.events) opts.events(e, i);
    const m = Math.min(bl, n - i);
    e.process(tl, tr, m);
    L.set(tl.subarray(0, m), i); R.set(tr.subarray(0, m), i);
  }
  return { e, L, R };
}
function apply(e, p) { for (const k in p) e.setParam(k, p[k]); }
const cents = (a, b) => 1200 * Math.log2(a / b);
const steady = (x, from, to) => x.subarray(Math.round(from * SR), Math.round(to * SR));
// a plain held tone: no velocity effect, no key follow, Warp from the knob only, flat amp
const PLAIN = {
  velwarp1: 0, velamp1: 0, warpkey1: 0, wenvdepth1: 0,
  ...env('aenv', 1, [[0.005, 1], [0.01, 1], [0.01, 0]], 2, 3),
};

// period by correlation at ever longer lags (as in Syrinx's tests)
function pitch(x, sr, lo, hi) {
  const n = x.length;
  const ac = (lag) => { let s = 0, a = 0, b = 0; for (let i = 0; i + lag < n; i++) { s += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; } return s / Math.sqrt(a * b); };
  const peak = (from, to) => {
    let best = from, bv = -Infinity;
    for (let l = from; l <= to; l++) { const v = ac(l); if (v > bv) { bv = v; best = l; } }
    const y0 = ac(best - 1), y1 = bv, y2 = ac(best + 1);
    return best + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2);
  };
  let T = sr / Math.sqrt(lo * hi);
  T = peak(Math.max(2, Math.floor(T * 0.75)), Math.ceil(T * 1.33));
  for (let k = 4; k * T < n / 2; k *= 4) {
    const want = k * T;
    T = peak(Math.round(want) - 2, Math.round(want) + 2) / k;
  }
  return sr / T;
}
// harmonic levels of one cycle sampled at N points: |X_h| for h = 0…H
function harmonics(f, N, H) {
  const out = [];
  for (let h = 0; h <= H; h++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const x = f(i / N), w = 2 * Math.PI * h * i / N; re += x * Math.cos(w); im += x * Math.sin(w); }
    out.push(Math.hypot(re, im) / N * (h ? 2 : 1));
  }
  return out;
}
const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/* ---------- 1. the waves match MAME's µPD933 integer code ---------- */
// A direct transcription of upd933.cpp's update(): 11-bit position, pivot = 0x400 − dcw.
// Our wave index → the chip's wave code (the chip's 3 is a silent wave, left out).
const CHIP_WAVE = [0, 1, 2, 4, 5, 6, 7];
function mamePhase(code, pos, dcw) {
  const pivot = 0x400 - dcw;
  let phase = 0;
  switch (code) {
    case 0: phase = pos < pivot ? Math.floor(pos * 0x400 / pivot) : 0x400 + Math.floor((pos - pivot) * 0x400 / (0x800 - pivot)); break;
    case 1: phase = ((pos & 0x3ff) < pivot ? Math.floor((pos & 0x3ff) * 0x400 / pivot) : 0x3ff) | (pos & 0x400); break;
    case 2: phase = pos < pivot * 2 ? Math.floor(pos * 0x800 / (pivot * 2)) : 0x7ff; break;
    case 4: phase = pos < pivot ? Math.floor(pos * 0x800 / pivot) : Math.floor((pos - pivot) * 0x800 / (0x800 - pivot)); break;
    case 5: phase = pos < 0x400 ? pos : pos < pivot + 0x400 ? 0x400 + Math.floor((pos & 0x3ff) * 0x400 / pivot) : 0x7ff; break;
    case 6: phase = (pos + ((pos * dcw) >> 6)) & 0x7ff; break;
    case 7: phase = (pos & 0x3ff) < pivot ? Math.floor((pos & 0x3ff) * 0x400 / pivot) : 0x7ff; break;
  }
  return phase;
}
function mameWindow(win, pos) {
  let w = 0;
  switch (win) {
    case 1: w = pos; break;
    case 2: w = (pos & 0x3ff) * 2; if (pos < 0x400) w ^= 0x7fe; break;
    case 3: if (pos >= 0x400) w = (pos & 0x3ff) * 2; break;
    case 4: w = pos < 0x400 ? pos * 2 : 0x7ff; break;
    case 5: w = (0x3ff ^ (pos & 0x3ff)) * 2; break;
  }
  return (0x800 - w) / 0x800;
}
{
  // compare the carrier value (what is heard), so a wrap at u = 0 ↔ 1 counts as equal
  for (let w = 0; w < 7; w++) {
    let worst = 0;
    for (const dcw of [0, 0x100, 0x200, 0x300, 0x3f8]) {
      const p = (0x400 - dcw) / 0x800, k = 1 + dcw / 64;
      for (let pos = 0; pos < 0x800; pos++) {
        const ours = core.carrier(core.warpU(w, pos / 0x800, p, k));
        const chip = core.carrier(mamePhase(CHIP_WAVE[w], pos, dcw) / 0x800);
        worst = Math.max(worst, Math.abs(ours - chip));
      }
    }
    // the chip truncates to 11 bits; one step of phase moves the carrier by at most π/2048 × … ≈ 0.0015 per LSB
    check('1. ' + core.WAVES[w] + ' matches the chip at every position and 5 Warp settings', worst < 0.006, 'worst ' + worst.toFixed(4));
  }
  let worst = 0;
  for (let win = 0; win < 6; win++) for (let pos = 0; pos < 0x800; pos++)
    worst = Math.max(worst, Math.abs(core.windowW(win, pos / 0x800) - mameWindow(win, pos)));
  check('1. all 6 windows match the chip', worst < 0.002, 'worst ' + worst.toFixed(4));
}

/* ---------- 2. Warp 0 is a pure cosine ---------- */
{
  const p = core.pivotOf(0, 0), k = core.resoOf(0, 99);
  check('2. Warp 0 puts the pivot in the middle and the resonance ratio at 1', p === 0.5 && k === 1);
  for (const w of [0, 1, 2, 4, 5]) {
    const H = harmonics((ph) => core.waveSample(w, 0, ph, p, k), 2048, 12);
    const rest = Math.max(H[0], ...H.slice(2));
    check('2. ' + core.WAVES[w] + ' at Warp 0 is a pure cosine', dB(rest / H[1]) < -60, 'other harmonics ' + dB(rest / H[1]).toFixed(0) + ' dB');
  }
  const H = harmonics((ph) => core.waveSample(3, 0, ph, p, k), 2048, 12);
  const rest = Math.max(H[0], H[1], ...H.slice(3));
  check('2. Double sine at Warp 0 is a pure cosine an octave up (as the chip)', dB(rest / H[2]) < -60, dB(rest / H[2]).toFixed(0) + ' dB');
}

/* ---------- 3. Warp brightens; the pitch cap holds ---------- */
{
  const bright = (a) => { const H = harmonics((ph) => core.waveSample(0, 0, ph, core.pivotOf(a, 0), 1), 2048, 40); let num = 0, den = 0; H.forEach((v, h) => { if (h) { num += h * v * v; den += v * v; } }); return num / den; };
  const b = [0, 0.25, 0.5, 0.75, 1].map(bright);
  check('3. Saw gets brighter at every step of Warp', b.every((v, i) => !i || v > b[i - 1]), b.map(v => v.toFixed(2)).join(' → '));
  // at a high note the pivot never gets shorter than 4 internal samples
  const hz = 2000, cap = 4 * hz / (SR * 4);
  check('3. pitch cap: at 2 kHz full Warp keeps the pivot at 4 internal samples', Math.abs(core.pivotOf(1, cap) - cap) < 1e-12 && core.pivotOf(0, cap) === 0.5);
}

/* ---------- 4. pitch ---------- */
{
  for (const [note, w] of [[69, 0], [45, 1], [81, 5]]) {
    const { L } = render(1.0, (e) => { apply(e, { ...PLAIN, wave1: w, warp1: 0.4 }); e.noteOn(note, 100); });
    const want = 440 * Math.pow(2, (note - 69) / 12);
    const f = pitch(steady(L, 0.3, 0.9), SR, want * 0.8, want * 1.25);
    check('4. note ' + note + ' (' + core.WAVES[w] + ') in tune', Math.abs(cents(f, want)) < 0.1, cents(f, want).toFixed(3) + ' cents');
  }
  const { L } = render(1.0, (e) => { apply(e, { ...PLAIN, transpose: 7 }); e.setBend(1); e.noteOn(60, 100); });
  const want = 440 * Math.pow(2, (60 + 7 + 2 - 69) / 12), f = pitch(steady(L, 0.3, 0.9), SR, want * 0.8, want * 1.25);
  check('4. Transpose and full bend (2 semitones) add up', Math.abs(cents(f, want)) < 0.1, cents(f, want).toFixed(3) + ' cents');
}

/* ---------- 5. wave pairs ---------- */
{
  const f = (pair, lo, hi) => {
    const { L } = render(1.0, (e) => { apply(e, { ...PLAIN, wave1: 0, pair1: pair, warp1: 0.6 }); e.noteOn(57, 100); });
    return pitch(steady(L, 0.3, 0.9), SR, lo, hi);
  };
  // the search range sits around the expected pitch; a lower peak in it would mean a sub-octave
  const solo = f(0, 150, 300), paired = f(3, 75, 150);
  check('5. Saw alone sounds at the note', Math.abs(cents(solo, 220)) < 0.5, solo.toFixed(2) + ' Hz');
  check('5. Saw paired with Pulse sounds an octave lower', Math.abs(cents(paired, 110)) < 0.5, paired.toFixed(2) + ' Hz');
  const same = f(1, 150, 300);
  check('5. a wave paired with itself changes nothing', Math.abs(cents(same, 220)) < 0.5, same.toFixed(2) + ' Hz');
}

/* ---------- 6. no DC, no thump ---------- */
{
  for (const [w, win, name] of [[0, 0, 'Saw'], [5, 2, 'Resonance + Triangle window'], [2, 4, 'Pulse + Pulse window']]) {
    const { L } = render(1.2, (e) => { apply(e, { ...PLAIN, wave1: w, window1: win, warp1: 0.7 }); e.noteOn(48, 100); });
    const x = steady(L, 0.2, 1.2);
    let m = 0, pk = 0; for (const v of x) { m += v; pk = Math.max(pk, Math.abs(v)); }
    m /= x.length;
    check('6. ' + name + ': output has no DC', Math.abs(m) < 0.002 * pk, 'mean ' + (m / pk * 100).toFixed(3) + '% of peak');
    // 10–70 ms, after the 5 ms attack: a wrongly started DC blocker would show as an offset
    // decaying over about 30 ms; compare the mean over each whole period
    const T = SR / (440 * Math.pow(2, (48 - 69) / 12)), y = steady(L, 0.01, 0.07);
    let worst = 0;
    for (let c = 0; (c + 1) * T <= y.length; c++) {
      const a0 = Math.round(c * T), a1 = Math.round((c + 1) * T);
      let a = 0; for (let i = a0; i < a1; i++) a += y[i];
      worst = Math.max(worst, Math.abs(a / (a1 - a0)));
    }
    check('6. ' + name + ': no thump at note on', worst < 0.03 * pk, 'worst period mean ' + (worst / pk * 100).toFixed(1) + '% of peak');
  }
}

/* ---------- 7. same output at any buffer size ---------- */
{
  const setup = (e) => { apply(e, { wave1: 5, window1: 3, pair1: 0 }); e.noteOn(50, 90); e.noteOn(57, 70); };
  const a = render(0.6, setup, { block: 128 }).L, b = render(0.6, setup, { block: 37 }).L, c = render(0.6, setup, { block: 1 }).L;
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]), Math.abs(a[i] - c[i]));
  check('7. buffers of 128, 37 and 1 samples give the same output', d === 0, 'max difference ' + d);
}

/* ---------- 8. envelopes ---------- */
{
  // sustain holds, release goes to the stage after the sustain point, then the voice stops
  const { e, L } = render(2.0, (e) => {
    apply(e, { ...PLAIN, ...env('aenv', 1, [[0.05, 1], [0.1, 0.5], [0.2, 0]], 2, 3) });
    e.noteOn(60, 100);
  }, { events: (e, i) => { if (i === 128 * 375) e.noteOff(60); } });   // off at 1.0 s
  const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
  const a = rms(steady(L, 0.3, 0.5)), b = rms(steady(L, 0.7, 0.9));
  check('8. the amp envelope holds at its sustain stage', Math.abs(dB(b / a)) < 0.1, (dB(b / a)).toFixed(2) + ' dB drift');
  // level 1 held for 0.3 s, then down to 0.5 and held
  const r1 = render(1.0, (e) => { apply(e, { ...PLAIN, ...env('aenv', 1, [[0.005, 1], [0.3, 1], [0.005, 0.5], [0.1, 0]], 3, 4) }); e.noteOn(60, 100); });
  const full = rms(steady(r1.L, 0.1, 0.3)), held = rms(steady(r1.L, 0.5, 0.9));
  check('8. amp gain is the level squared: sustain 0.5 sits 12 dB below level 1', Math.abs(dB(held / full) + 12.04) < 0.2, dB(held / full).toFixed(2) + ' dB');
  check('8. after release the voice stops', e.info.voices === 0 && rms(steady(L, 1.4, 2.0)) < 1e-6);
  // no sustain point: the envelope runs to its end with the key held, and the voice stops
  const r2 = render(1.0, (e) => { apply(e, { ...PLAIN, ...env('aenv', 1, [[0.01, 1], [0.2, 0]], 0, 2) }); e.noteOn(60, 100); });
  check('8. no sustain point: runs to the end while held, then stops', r2.e.info.voices === 0 && rms(steady(r2.L, 0.4, 1.0)) < 1e-6);
  // the Warp envelope moves the timbre: brighter at its peak than at its sustain
  const r3 = render(1.5, (e) => { apply(e, { ...PLAIN, wenvdepth1: 1, ...env('wenv', 1, [[0.2, 1], [0.4, 0.1]], 2, 3) }); e.noteOn(48, 100); });
  const zc = (x) => { let c = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++; return c; };
  const diff = (x) => { let s = 0; for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2; return Math.sqrt(s) / rms(x) / Math.sqrt(x.length); };
  check('8. the Warp envelope opens the timbre and settles', diff(steady(r3.L, 0.18, 0.22)) > 1.5 * diff(steady(r3.L, 1.0, 1.4)), diff(steady(r3.L, 0.18, 0.22)).toFixed(3) + ' vs ' + diff(steady(r3.L, 1.0, 1.4)).toFixed(3));
}

/* ---------- 8b. levels are evened out ---------- */
{
  // every wave at five Warp settings, and Resonance through every window: the level stays near
  // the Saw's. Without evening out the spread is 19 dB (Pulse at full Warp −16 dB, Square +3 dB,
  // windows down to −11 dB).
  const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
  const level = (p) => dB(rms(steady(render(0.5, (e) => { apply(e, { ...PLAIN, warpkey1: 0, ...p }); e.noteOn(48, 100); }).L, 0.2, 0.5)));
  const ref = level({ wave1: 0, warp1: 0 });
  const rows = [];
  for (let w = 0; w < 7; w++) for (const a of [0, 0.25, 0.5, 0.75, 1]) rows.push(['wave ' + w + ' Warp ' + a, level({ wave1: w, warp1: a }) - ref]);
  for (let win = 1; win < 6; win++) for (const a of [0, 0.5, 1]) rows.push(['Resonance window ' + win + ' Warp ' + a, level({ wave1: 5, window1: win, warp1: a }) - ref]);
  // Pulse and Double pulse become spikes at high Warp: matching their RMS would push the peak far
  // past everything else, so their gain stops at 4 times their peak. They are checked apart.
  const spiky = (r) => /^wave [26] Warp (0\.75|1)$/.test(r[0]);
  const main = rows.filter(r => !spiky(r)), sp = rows.filter(spiky);
  const lo = Math.min(...main.map(r => r[1])), hi = Math.max(...main.map(r => r[1]));
  check('8b. levels across every wave, Warp and window within 3.5 dB of the Saw', lo > -3.5 && hi < 3.5, lo.toFixed(1) + ' to +' + hi.toFixed(1) + ' dB; lowest ' + main.find(r => r[1] === lo)[0]);
  const slo = Math.min(...sp.map(r => r[1]));
  check('8b. narrow pulses (Pulse, Double pulse at Warp 0.75 and 1) no more than 13 dB down', slo > -13, slo.toFixed(1) + ' dB at worst (16.3 dB down without evening out)');
}

/* ---------- 9. voices ---------- */
{
  const { e } = render(0.3, (e) => { for (let n = 0; n < 10; n++) e.noteOn(48 + n, 100); });
  check('9. Poly plays at most 8 voices', e.info.voices === 8, e.info.voices + ' voices');
  // Mono with glide: a legato note slides and does not restart the envelopes
  const r = render(1.0, (e) => { apply(e, { ...PLAIN, mode: 0, glide: 0.1 }); e.noteOn(57, 100); },
    { events: (e, i) => { if (i === 128 * 150) e.noteOn(69, 100); } });   // at 0.4 s, legato
  const f1 = pitch(steady(r.L, 0.2, 0.38), SR, 150, 300), f2 = pitch(steady(r.L, 0.44, 0.46), SR, 200, 450), f3 = pitch(steady(r.L, 0.6, 1.0), SR, 300, 600);
  check('9. Mono glide: starts at the first note', Math.abs(cents(f1, 220)) < 1, f1.toFixed(1) + ' Hz');
  check('9. Mono glide: halfway after half the glide time', Math.abs(cents(f2, 311.13)) < 30, f2.toFixed(1) + ' Hz');
  check('9. Mono glide: arrives at the second note', Math.abs(cents(f3, 440)) < 0.1, f3.toFixed(1) + ' Hz');
  check('9. Mono: one voice', r.e.info.voices === 1);
}

/* ---------- 10. every parameter ---------- */
{
  const ids = new Set();
  let ok = true;
  for (const d of PARAMS) { if (ids.has(d.id) || !(d.def >= d.min && d.def <= d.max)) ok = false; ids.add(d.id); }
  check('10. parameter ids unique, defaults in range', ok, PARAMS.length + ' parameters');
  // a high note at full Warp on every wave stays finite and below clipping
  let worst = 0, finite = true;
  for (let w = 0; w < 7; w++) {
    const { L } = render(0.3, (e) => { apply(e, { ...PLAIN, wave1: w, warp1: 1 }); e.noteOn(108, 127); });
    for (const v of L) { if (!Number.isFinite(v)) finite = false; worst = Math.max(worst, Math.abs(v)); }
  }
  check('10. MIDI 108 at full Warp on every wave stays finite and unclipped', finite && worst < 1, 'peak ' + worst.toFixed(3));
}

/* ================= batch 03: the shaper ================= */
const sh = core.makeShaper();
function setShaper(fam, sub, bias, h, tilt, oe) {
  sh.fam = fam; sh.sub = sub || 0; sh.bias = bias || 0;
  const hh = new Float64Array(16); (h || [1]).forEach((v, i) => { hh[i] = v; });
  core.chebWeights(sh.e, hh, tilt || 0, oe || 0);
  core.morphCurves(sh, core.DEFAULT_CURVES, core.DEFAULT_CURVES.map(core.antiderivative), 4, 0);
}
const cosine = (ph) => -Math.cos(2 * Math.PI * ph);     // what Warp 0 gives (2c − 1)

/* ---------- 11. Shape 0 passes the wave unchanged ---------- */
{
  const names = [];
  let worst = 0;
  for (const [fam, sub] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) {
    setShaper(fam, sub, 0, [0.2, 0.7, 0.5, 0, 1]);
    for (let i = 0; i <= 200; i++) { const x = -1 + i / 100; worst = Math.max(worst, Math.abs(core.shapeSample(sh, x, 0) - x)); }
    names.push(core.SHAPERS[fam] + (fam === 1 ? ' ' + core.FOLDS[sub] : fam === 2 ? ' ' + core.SATS[sub] : ''));
  }
  check('11. Shape 0, Bias 0 passes the wave unchanged in all 8 shapers', worst === 0, names.join(', '));
  // and Shape moves away from it smoothly: a tiny Shape changes the wave only a little
  let jump = 0;
  for (const [fam, sub] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) {
    setShaper(fam, sub, 0, [0.2, 0.7, 0.5, 0, 1]);
    for (let i = 0; i <= 200; i++) { const x = -1 + i / 100; jump = Math.max(jump, Math.abs(core.shapeSample(sh, x, 1e-4) - x)); }
  }
  check('11. no jump: Shape 0.0001 moves no shaper by more than 1%', jump < 0.01, 'largest ' + jump.toExponential(1));
}

/* ---------- 12. Chebyshev: exact harmonics ---------- */
{
  const h = [1, 0.5, 0, 0.25, 0.8, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0.3];
  setShaper(0, 0, 0, h);
  const H = harmonics((ph) => core.shapeSample(sh, cosine(ph), 1), 4096, 20), sum = h.reduce((a, b) => a + b, 0);
  let worst = 0;
  for (let k = 1; k <= 20; k++) worst = Math.max(worst, Math.abs(H[k] - (k <= 16 ? h[k - 1] / sum : 0)));
  check('12. a full-scale cosine at Shape 1 gives harmonic k at h_k (scaled to add up to 1), nothing above 16', worst < 1e-9, 'worst ' + worst.toExponential(1));
  check('12. no DC from Chebyshev on a cosine', Math.abs(H[0]) < 1e-9);
  // Shape brings the harmonics in step by step, low ones first
  setShaper(0, 0, 0, Array(16).fill(1));
  const at = (s) => harmonics((ph) => core.shapeSample(sh, cosine(ph), s), 2048, 16);
  const centroid = (H) => { let a = 0, b = 0; for (let k = 1; k <= 16; k++) { a += k * H[k] * H[k]; b += H[k] * H[k]; } return a / b; };
  const c = [0, 0.25, 0.5, 0.75, 1].map((s) => centroid(at(s)));
  check('12. Chebyshev brightens at every step of Shape', c.every((v, i) => !i || v > c[i - 1]), c.map((v) => v.toFixed(2)).join(' → '));
  const half = at(0.5);
  check('12. at Shape 0.5 the low harmonics lead: h2 above h8 above h16', half[2] > half[8] && half[8] > half[16], [2, 8, 16].map((k) => dB(half[k]).toFixed(0)).join(' / ') + ' dB');
  // after a warp, the shaper gives the warped wave's harmonics k·g(φ): the identity S(cos θ) = Σ e_k cos kθ
  setShaper(0, 0, 0, [0, 0, 1]);
  const p = core.pivotOf(0.5, 0);
  let d = 0;
  for (let i = 0; i < 512; i++) { const ph = i / 512, u = core.warpU(0, ph, p, 1); d = Math.max(d, Math.abs(core.shapeSample(sh, core.waveSample(0, 0, ph, p, 1), 1) - (-Math.cos(3 * 2 * Math.PI * u)))); }
  check('12. after a warp, harmonic 3 alone is the cosine read at 3 × the warped phase (to the cosine table\'s precision)', d < 1e-5, 'worst ' + d.toExponential(1));
}

/* ---------- 13. Tilt and Odd/Even ---------- */
{
  const all = Array(16).fill(1);
  const H = (tilt, oe) => { setShaper(0, 0, 0, all, tilt, oe); return harmonics((ph) => core.shapeSample(sh, cosine(ph), 1), 2048, 16); };
  const up = H(1, 0), down = H(-1, 0);
  check('13. Tilt +1: harmonic 16 is 16 times harmonic 1', Math.abs(up[16] / up[1] - 16) < 1e-6, (up[16] / up[1]).toFixed(3));
  check('13. Tilt −1: harmonic 16 is 1/16 of harmonic 1', Math.abs(down[16] / down[1] - 1 / 16) < 1e-6, (down[16] / down[1]).toFixed(4));
  const odd = H(0, 1), even = H(0, -1);
  check('13. Odd/Even +1 leaves odd harmonics only', [2, 4, 8, 16].every((k) => odd[k] < 1e-12) && odd[3] > 0.01);
  check('13. Odd/Even −1 leaves the fundamental and even harmonics', [3, 5, 9, 15].every((k) => even[k] < 1e-12) && even[1] > 0.01 && even[2] > 0.01);
}

/* ---------- 14. Fold and Saturate ---------- */
{
  setShaper(1, 1);
  let d = 0;
  for (let i = 0; i <= 200; i++) { const x = -1 + i / 100; d = Math.max(d, Math.abs(core.shapeSample(sh, x, 1) - Math.sin(10 * Math.asin(x)))); }
  check('14. Sine fold at Shape 1 is sin(10·asin x)', d < 1e-12);
  // folding adds zero crossings as Shape rises, for all three folders
  for (const sub of [0, 1, 2]) {
    setShaper(1, sub);
    const zc = (s) => { let c = 0, prev = core.shapeSample(sh, cosine(0.001), s); for (let i = 1; i < 2000; i++) { const y = core.shapeSample(sh, cosine((i + 0.5) / 2000), s); if ((y < 0) !== (prev < 0)) c++; prev = y; } return c; };
    const z = [0, 0.4, 0.7, 1].map(zc);
    check('14. ' + core.FOLDS[sub] + ' fold: more folds as Shape rises', z.every((v, i) => !i || v > z[i - 1]), 'zero crossings per cycle ' + z.join(' → '));
  }
  // every folder and saturator stays within ±1.05
  let pk = 0;
  for (const [f, sub] of [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]) { setShaper(f, sub); for (const s of [0.2, 0.5, 1]) for (let i = 0; i <= 400; i++) pk = Math.max(pk, Math.abs(core.shapeSample(sh, -1 + i / 200, s))); }
  check('14. folders and saturators stay within ±1.05', pk < 1.05, 'peak ' + pk.toFixed(3));
  // Lambert W: w·e^w = z across 600 orders of magnitude
  let lw = 0;
  for (let L = -40; L < 300; L += 0.37) { const w = core.lambertWexp(L); lw = Math.max(lw, Math.abs(Math.log(w) + w - L)); }
  check('14. Lambert W solves w·e^w = e^L from L = −40 to 300', lw < 1e-6, 'worst error in log ' + lw.toExponential(1));
  // symmetric saturation of a cosine gives odd harmonics only; Bias brings in even ones
  for (const sub of [0, 1, 2]) {
    setShaper(2, sub, 0);
    const a = harmonics((ph) => core.shapeSample(sh, cosine(ph), 0.7), 2048, 6);
    setShaper(2, sub, 0.5);
    const b = harmonics((ph) => core.shapeSample(sh, cosine(ph), 0.7), 2048, 6);
    check('14. ' + core.SATS[sub] + ': odd harmonics only at Bias 0; Bias 0.5 adds even ones', a[2] < 1e-9 && a[4] < 1e-9 && a[3] > 1e-3 && dB(b[2] / b[1]) > -40, 'h2 at Bias 0.5: ' + dB(b[2] / b[1]).toFixed(0) + ' dB');
  }
}

/* ---------- 15. Drawn curves ---------- */
{
  const keys = core.DEFAULT_CURVES, F = keys.map(core.antiderivative);
  // morphing the antiderivatives equals the antiderivative of the morph
  let d = 0;
  for (const m of [0.1, 0.37, 0.5, 0.82, 1]) {
    core.morphCurves(sh, keys, F, 4, m);
    const Fm = core.antiderivative(sh.dy);
    for (let j = 0; j <= core.CURVE_N; j++) d = Math.max(d, Math.abs(Fm[j] - sh.dF[j]));
  }
  check('15. morphed antiderivatives equal the antiderivative of the morphed curve', d < 1e-12, 'worst ' + d.toExponential(1));
  // the stored antiderivative's slope is the curve, anywhere (not only on table points)
  core.morphCurves(sh, keys, F, 4, 0.6);
  let s2 = 0;
  for (let i = 1; i < 1000; i++) { const v = -1 + 2 * i / 1000, h = 1e-6; s2 = Math.max(s2, Math.abs((core.antiAt(sh.dy, sh.dF, v + h) - core.antiAt(sh.dy, sh.dF, v - h)) / (2 * h) - core.tableAt(sh.dy, v))); }
  check('15. the antiderivative\'s slope is the curve between table points too', s2 < 1e-6, 'worst ' + s2.toExponential(1));
  // Morph runs through the keyframes in order
  core.morphCurves(sh, keys, F, 4, 1 / 3);
  let k1 = 0; for (let j = 0; j <= core.CURVE_N; j++) k1 = Math.max(k1, Math.abs(sh.dy[j] - keys[1][j]));
  core.morphCurves(sh, keys, F, 2, 1);
  let k2 = 0; for (let j = 0; j <= core.CURVE_N; j++) k2 = Math.max(k2, Math.abs(sh.dy[j] - keys[1][j]));
  check('15. Morph 1/3 of 4 keyframes is keyframe 2; Morph 1 of 2 keyframes is keyframe 2', k1 < 1e-12 && k2 < 1e-12);
  // a drawn curve set through the engine is used
  const off = render(0.4, (e) => { apply(e, { ...PLAIN, sfamily1: 3, shape1: 1, keys1: 2, morph1: 0 }); e.noteOn(48, 100); }).L;
  const on = render(0.4, (e) => { apply(e, { ...PLAIN, sfamily1: 3, shape1: 1, keys1: 2, morph1: 0 }); e.setCurve(1, 0, [[-1, -1], [-0.2, 1], [0.2, -1], [1, 1]], false); e.noteOn(48, 100); }).L;
  let diff = 0; for (let i = 0; i < off.length; i++) diff = Math.max(diff, Math.abs(off[i] - on[i]));
  check('15. setCurve changes the sound', diff > 0.05);
}

/* ---------- 16. the Shape envelope, Link, velocity and key follow ---------- */
{
  const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
  const bright = (x) => { let s = 0; for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2; return Math.sqrt(s / x.length) / rms(x); };
  const fold = { sfamily1: 1, fold1: 1, warp1: 0 };
  // Shape envelope: brighter at its peak than at its sustain
  const r = render(1.5, (e) => { apply(e, { ...PLAIN, ...fold, senvdepth1: 1, shapekey1: 0, ...env('senv', 1, [[0.2, 1], [0.4, 0.1]], 2, 3) }); e.noteOn(48, 100); }).L;
  check('16. the Shape envelope opens the fold and settles', bright(steady(r, 0.18, 0.22)) > 2 * bright(steady(r, 1.0, 1.4)), bright(steady(r, 0.18, 0.22)).toFixed(3) + ' vs ' + bright(steady(r, 1.0, 1.4)).toFixed(3));
  // Link: the Warp envelope drives Shape; with Link 0 and no Shape envelope the fold stays shut
  const linked = (link) => render(0.5, (e) => { apply(e, { ...PLAIN, ...fold, senvdepth1: 0, link1: link, shapekey1: 0, ...env('wenv', 1, [[0.01, 1]], 0, 1) }); e.noteOn(48, 100); }).L;
  const l0 = bright(steady(linked(0), 0.2, 0.5)), l1 = bright(steady(linked(1), 0.2, 0.5)), lm = bright(steady(linked(-1), 0.2, 0.5));
  check('16. Link 1 lets the Warp envelope fold the wave; Link 0 does not', l1 > 3 * l0, l0.toFixed(3) + ' → ' + l1.toFixed(3));
  check('16. Link −1 with Shape 0 cannot go below 0: no fold', Math.abs(lm - l0) < 1e-3);
  // velocity and key follow lower Shape
  const vel = (v) => bright(steady(render(0.5, (e) => { apply(e, { ...PLAIN, ...fold, shape1: 0.6, velshape1: 1, shapekey1: 0 }); e.noteOn(48, v); }).L, 0.2, 0.5));
  check('16. Velocity: a soft note is folded less', vel(30) < vel(127), vel(30).toFixed(3) + ' vs ' + vel(127).toFixed(3));
  const key = (k) => bright(steady(render(0.5, (e) => { apply(e, { ...PLAIN, ...fold, shape1: 0.6, velshape1: 0, shapekey1: k }); e.noteOn(84, 100); }).L, 0.2, 0.5));
  check('16. Key follow: two octaves above middle C, Shape key follow 1 folds less', key(1) < key(0), key(1).toFixed(3) + ' vs ' + key(0).toFixed(3));
}

/* ---------- 17. levels through the shaper ---------- */
{
  const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
  const level = (p) => dB(rms(steady(render(0.5, (e) => { apply(e, { ...PLAIN, shapekey1: 0, velshape1: 0, ...p }); e.noteOn(48, 100); }).L, 0.2, 0.5)));
  const ref = level({});
  const rows = [];
  for (const [f, sub] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) for (const s of [0.5, 1]) for (const w of [0, 0.6])
    rows.push([core.SHAPERS[f] + ' ' + sub + ' Shape ' + s + ' Warp ' + w, level({ sfamily1: f, fold1: sub, sat1: sub, shape1: s, warp1: w, h1_1: 1, h3_1: 0.5, h5_1: 0.3 }) - ref]);
  const lo = Math.min(...rows.map((r) => r[1])), hi = Math.max(...rows.map((r) => r[1]));
  check('17. every shaper at Shape ½ and 1, Warp 0 and 0.6, within 3.5 dB of the plain wave', lo > -3.5 && hi < 3.5, lo.toFixed(1) + ' to +' + hi.toFixed(1) + ' dB');
  // the Organ preset's chords never clip
  const { renderPreset } = require(path.join(__dirname, '..', 'tools', 'render-presets.js'));
  const { PRESETS } = require(path.join(__dirname, '..', 'reference', 'presets.js'));
  let worst = 0, name = '';
  for (const pr of PRESETS) { const { L } = renderPreset(pr); let pk = 0; for (const v of L) pk = Math.max(pk, Math.abs(v)); if (pk > worst) { worst = pk; name = pr.name; } }
  check('17. no test preset clips', worst < 0.99, 'loudest peak ' + worst.toFixed(2) + ' (' + name + ')');
}

/* ================= batch 04: band limiting ================= */

/* ---------- 18. the antiderivatives ---------- */
{
  // every shaper's antiderivative has the shaper as its slope, at several Shapes and Biases
  let worst = 0, where = '';
  for (const [fam, sub] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) for (const s of [0.05, 0.4, 1]) {
    setShaper(fam, sub, 0, [1, 0.3, 0.6, 0.1, 0.5, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.4]);
    sh.fpk = 0.01;
    if (fam === 0) core.shapeADAA(sh, 0.1, 0.2, s);     // fills the antiderivative's coefficients for s
    for (let i = 1; i < 400; i++) {
      const v = -0.995 + 1.99 * i / 400, h = 1e-6;
      const d = (core.shapeAnti(sh, v + h, s) - core.shapeAnti(sh, v - h, s)) / (2 * h) - core.shapeSample(sh, v, s);
      if (Math.abs(d) > worst) { worst = Math.abs(d); where = core.SHAPERS[fam] + ' ' + sub + ' Shape ' + s + ' at ' + v.toFixed(3); }
    }
  }
  check('18. every shaper\'s antiderivative has the shaper as its slope', worst < 2e-4, 'worst ' + worst.toExponential(1) + ' (' + where + ')');
  // near Shape 0 the antiderivatives must keep their precision: ADAA over small steps agrees with the
  // shaper at the midpoint (log cosh in its plain form crackled at −58 dB as a Shape envelope closed)
  let tiny = 0, tw = '';
  for (const [fam, sub] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) for (const s of [1e-4, 3e-4, 2e-3, 1e-2]) {
    setShaper(fam, sub, 0, [1, 0.3, 0.6]); sh.fpk = 0.01;
    for (let i = 0; i < 200; i++) {
      const x0 = -0.9 + 0.9 * i / 100, x1 = x0 + 0.004;   // inside ±0.9: no fold point within the step
      const d = Math.abs(core.shapeADAA(sh, x0, x1, s) - core.shapeSample(sh, 0.5 * (x0 + x1), s));
      if (d > tiny) { tiny = d; tw = core.SHAPERS[fam] + ' ' + sub + ' Shape ' + s; }
    }
  }
  check('18. at tiny Shapes ADAA stays precise (agrees with the shaper at the midpoint)', tiny < 1e-5, 'worst ' + tiny.toExponential(1) + ' (' + tw + ')');
  // the Analog folder's table against the closed form
  let ta = 0;
  for (let i = 0; i <= 4000; i++) { const z = -10 + 20 * i / 4000; ta = Math.max(ta, Math.abs(core.analogTab.anaAt(z) - core.analogFold(z))); }
  check('18. the Analog folder table matches the Lambert W closed form', ta < 1e-4, 'worst ' + ta.toExponential(1));
  // ADAA of a step that stays put is the shaper itself, and Shape 0 is the plain average of the two samples
  setShaper(1, 1);
  check('18. ADAA: no change in input gives the shaper itself', Math.abs(core.shapeADAA(sh, 0.3, 0.3, 0.7) - core.shapeSample(sh, 0.3, 0.7)) < 1e-12);
  check('18. ADAA: Shape 0 is the average of the last two samples (half a sample of delay, as at any Shape)', core.shapeADAA(sh, 0.2, 0.6, 0) === 0.4);
}

/* ---------- 19. the residuals ---------- */
{
  // jump and kink residuals turn the box (ADAA) response into the triangle one: checked against
  // direct integration
  const integ = (f, a, b) => { const n = 4000, h = (b - a) / n; let s = 0; for (let i = 0; i < n; i++) s += f(a + (i + 0.5) * h); return s * h; };
  let worst = 0;
  for (const tau of [0.05, 0.3, 0.5, 0.71, 1]) for (const [J, S] of [[1, 0], [0, 1], [0.7, -0.4]]) {
    const ts = tau - 1, f = (t) => J * (t > ts ? 1 : 0) + S * Math.max(0, t - ts);
    const box = (m) => integ(f, m - 1, m), tri = (m) => integ((t) => f(t) * Math.max(0, 1 - Math.abs(t - (m - 0.5))), m - 1.5, m + 0.5);
    const r = core.residuals(tau, J, S);
    worst = Math.max(worst, Math.abs(r.m - (tri(-1) - box(-1))), Math.abs(r.o - (tri(0) - box(0))), Math.abs(r.p - (tri(1) - box(1))));
  }
  check('19. jump and kink residuals match the triangle-filtered response', worst < 1e-5, 'worst ' + worst.toExponential(1));
}

/* ---------- 20. aliasing ---------- */
{
  const { measure } = require(path.join(__dirname, '..', 'tools', 'alias.js'));
  const H = Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['h' + (i + 1) + '_1', 1 / (i + 1)]));
  const worstOf = (sets, notes) => { let w = -Infinity, at = ''; for (const [n, p] of sets) for (const m of notes) { const v = measure(p, m); if (v > w) { w = v; at = n + ' MIDI ' + m; } } return [w, at]; };
  // the CZ waves on their own, at full Warp, over the whole keyboard
  const plain = [['Saw', { wave1: 0 }], ['Square', { wave1: 1 }], ['Pulse', { wave1: 2 }], ['Double sine', { wave1: 3 }], ['Saw-pulse', { wave1: 4 }]].map(([n, p]) => [n, { ...p, warp1: 1 }]);
  let [w, at] = worstOf(plain, [24, 72, 108]);
  check('20. the five smooth CZ waves at full Warp: aliasing below −58 dB up to MIDI 108', w < -58, w.toFixed(1) + ' dB at worst (' + at + ')');
  [w, at] = worstOf([['Resonance', { wave1: 5, warp1: 1 }], ['Reso + Triangle window', { wave1: 5, window1: 2, warp1: 1 }], ['Double pulse', { wave1: 6, warp1: 1 }]], [72, 96, 108]);
  check('20. hard sync and jumps (Resonance, windows, Double pulse): below −45 dB up to MIDI 108 (was −16)', w < -45, w.toFixed(1) + ' dB at worst (' + at + ')');
  // every shaper on a fully warped Saw, up to MIDI 72
  const shapers = [['Chebyshev', { sfamily1: 0, shape1: 1, ...H }], ['Fold sine', { sfamily1: 1, fold1: 1, shape1: 0.5 }], ['Fold triangle', { sfamily1: 1, fold1: 0, shape1: 1 }],
    ['Fold analog', { sfamily1: 1, fold1: 2, shape1: 0.5 }], ['Tanh', { sfamily1: 2, sat1: 0, shape1: 0.7 }], ['Drawn', { sfamily1: 3, shape1: 1, morph1: 0.5 }]];
  [w, at] = worstOf(shapers.map(([n, p]) => [n, { ...p, wave1: 0, warp1: 1 }]), [24, 48, 72]);
  check('20. every shaper on a Saw at full Warp: below −60 dB up to MIDI 72', w < -60, w.toFixed(1) + ' dB at worst (' + at + ')');
  [w, at] = worstOf([['Chebyshev on Saw', { ...shapers[0][1], wave1: 0, warp1: 1 }]], [96, 108]);
  check('20. the Chebyshev fade: harmonics 1/k on a fully warped Saw stay below −55 dB at MIDI 96–108 (was −29)', w < -55, w.toFixed(1) + ' dB at worst (' + at + ')');
  [w, at] = worstOf([['Fold triangle on Square', { ...shapers[2][1], wave1: 1, warp1: 1 }], ['Fold triangle on Double pulse', { ...shapers[2][1], wave1: 6, warp1: 1 }]], [48, 108]);
  check('20. the hardest case, Triangle fold at gain 10 on a square-like wave: below −35 dB (was +13)', w < -35, w.toFixed(1) + ' dB at worst (' + at + ')');
}

console.log('\n' + (count - failed) + ' of ' + count + ' tests passed');
process.exit(failed ? 1 : 0);
