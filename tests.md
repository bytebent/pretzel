# Pretzel · tests

Quick results per batch: tests, experiments and pictures. Pictures live in `docs/tests/`. Run the
tests with `node tests/engine-test.js`. Presets are the test presets in `reference/presets.js`;
the ones marked `design` are those of `design.md` §11.

**Now: 45 engine tests passing** (under 1 s). Renders: `node tools/render-presets.js`.

## Batch 02 · one line, CZ warp

One line per voice: the CZ waves and windows, window on any wave, wave pairs, Warp with its own
curve and the pitch cap, 8-stage Warp and Amp envelopes, Poly 8 and Mono with glide. Runs at 4×
with the 128-tap decimator (brought forward from batch 04, since nothing sounds without it). No
antialiasing yet beyond that.

![One cycle of each wave at four Warp settings, and Resonance through each window](docs/tests/02-waves.png)

- **The chip.** Each wave and window was checked against a direct transcription of MAME's
  `upd933.cpp` integer code at every one of its 2048 positions and five Warp settings. The worst
  difference is 0.0015 of full scale, which is the chip's own 11-bit rounding.
- **Warp 0 is a pure cosine** for Saw, Square, Pulse, Saw-pulse and Resonance (other harmonics
  below −200 dB). Two exceptions, both as on the chip: Double sine is a pure cosine an octave up,
  and Double pulse is never pure (each half resets).
- **Warp curve.** The pivot halves every 1/7 of the knob, so brightness grows at every step
  (energy-weighted harmonic number 1.00 → 1.23 → 1.64 → 2.01 → 2.10 for Saw at 0, ¼, ½, ¾, 1).
  The top quarter adds little, because the pivot is already very short there. Worth a listen: a
  gentler curve (6 octaves instead of 7) may spread it better.
- **Pitch** within 0.001 cent on Saw, Square and Resonance; Transpose and bend add up.
- **Wave pair** Saw + Pulse sounds exactly an octave lower; a wave paired with itself changes
  nothing.
- **No DC, no thump.** Windowed waves have a large DC offset (the window keeps the unipolar
  carrier above zero). The line's DC blocker starts at the wave's mean, so notes start clean: without
  that, Resonance + Triangle window started with an offset of 11% of its peak, Pulse + Pulse window
  17%. Now under 1%.
- **Levels** (after your first listen: about 8 dB between presets). Two causes, both fixed:
  - *The amp envelope's 72 dB scale.* Every sustain below 1 dropped fast (0.7 was −22 dB). Amp gain
    is now the level squared: 0.5 is −12 dB.
  - *The wave's own shape.* A narrow Pulse is 16 dB below a Saw, Square 3 dB above, and the
    windows take 3–11 dB off Resonance. Each line now measures its wave's RMS every block and
    evens it out to the power 0.7, as in Throat. Every wave, Warp and window now sits within
    −3.3 to +0.9 dB of the Saw. Pulse and Double pulse at high Warp are spikes: matching their RMS
    pushed peaks to clipping (tried peak limits of 2.5, 4 and 8 times a cosine's peak; 8 clipped
    the Wave tour). At 4 they stay at most 12 dB down.
  - Measuring needed care: 64 even points per cycle missed a narrow pulse completely and boosted
    it by the full +12 dB. The cycle is now cut at the warp's breakpoints, with 16 points per piece.
  - Renders now: single-note presets −19.7 to −21.7 dB RMS. CZ Brass plays four-note chords, so
    its Volume is 6 dB down to match.
- **Same output at any buffer size** (128, 37 and 1 samples): bit for bit.
- **Envelopes.** Sustain holds (0.02 dB drift), level 0.5 sits 12.0 dB below level 1, a release
  jumps past the sustain point and the voice stops, an envelope with no sustain point runs to its
  end with the key held.
- **Voices.** Poly holds 8. Mono glide changed from an exponential (which never quite arrived:
  7 cents short after 4.5 time constants) to a straight line in pitch that arrives in the Glide
  time, whatever the interval.
- **High notes.** MIDI 108 at full Warp on every wave stays finite and below clipping. It aliases:
  batch 04.

![Spectrograms: CZ Reso Sweep, Wave tour, Window tour](docs/tests/02-spectrograms.png)

Renders (48 kHz, 24-bit): the two design presets CZ Brass and CZ Reso Sweep, plus five that show
the warp on its own (Wave tour, Window tour, Windowed saw, Wave pair, Square lead in Mono). Each
renders at 2–8% of real time on one core.
