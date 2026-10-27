// Performance benchmark for the reference engine. Run: node tools/perf.js [seconds]
// Prints how much of one CPU core each scenario needs to run in real time at 48 kHz.
// Runs on GitHub Actions on an Intel Mac (macos-26-intel) on every push: .github/workflows/mac.yml.
// This is the JS reference; the C++ port will be faster, but the ratios between scenarios carry over.
'use strict';
const path = require('path');
const { PretzelEngine } = require(path.join(__dirname, '..', 'reference', 'pretzel-engine.js'));

const SR = 48000, SECS = +process.argv[2] || 3, BL = 128;
const H16 = Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['h' + (i + 1) + '_1', 1 / (i + 1)]));
// a held note at full level, envelopes parked at their sustain
const HELD = { aenv1t1: 0.005, aenv1l1: 1, aenv1t2: 0.01, aenv1l2: 1, aenv1sus: 2, aenv1end: 3, wenvdepth1: 0, senvdepth1: 0, velamp1: 0 };
const chord8 = [48, 55, 60, 64, 67, 71, 74, 79];
const high8 = chord8.map((n) => n + 24);
// "moving" scenarios sweep Warp, Shape and Morph like an LFO, so nothing settles
const MOVE = (e, t) => {
  e.setParam('warp1', 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t));
  e.setParam('shape1', 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.1 * t));
  e.setParam('morph1', 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.3 * t));
};
const SCENARIOS = [
  ['Silent (no notes)', {}, [], null],
  ['1 voice, Saw, Warp 0.7, no shaper', { wave1: 0, warp1: 0.7 }, [60], null],
  ['1 voice, Chebyshev 16 harmonics, Shape 1', { wave1: 0, warp1: 0.7, sfamily1: 0, shape1: 1, ...H16 }, [60], null],
  ['1 voice, Fold Triangle, Shape 1', { wave1: 0, warp1: 0.7, sfamily1: 1, fold1: 0, shape1: 1 }, [60], null],
  ['1 voice, Fold Sine, Shape 0.6', { wave1: 0, warp1: 0.7, sfamily1: 1, fold1: 1, shape1: 0.6 }, [60], null],
  ['1 voice, Fold Analog, Shape 0.6', { wave1: 0, warp1: 0.7, sfamily1: 1, fold1: 2, shape1: 0.6 }, [60], null],
  ['1 voice, Tanh, Shape 0.7', { wave1: 0, warp1: 0.7, sfamily1: 2, sat1: 0, shape1: 0.7 }, [60], null],
  ['1 voice, Drawn, Morph moving', { wave1: 0, warp1: 0.7, sfamily1: 3, shape1: 1 }, [60], MOVE],
  ['1 voice, Reso + Triangle window into Fold, MIDI 96', { wave1: 5, window1: 2, warp1: 1, sfamily1: 1, fold1: 1, shape1: 0.6 }, [96], null],
  ['1 voice, Double pulse into Chebyshev, MIDI 96', { wave1: 6, warp1: 1, sfamily1: 0, shape1: 1, ...H16 }, [96], null],
  ['8 voices, Saw, no shaper', { wave1: 0, warp1: 0.7 }, chord8, null],
  ['8 voices, Chebyshev 16, everything moving', { wave1: 0, sfamily1: 0, ...H16 }, chord8, MOVE],
  ['8 voices, Tanh, everything moving', { wave1: 0, sfamily1: 2, sat1: 0 }, chord8, MOVE],
  ['8 voices, Fold Analog, everything moving', { wave1: 0, sfamily1: 1, fold1: 2 }, chord8, MOVE],
  ['8 voices, Shape → Warp A, Sine fold, moving', { wave1: 0, sfamily1: 1, fold1: 1, order1: 1, swmode1: 0 }, chord8, MOVE],
  ['8 voices, Morph shared (both shapers), Sine fold, moving', { wave1: 0, sfamily1: 1, fold1: 1, order1: 2, ordermorph1: 0.5, morphway1: 1 }, chord8, MOVE],
  ['8 voices, Double pulse + window into Drawn, moving, high', { wave1: 6, pair1: 6, window1: 2, sfamily1: 3, keys1: 4 }, high8, MOVE],
];

function run(params, notes, move) {
  const e = new PretzelEngine(SR, 1);
  for (const k in HELD) e.setParam(k, HELD[k]);
  for (const k in params) e.setParam(k, params[k]);
  for (const n of notes) e.noteOn(n, 100);
  const L = new Float32Array(BL), R = new Float32Array(BL);
  for (let i = 0; i < SR * 0.25; i += BL) { if (move) move(e, i / SR); e.process(L, R, BL); }   // warm up the JIT
  const total = Math.round(SR * SECS / BL) * BL;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < total; i += BL) { if (move) move(e, i / SR); e.process(L, R, BL); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return ms / (total / SR * 1000);                                        // share of real time
}

const rows = [];
for (const [name, p, notes, move] of SCENARIOS) rows.push([name, Math.min(run(p, notes, move), run(p, notes, move), run(p, notes, move)), notes.length]);
const w = Math.max(...rows.map((r) => r[0].length));
const out = [];
out.push('pretzel reference engine · ' + SR / 1000 + ' kHz · ' + SECS + ' s per run · best of three · Node ' + process.version);
out.push('Scenario'.padEnd(w) + '   CPU   per voice');
const silent = rows[0][1];
for (const [name, f, n] of rows) out.push(name.padEnd(w) + '  ' + (f * 100).toFixed(1).padStart(5) + '%' + (n ? ((f - silent) / n * 100).toFixed(1).padStart(9) + '%' : ''));
// a full voice has two lines and Twist (batches 08–09): projected as two lines plus 30% for Twist,
// from the most expensive 8-voice scenario
const worst = rows.filter((r) => r[2] === 8).reduce((a, r) => (r[1] > a[1] ? r : a));
const perLine = (worst[1] - silent) / worst[2];
out.push('');
out.push('Worst 8-voice case: ' + worst[0]);
out.push('Projected full voice (two lines + Twist, 2 × line × 1.3): ' + (perLine * 2.6 * 100).toFixed(1) + '% per voice, ' +
  ((silent + perLine * 2.6 * 8) * 100).toFixed(0) + '% of one core for 8 voices');
console.log(out.join('\n'));
