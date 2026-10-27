# Pretzel

A synth by bytebent that bends a wave on both axes. Phase distortion, in the style of the Casio
CZ, bends **time**: how fast each part of the cycle is read. Waveshaping bends **level**:
Chebyshev harmonics, folding, saturation or a drawn curve. Pretzel chains the two, lets you swap
or morph their order, and can feed the shaped wave back into its own phase (Twist).

Status: **prototype, batch 03 of 13**. The reference engine plays one line: the CZ-style warp (all the CZ waves and windows, the hidden ones, a window on any wave, wave pairs) into the shaper (Chebyshev, three folders, three saturators, drawn curves with Morph), with 8-stage Warp, Shape and Amp envelopes and Link, in Poly or Mono. Next: band limiting.

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
