// Test presets: for the bench and the tests only, not the plugin build.
// Each has the settings and a short phrase: [note (MIDI), start (s), length (s), velocity?].
// steps: parameter changes at given times. design: the design.md §11 preset it is, if any.
(function (root) {
  'use strict';

  // an 8-stage envelope as params: env('wenv', 1, [[time, level], ...], sustain, end)
  function env(name, line, stages, sus, end) {
    const o = {};
    stages.forEach(([t, l], i) => { o[name + line + 't' + (i + 1)] = t; o[name + line + 'l' + (i + 1)] = l; });
    o[name + line + 'sus'] = sus; o[name + line + 'end'] = end;
    return o;
  }
  const chord = (notes, t, d, vel) => notes.map(n => [n, t, d, vel || 100]);
  // one note per wave or window, each sweeping Warp 0 → 1 → 0
  const sweepEnv = env('wenv', 1, [[0.6, 1], [0.6, 0]], 0, 2);

  const PRESETS = [
    {
      name: 'CZ Brass',
      design: true,
      about: 'Saw, the Warp envelope opens on each attack and settles. Shape 0: the CZ core alone. Four-note chords, so Volume is 6 dB down to match the single-note presets.',
      params: {
        wave1: 0, warp1: 0, velwarp1: 0.4, volume: -12,
        ...env('wenv', 1, [[0.07, 0.8], [0.5, 0.5], [0.25, 0]], 2, 3),
        ...env('aenv', 1, [[0.03, 1], [0.6, 0.85], [0.25, 0]], 2, 3),
      },
      phrase: [
        ...chord([48, 55, 60, 64], 0, 0.9, 110), ...chord([50, 57, 62, 65], 1.0, 0.9, 95),
        ...chord([52, 55, 60, 67], 2.0, 0.45, 120), ...chord([53, 57, 60, 69], 2.5, 1.4, 110),
      ],
    },
    {
      name: 'CZ Reso Sweep',
      design: true,
      about: 'Resonance with the Triangle window (the CZ\'s Reso 2). A slow Warp envelope sweeps the formant up and back down.',
      params: {
        wave1: 5, window1: 2, warp1: 0, warpkey1: 0,
        ...env('wenv', 1, [[2.0, 1], [2.0, 0.05]], 0, 2),
        ...env('aenv', 1, [[0.01, 1], [3.8, 0.8], [0.4, 0]], 2, 3),
      },
      phrase: [[36, 0, 4.0], [43, 0, 4.0]],
    },
    {
      name: 'Wave tour',
      about: 'Each wave in turn: Saw, Square, Pulse, Double sine, Saw-pulse, Resonance (no window), Double pulse. Warp sweeps 0 → 1 → 0 on each.',
      params: { warp1: 0, warpkey1: 0, velwarp1: 0, ...sweepEnv, ...env('aenv', 1, [[0.01, 1], [1.2, 1], [0.05, 0]], 2, 3) },
      phrase: [0, 1, 2, 3, 4, 5, 6].map(i => [48, i * 1.3, 1.2]),
      steps: [0, 1, 2, 3, 4, 5, 6].map(i => ({ time: i * 1.3 - 0.01, params: { wave1: i } })),
    },
    {
      name: 'Window tour',
      about: 'Resonance through each window: None, Saw, Triangle, Trapezoid, and the hidden Pulse and Double saw. Warp sweeps 0 → 1 → 0 on each.',
      params: { wave1: 5, warp1: 0, warpkey1: 0, velwarp1: 0, ...sweepEnv, ...env('aenv', 1, [[0.01, 1], [1.2, 1], [0.05, 0]], 2, 3) },
      phrase: [0, 1, 2, 3, 4, 5].map(i => [45, i * 1.3, 1.2]),
      steps: [0, 1, 2, 3, 4, 5].map(i => ({ time: i * 1.3 - 0.01, params: { window1: i } })),
    },
    {
      name: 'Windowed saw',
      about: 'A window on a wave the CZ never windows: Saw, then Square, through the Triangle window. The chip allows it; Pretzel keeps it.',
      params: { wave1: 0, window1: 2, warp1: 0.2, warpkey1: 0, ...env('wenv', 1, [[0.4, 0.9], [1.2, 0.3]], 0, 2), ...env('aenv', 1, [[0.02, 1], [1.4, 0.9], [0.2, 0]], 2, 3) },
      phrase: [[40, 0, 1.6], [40, 1.8, 1.6]],
      steps: [{ time: 1.79, params: { wave1: 1 } }],
    },
    {
      name: 'Wave pair',
      about: 'Saw alone, then Saw paired with Pulse: alternating waves each cycle halve the pitch and add a sub-octave buzz.',
      params: { wave1: 0, pair1: 0, warp1: 0.55, wenvdepth1: 0.3, warpkey1: 0, ...env('wenv', 1, [[0.5, 1], [1.0, 0]], 0, 2), ...env('aenv', 1, [[0.02, 1], [1.4, 0.9], [0.2, 0]], 2, 3) },
      phrase: [[57, 0, 1.6], [57, 1.8, 1.6]],
      steps: [{ time: 1.79, params: { pair1: 3 } }],
    },
    {
      name: 'Square lead (mono)',
      about: 'Square in Mono with glide: legato notes slide and keep their envelopes running.',
      params: {
        mode: 0, glide: 0.06, wave1: 1, warp1: 0.35, wenvdepth1: 0.5, transpose: 12,
        ...env('wenv', 1, [[0.15, 1], [0.6, 0.4]], 2, 3),
        ...env('aenv', 1, [[0.01, 1], [0.3, 0.85], [0.3, 0]], 2, 3),
      },
      phrase: [[60, 0, 0.5], [63, 0.4, 0.5], [67, 0.8, 0.3], [70, 1.05, 0.6], [68, 1.6, 0.25], [67, 1.8, 1.0]],
    },

    // ---------- batch 03: the shaper ----------
    {
      name: 'Organ Pretzel',
      design: true,
      about: 'Warp 0 (a pure cosine) into Chebyshev at Shape 1: a drawbar set of exact harmonics 1, 2, 3, 4, 6, 8 and 12. The shaper alone.',
      params: {
        wave1: 0, warp1: 0, wenvdepth1: 0, sfamily1: 0, shape1: 1, shapekey1: 0, velshape1: 0, velamp1: 0.3, volume: -12,
        h1_1: 1, h2_1: 0.7, h3_1: 0.5, h4_1: 0.35, h6_1: 0.25, h8_1: 0.3, h12_1: 0.15,
        ...env('aenv', 1, [[0.004, 1], [0.1, 1], [0.08, 0]], 2, 3),
      },
      phrase: [...chord([48, 55, 64, 67], 0, 1.2), ...chord([50, 57, 65, 69], 1.3, 1.2), ...chord([43, 55, 62, 71], 2.6, 1.6)],
    },
    {
      name: 'Linked',
      design: true,
      about: 'Saw into Chebyshev (odd harmonics), Link 1: the Warp envelope opens both axes at once, so each attack bends time and level together.',
      params: {
        wave1: 0, warp1: 0, sfamily1: 0, shape1: 0, senvdepth1: 0, link1: 1, warpkey1: 0.2, shapekey1: 0.2,
        h1_1: 1, h3_1: 0.6, h5_1: 0.4, h7_1: 0.3, h9_1: 0.2,
        ...env('wenv', 1, [[0.12, 1], [0.9, 0.25], [0.3, 0]], 2, 3),
        ...env('aenv', 1, [[0.01, 1], [0.8, 0.8], [0.3, 0]], 2, 3),
      },
      phrase: [[40, 0, 0.8], [43, 0.9, 0.4], [45, 1.4, 0.4], [47, 1.9, 1.2], [52, 3.2, 1.0]],
    },
    {
      name: 'Folded Saw',
      design: true,
      about: 'A gently warped Saw into the Sine folder; the Shape envelope sweeps the fold gain up to 10 and back. Not band-limited yet (batch 04): high folds alias.',
      params: {
        wave1: 0, warp1: 0.25, wenvdepth1: 0, sfamily1: 1, fold1: 1, shape1: 0, senvdepth1: 1, shapekey1: 0,
        ...env('senv', 1, [[1.6, 1], [1.6, 0.15]], 0, 2),
        ...env('aenv', 1, [[0.02, 1], [3.0, 0.9], [0.4, 0]], 2, 3),
      },
      phrase: [[36, 0, 3.3], [43, 0, 3.3]],
    },
    {
      name: 'Shaper tour',
      about: 'A pure cosine (Warp 0) through each shaper, Shape sweeping 0 → 1 → 0: Chebyshev (harmonics 1/k), Fold Triangle, Sine, Analog, Saturate Tanh, Arctan, Cubic, Drawn (terraces).',
      params: {
        wave1: 0, warp1: 0, wenvdepth1: 0, shape1: 0, senvdepth1: 1, shapekey1: 0, velshape1: 0, morph1: 1 / 3,
        ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['h' + (i + 1) + '_1', 1 / (i + 1)])),
        ...env('senv', 1, [[0.6, 1], [0.6, 0]], 0, 2),
        ...env('aenv', 1, [[0.01, 1], [1.2, 1], [0.05, 0]], 2, 3),
      },
      phrase: [0, 1, 2, 3, 4, 5, 6, 7].map(i => [48, i * 1.3, 1.2]),
      steps: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 2, 0], [2, 0, 0], [2, 0, 1], [2, 0, 2], [3, 0, 0]]
        .map(([f, fo, sa], i) => ({ time: i * 1.3 - 0.01, params: { sfamily1: f, fold1: fo, sat1: sa } })),
    },
    {
      name: 'Drawn morph',
      about: 'A lightly warped Saw through the drawn keyframes at Shape 1, Morph moving slowly through all four: soft S, terraces, sine fold, full-wave rectifier (an octave up).',
      params: {
        wave1: 0, warp1: 0.15, wenvdepth1: 0, sfamily1: 3, shape1: 1, shapekey1: 0, velshape1: 0, morph1: 0,
        ...env('aenv', 1, [[0.05, 1], [6, 1], [0.4, 0]], 2, 3),
      },
      phrase: [[45, 0, 6.2], [52, 0, 6.2]],
      sweeps: [{ id: 'morph1', from: 0, to: 1, start: 0.3, end: 5.9 }],
    },
    {
      name: 'Bias',
      about: 'A pure cosine into Tanh at Shape 0.6. Bias 0 gives odd harmonics only; Bias moves to +0.8 and then −0.8, bringing in even harmonics.',
      params: {
        wave1: 0, warp1: 0, wenvdepth1: 0, sfamily1: 2, sat1: 0, shape1: 0.6, shapekey1: 0, velshape1: 0, bias1: 0,
        ...env('aenv', 1, [[0.05, 1], [6, 1], [0.4, 0]], 2, 3),
      },
      phrase: [[48, 0, 6.2]],
      sweeps: [{ id: 'bias1', from: 0, to: 0.8, start: 1, end: 3 }, { id: 'bias1', from: 0.8, to: -0.8, start: 3.5, end: 5.5 }],
    },
    {
      name: 'Tilt and Odd-Even',
      about: 'All 16 Chebyshev harmonics at full, Shape 1. Tilt sweeps from dark (−1) to bright (+1) and back to 0; then Odd/Even sweeps from odd-only cut (−1, hollow octaves) to even cut (+1, a square-like tone).',
      params: {
        wave1: 0, warp1: 0, wenvdepth1: 0, sfamily1: 0, shape1: 1, shapekey1: 0, velshape1: 0, tilt1: -1, oddeven1: 0,
        ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['h' + (i + 1) + '_1', 1])),
        ...env('aenv', 1, [[0.05, 1], [7, 1], [0.4, 0]], 2, 3),
      },
      phrase: [[43, 0, 7.0]],
      sweeps: [{ id: 'tilt1', from: -1, to: 1, start: 0.3, end: 3.0 }, { id: 'tilt1', from: 1, to: 0, start: 3.0, end: 3.5 },
        { id: 'oddeven1', from: -1, to: 1, start: 3.6, end: 6.8 }],
    },

    // ---------- batch 04: band limiting ----------
    {
      name: 'Up high',
      about: 'A run up to MIDI 103, twice: a warped Saw into the Sine folder, then hard-synced Resonance (no window). Where aliasing used to be loudest; key follow off so nothing hides it.',
      params: {
        wave1: 0, warp1: 0.7, wenvdepth1: 0, warpkey1: 0, sfamily1: 1, fold1: 1, shape1: 0.6, shapekey1: 0, velshape1: 0, velwarp1: 0,
        mode: 0, glide: 0,
        ...env('aenv', 1, [[0.005, 1], [0.2, 0.9], [0.05, 0]], 2, 3),
      },
      phrase: [...[60, 67, 72, 79, 84, 91, 96, 103].map((n, i) => [n, i * 0.3, 0.28]), ...[60, 67, 72, 79, 84, 91, 96, 103].map((n, i) => [n, 2.6 + i * 0.3, 0.28])],
      steps: [{ time: 2.55, params: { wave1: 5, warp1: 0.85, sfamily1: 0, shape1: 0 } }],
    },

    // ---------- batch 06: out-of-bounds warps ----------
    {
      name: 'Vowel',
      design: true,
      about: 'Vector at Warp 1 with v = 2.5: the first part of each cycle reads 2.5 cycles, a formant. d sweeps from 0.1 to 0.9 and back, moving the formant like a vowel. (The design puts d on the mod wheel; that comes in batch 09, so a sweep stands in.)',
      params: {
        wfamily1: 1, vecx1: 0.1, vecy1: 2.5, warp1: 1, wenvdepth1: 0, warpkey1: 0, velwarp1: 0, volume: -12,
        ...env('aenv', 1, [[0.15, 1], [6, 0.9], [0.6, 0]], 2, 3),
      },
      phrase: [...chord([45, 52, 57, 60], 0, 6.2, 90)],
      sweeps: [{ id: 'vecx1', from: 0.1, to: 0.9, start: 0.2, end: 3.2 }, { id: 'vecx1', from: 0.9, to: 0.1, start: 3.2, end: 6.0 }],
    },
    {
      name: 'Vector bass',
      about: 'Vector at (0.15, 3.5) into a little Tanh: the Warp envelope plucks each note from a pure cosine to a hard formant and back.',
      params: {
        wfamily1: 1, vecx1: 0.15, vecy1: 3.5, warp1: 0, wenvdepth1: 1, warpkey1: 0, velwarp1: 0.4,
        sfamily1: 2, sat1: 0, shape1: 0.35, shapekey1: 0,
        ...env('wenv', 1, [[0.005, 1], [0.35, 0.15]], 2, 3),
        ...env('aenv', 1, [[0.003, 1], [0.6, 0.6], [0.08, 0]], 2, 3),
      },
      phrase: [[33, 0, 0.3], [33, 0.4, 0.15], [45, 0.6, 0.2], [36, 0.9, 0.35], [38, 1.3, 0.3], [40, 1.7, 0.7]],
    },
    {
      name: 'Smooth tour',
      about: 'The three Smooth curves, each with Warp sweeping 0 → 1 → 0: Power (the cosine pushed to the end of the cycle), Sigmoid (squeezed into the middle), Bezier (handles at (0.1, 0.9): a rounded square). No corners anywhere.',
      params: {
        wfamily1: 2, curve1: 0, vecx1: 0.1, vecy1: 3.6, warp1: 0, warpkey1: 0, velwarp1: 0,
        ...env('wenv', 1, [[0.9, 1], [0.9, 0]], 0, 2), ...env('aenv', 1, [[0.01, 1], [1.8, 1], [0.05, 0]], 2, 3),
      },
      phrase: [0, 1, 2].map((i) => [45, i * 1.9, 1.8]),
      steps: [0, 1, 2].map((i) => ({ time: i * 1.9 - 0.01, params: { curve1: i } })),
    },
    {
      name: 'Sync sweep',
      about: 'Sync to ratio 12: the Warp envelope sweeps the synced cosine up on each note. Plain first (the hard-sync edge), then through the Triangle window (a smooth, vocal sweep).',
      params: {
        wfamily1: 3, ratio1: 12, warp1: 0, wenvdepth1: 1, warpkey1: 0, velwarp1: 0, window1: 0,
        ...env('wenv', 1, [[1.2, 1], [0.6, 0.6]], 2, 3), ...env('aenv', 1, [[0.01, 1], [1.5, 0.9], [0.2, 0]], 2, 3),
      },
      phrase: [[40, 0, 1.6], [47, 1.8, 1.6], [40, 3.6, 1.6], [47, 5.4, 1.6]],
      steps: [{ time: 3.55, params: { window1: 2 } }],
    },
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = { PRESETS, env };
  else root.PretzelPresets = PRESETS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
