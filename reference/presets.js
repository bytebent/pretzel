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
      about: 'Saw, the Warp envelope opens on each attack and settles. Shape 0: the CZ core alone.',
      params: {
        wave1: 0, warp1: 0, velwarp1: 0.4,
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
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = { PRESETS, env };
  else root.PretzelPresets = PRESETS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
