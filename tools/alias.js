// Alias energy per warp × shaper × note.
// A steady note is rendered at 48 kHz; a 65536-point Blackman-Harris spectrum is split into bins
// near a harmonic of the note (within ±6 bins) and everything else, from 20 Hz to 20 kHz. The
// result is the energy of everything else against the harmonics, in dB.
// Run: node tools/alias.js [--quick]   (also used by tests/engine-test.js)
'use strict';
const path = require('path');
const { PretzelEngine } = require(path.join(__dirname, '..', 'reference', 'pretzel-engine.js'));

const SR = 48000, N = 65536, SKIP = 0.3;

function fftReal(x) {        // in-place radix-2 on a copy; returns power spectrum (N/2 + 1)
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const P = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return P;
}
const WIN = new Float64Array(N);
for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / (N - 1); WIN[i] = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a); }

// a steady note with these settings: flat amp, no envelopes, no velocity or key effects
const STEADY = {
  lines: 0,
  velwarp1: 0, velamp1: 0, velshape1: 0, warpkey1: 0, shapekey1: 0, wenvdepth1: 0, senvdepth1: 0, link1: 0,
  aenv1t1: 0.002, aenv1l1: 1, aenv1t2: 0.01, aenv1l2: 1, aenv1sus: 2, aenv1end: 3,
};
function renderSteady(params, note) {
  const e = new PretzelEngine(SR, 1234);
  for (const k in STEADY) e.setParam(k, STEADY[k]);
  for (const k in params) e.setParam(k, params[k]);
  e.noteOn(note, 100);
  const skip = Math.round(SKIP * SR), n = skip + N, L = new Float32Array(n), tl = new Float32Array(128);
  for (let i = 0; i < n; i += 128) { const m = Math.min(128, n - i); e.process(tl, null, m); L.set(tl.subarray(0, m), i); }
  return L.subarray(skip);
}
function aliasDb(x, f0) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = x[i] * WIN[i];
  const P = fftReal(w), df = SR / N;
  let harm = 0, rest = 0;
  const lo = Math.ceil(20 / df), hi = Math.floor(20000 / df);
  for (let k = lo; k <= hi; k++) {
    const f = k * df, h = Math.round(f / f0);
    if (h >= 1 && Math.abs(f - h * f0) <= 6 * df) harm += P[k]; else rest += P[k];
  }
  return 10 * Math.log10(Math.max(rest, 1e-30) / Math.max(harm, 1e-30));
}
function measure(params, note) {
  return aliasDb(renderSteady(params, note), 440 * Math.pow(2, (note - 69) / 12));
}

// the matrix: every wave (Resonance with each CZ window too) × Warp × shaper
const WAVES = [
  ['Saw', { wave1: 0 }], ['Square', { wave1: 1 }], ['Pulse', { wave1: 2 }], ['Double sine', { wave1: 3 }],
  ['Saw-pulse', { wave1: 4 }], ['Reso', { wave1: 5 }], ['Reso+Saw', { wave1: 5, window1: 1 }],
  ['Reso+Tri', { wave1: 5, window1: 2 }], ['Reso+Trap', { wave1: 5, window1: 3 }], ['Double pulse', { wave1: 6 }],
];
// the out-of-bounds families (batch 06)
const FAMILIES = [
  ['Vector (0.2, 2.5)', { wfamily1: 1, vecx1: 0.2, vecy1: 2.5 }], ['Vector (0.8, 3.5)', { wfamily1: 1, vecx1: 0.8, vecy1: 3.5 }],
  ['Power', { wfamily1: 2, curve1: 0 }], ['Sigmoid', { wfamily1: 2, curve1: 1 }], ['Bezier', { wfamily1: 2, curve1: 2, vecx1: 0.1, vecy1: 3.6 }],
  ['Sync 7.3', { wfamily1: 3, ratio1: 7.3 }], ['Sync 7.3 + Tri', { wfamily1: 3, ratio1: 7.3, window1: 2 }],
];
const HARM = Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['h' + (i + 1) + '_1', 1 / (i + 1)]));
const SHAPERS = [
  ['none', { sfamily1: 0, shape1: 0 }],
  ['Cheb', { sfamily1: 0, shape1: 1, ...HARM }],
  ['Fold sine ½', { sfamily1: 1, fold1: 1, shape1: 0.5 }],
  ['Fold tri 1', { sfamily1: 1, fold1: 0, shape1: 1 }],
  ['Fold analog ½', { sfamily1: 1, fold1: 2, shape1: 0.5 }],
  ['Tanh 0.7', { sfamily1: 2, sat1: 0, shape1: 0.7 }],
  ['Drawn ½', { sfamily1: 3, shape1: 1, morph1: 0.5 }],
];
const NOTES = [24, 48, 72, 96, 108];

if (require.main === module) {
  if (process.argv.includes('--orders')) {
    // the orders (batch 07) on a few waves at full Warp
    const ORD = [['S→W A', { order1: 1, swmode1: 0 }], ['S→W B', { order1: 1, swmode1: 1 }], ['Morph ½ shared A', { order1: 2, ordermorph1: 0.5, morphway1: 1, swmode1: 0 }], ['Morph ½ shared B', { order1: 2, ordermorph1: 0.5, morphway1: 1, swmode1: 1 }]];
    const W = [['Saw', { wave1: 0 }], ['Square', { wave1: 1 }], ['Reso+Tri', { wave1: 5, window1: 2 }], ['Vector (0.2, 2.5)', FAMILIES[0][1]], ['Sync 7.3', FAMILIES[5][1]]];
    console.log('alias energy, dB below the harmonics (20 Hz – 20 kHz), Warp 1; notes ' + NOTES.join(', '));
    let worst = -Infinity, wn = '';
    for (const [on, op] of ORD) for (const [sn, sp] of SHAPERS.slice(1)) for (const [wname, wp] of W) {
      const row = NOTES.map((n) => measure({ ...wp, ...sp, ...op, warp1: 1 }, n));
      const m = Math.max(...row); if (m > worst) { worst = m; wn = on + ' · ' + sn + ' · ' + wname + ' · MIDI ' + NOTES[row.indexOf(m)]; }
      console.log((on + ' · ' + sn + ' · ' + wname).padEnd(46), row.map((v) => v.toFixed(0).padStart(5)).join(''));
    }
    console.log('\nworst: ' + worst.toFixed(1) + ' dB  (' + wn + ')');
    process.exit(0);
  }
  const quick = process.argv.includes('--quick');
  const only = process.argv.includes('--families');
  const waves = only ? FAMILIES : WAVES.concat(FAMILIES);
  const warps = quick ? [1] : [0.5, 1];
  const notes = quick ? [48, 96] : NOTES;
  console.log('alias energy, dB below the harmonics (20 Hz – 20 kHz); notes ' + notes.join(', '));
  let worst = -Infinity, worstName = '';
  for (const [sn, sp] of SHAPERS) for (const [wn, wp] of waves) for (const wa of warps) {
    const row = notes.map((n) => measure({ ...wp, ...sp, warp1: wa }, n));
    const m = Math.max(...row);
    if (m > worst) { worst = m; worstName = sn + ' · ' + wn + ' · Warp ' + wa + ' · MIDI ' + notes[row.indexOf(m)]; }
    console.log((sn + ' · ' + wn + ' · Warp ' + wa).padEnd(36), row.map((v) => v.toFixed(0).padStart(5)).join(''));
  }
  console.log('\nworst: ' + worst.toFixed(1) + ' dB  (' + worstName + ')');
}
module.exports = { measure, renderSteady, aliasDb, WAVES, FAMILIES, SHAPERS, NOTES };
