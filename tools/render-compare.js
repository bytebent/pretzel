// Listening comparisons for the order choices (batch 07): each file plays the same phrase twice,
// first one way then the other, with half a second between.
// Run: node tools/render-compare.js [out-dir]   (default renders/compare)
'use strict';
const fs = require('fs'), path = require('path');
const { renderPreset, wav24 } = require(path.join(__dirname, 'render-presets.js'));
const { env } = require(path.join(__dirname, '..', 'reference', 'presets.js'));

const SR = 48000;
const outDir = process.argv[2] || path.join(__dirname, '..', 'renders', 'compare');
fs.mkdirSync(outDir, { recursive: true });

const H = (list) => Object.fromEntries(list.map((v, i) => ['h' + (i + 1) + '_1', v]));
const chord = (notes, t, d) => notes.map((n) => [n, t, d, 95]);
const PLUCK = { ...env('senv', 1, [[0.01, 1], [0.7, 0.2]], 2, 3), ...env('aenv', 1, [[0.005, 1], [0.8, 0.7], [0.15, 0]], 2, 3) };
const PAD = { ...env('senv', 1, [[1.2, 1], [1.0, 0.6]], 2, 3), ...env('aenv', 1, [[0.3, 1], [2, 0.9], [0.5, 0]], 2, 3) };
const HOLD = env('aenv', 1, [[0.05, 1], [6, 1], [0.3, 0]], 2, 3);
const COMMON = { lines: 0, warpkey1: 0, shapekey1: 0, velshape1: 0, velwarp1: 0, wenvdepth1: 0 };

// Shape → Warp: A then B
const AB = [
  ['Saw, Chebyshev odd harmonics, plucked bass', { wave1: 0, warp1: 0.55, sfamily1: 0, shape1: 0, senvdepth1: 1, ...H([1, 0, 0.6, 0, 0.4, 0, 0.25]), ...PLUCK },
    [[33, 0, 0.35], [33, 0.45, 0.2], [40, 0.7, 0.35], [45, 1.1, 0.35], [43, 1.5, 0.8]]],
  ['Square, Tanh, pad chord', { wave1: 1, warp1: 0.4, sfamily1: 2, sat1: 0, shape1: 0.2, senvdepth1: 0.6, volume: -12, ...PAD }, chord([48, 55, 60, 64], 0, 2.4)],
  ['Vector (0.2, 2.5), Sine fold, lead', { wfamily1: 1, vecx1: 0.2, vecy1: 2.5, warp1: 0.8, sfamily1: 1, fold1: 1, shape1: 0.15, senvdepth1: 0.5, mode: 0, glide: 0.05, ...PLUCK },
    [[60, 0, 0.3], [63, 0.3, 0.3], [67, 0.6, 0.3], [70, 0.9, 0.5], [67, 1.4, 0.8]]],
  ['Resonance + Triangle window, Analog fold, slow swell', { wave1: 5, window1: 2, warp1: 0.6, sfamily1: 1, fold1: 2, shape1: 0, senvdepth1: 0.9, ...PAD }, [[41, 0, 2.4]]],
  ['Sync 7.3, Drawn (terraces to sine fold), arpeggio', { wfamily1: 3, ratio1: 7.3, warp1: 0.7, sfamily1: 3, morph1: 0.5, shape1: 0.2, senvdepth1: 0.8, ...PLUCK },
    [57, 60, 64, 69, 72, 69, 64, 60].map((n, i) => [n, i * 0.25, 0.22])],
  ['Saw, Triangle fold, slow sweep (the hardest case)', { wave1: 0, warp1: 0.6, sfamily1: 1, fold1: 0, shape1: 0, senvdepth1: 1, ...env('senv', 1, [[2.2, 1]], 0, 1), ...HOLD }, [[45, 0, 2.4]]],
];
// Morph: through the warp, then shared (definition B), Morph sweeping 0 → 1 → 0
const WAYS = [
  ['Saw, Chebyshev', { wave1: 0, warp1: 0.6, sfamily1: 0, shape1: 0.9, ...H([1, 0.5, 0.6, 0.3, 0.4, 0.2, 0.25, 0.1]) }],
  ['Square, Tanh', { wave1: 1, warp1: 0.45, sfamily1: 2, sat1: 0, shape1: 0.7 }],
  ['Vector (0.2, 2.5), Sine fold', { wfamily1: 1, vecx1: 0.2, vecy1: 2.5, warp1: 0.8, sfamily1: 1, fold1: 1, shape1: 0.55 }],
  ['Pulse, Analog fold', { wave1: 2, warp1: 0.45, sfamily1: 1, fold1: 2, shape1: 0.6 }],
  ['Saw-pulse, Drawn (soft S to terraces)', { wave1: 4, warp1: 0.6, sfamily1: 3, morph1: 0.2, shape1: 1 }],
];

function both(name, a, b, phrase, sweeps, len) {
  const r1 = renderPreset({ params: a, phrase, sweeps }), r2 = renderPreset({ params: b, phrase, sweeps });
  const n1 = Math.round(len * SR), gap = Math.round(0.5 * SR);
  const L = new Float32Array(2 * n1 + gap);
  L.set(r1.L.subarray(0, Math.min(n1, r1.L.length)), 0);
  L.set(r2.L.subarray(0, Math.min(n1, r2.L.length)), n1 + gap);
  fs.writeFileSync(path.join(outDir, name + '.wav'), wav24(L, L));
  let pk = 0; for (const v of L) pk = Math.max(pk, Math.abs(v));
  console.log(name.padEnd(80), 'peak', pk.toFixed(2));
}
AB.forEach(([n, p, phrase], i) => {
  const end = Math.max(...phrase.map(([, t, d]) => t + d)) + 0.5;
  both('A' + (i + 1) + ' ' + n + ' (A then B)', { ...COMMON, ...p, order1: 1, swmode1: 0 }, { ...COMMON, ...p, order1: 1, swmode1: 1 }, phrase, null, end);
});
WAYS.forEach(([n, p], i) => {
  const sweeps = [{ id: 'ordermorph1', from: 0, to: 1, start: 0.2, end: 2.0 }, { id: 'ordermorph1', from: 1, to: 0, start: 2.0, end: 3.8 }];
  const base = { ...COMMON, ...p, ...HOLD, order1: 2, ordermorph1: 0, swmode1: 1, volume: -9 };
  both('M' + (i + 1) + ' ' + n + ' (through the warp, then shared)', { ...base, morphway1: 0 }, { ...base, morphway1: 1 }, [[45, 0, 4.0], [52, 0, 4.0]], sweeps, 4.4);
});
