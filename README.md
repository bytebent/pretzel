# Pretzel

A synth by bytebent that bends a wave on both axes. Phase distortion, in the style of the Casio
CZ, bends **time**: how fast each part of the cycle is read. Waveshaping bends **level**:
Chebyshev harmonics, folding, saturation or a drawn curve. Pretzel chains the two, lets you swap
or morph their order, and can feed the shaped wave back into its own phase (Twist).

Status: **prototype, batch 02 of 13**. The reference engine plays one line with the CZ-style warp: all the CZ waves and windows (and the hidden ones), a window on any wave, wave pairs, and 8-stage Warp and Amp envelopes, in Poly or Mono. Next: the shaper.

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
```
