# Pretzel

A synth by bytebent that bends a wave on both axes. Phase distortion, in the style of the Casio
CZ, bends **time**: how fast each part of the cycle is read. Waveshaping bends **level**:
Chebyshev harmonics, folding, saturation or a drawn curve. Pretzel chains the two, lets you swap
or morph their order, and can feed the shaped wave back into its own phase (Twist).

Status: **prototype, batch 09 of 13**. The reference engine plays the whole voice: two lines (1, 2, 1+1′, 1+2, Ring, Noise), each a warp (the CZ waves and windows, the hidden ones, a window on any wave, wave pairs; and the Vector, Smooth and Sync families) and a shaper (Chebyshev, three folders, three saturators, drawn curves with Morph) in either order or morphing between them, with Twist feeding the shaped wave back into its own phase; 8-stage Pitch, Warp, Shape and Amp envelopes per line; 2 LFOs, 2 mod envelopes, the mod wheel and aftertouch per voice; Poly or Mono. The whole chain is band-limited. Every push runs the tests and the benchmark on GitHub's Intel Mac. Next: the browser bench.

- `design.md`: what Pretzel is and how it works
- `plan.md`: build batches
- `research.md`: sources
- `tests.md`: what's been tested and the results

The CZ wave formulas are ported from MAME's µPD933 emulation by Devin Acker (BSD-3-Clause).

## Try it

Needs Node 18 or newer. No packages to install.

```sh
node tests/engine-test.js        # engine tests
node tools/render-presets.js     # test presets → renders/*.wav
node tools/alias.js              # aliasing table, about a minute
node tools/perf.js               # CPU per scenario
```

## Performance

Every push runs the tests, the benchmark and the renders on GitHub's Intel Mac (`macos-26-intel`,
an i7-8700B); the numbers are on the run's summary page. The JavaScript reference needs 3–8% of
one core per voice for one line, 43–46% for 8 voices in the worst case. Poly has 8 voices.
