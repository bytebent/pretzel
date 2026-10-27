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
  check('8b. narrow pulses (Pulse, Double pulse at Warp 0.75 and 1) no more than 12 dB down', slo > -12, slo.toFixed(1) + ' dB at worst (16.3 dB down without evening out)');
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

console.log('\n' + (count - failed) + ' of ' + count + ' tests passed');
process.exit(failed ? 1 : 0);
