# Pretzel · build plan

Reference engine and bench first, then the C++ port and the plugin. Design: `design.md`.

Each batch ends with passing tests and a commit authored as
`bytebent <bytebent@users.noreply.github.com>`. Nothing moves to the next batch until you've
checked the one before where it says **You**. You never run commands: Mac benchmarks and builds
run on GitHub Actions on an Intel Mac (`macos-26-intel`), and the results are read from the run. From batch 02 on, every batch ends with a WAV of
each test preset that works so far (`node tools/render-presets.js`), sent to you with the batch.

## Layout

```
reference/
  pretzel-engine.js        the reference engine; defines the sound
  presets.js               test presets (bench and tests only)
source/
  PretzelDSP.h             C++ port, no JUCE
  PluginProcessor.*        JUCE instrument: MIDI in, stereo out
  PluginEditor.*           web-view host
  PresetManager.h          saving and loading presets
ui/index.html              interface (also opens in a browser)
tests/                     engine-test.js, compare.js + dsp_cli.cpp, plugin_test.cpp
tools/
  bench/                   bench template, AudioWorklet wrapper, build script → pretzel.html
  alias.js                 alias energy per warp × shaper × order, MIDI 24–108
  perf.js                  CPU per scenario
  render-presets.js        every test preset to a WAV
packaging/                 Mac installer
.github/workflows/         CI: tests, universal binary, auval, pluginval strictness 7
```

## Batches

Section numbers refer to `design.md`. Presets are the test presets of §11.

| # | Batch | Contents | Check | State |
|---|---|---|---|---|
| 01 | **Setup** | `README.md`, `design.md`, `plan.md`, `research.md`, `tests.md`, `.gitignore`. | | Done |
| 02 | **One line, CZ warp** | Phase, unipolar cosine table, the CZ waves and windows (hidden ones included), window on any wave, wave pairs, Warp amount with its own curve, DCW pitch cap. 8-stage envelopes for Warp and Amp. Poly 8 and Mono with glide. Test runner, `render-presets.js`. | Tests: Warp 0 is a pure cosine for every wave; each wave matches its formula; a wave pair halves the pitch; output has no DC; same seed gives the same output at any buffer size · **You:** listen to CZ Brass and CZ Reso Sweep | Done: 43 tests; every wave and window matches MAME's chip code; 4× oversampling and the decimator came in here (needed for any sound), so batch 04 adds only the antialiasing · **You:** listen to presets 01–07 |
| 03 | **Shaper** | The four families (Chebyshev, Fold, Saturate, Drawn), Shape, Bias, Tilt and Odd/Even, normalising gain, drawn keyframes with Morph and stored antiderivatives. Shape envelope, Link, key follow, velocity. | Tests: Shape 0 passes the carrier unchanged; a full-scale cosine through Chebyshev gives exactly h_k at harmonic k; morphed antiderivatives equal the antiderivative of the morph · **You:** listen to Organ Pretzel and Linked | Done: 76 tests; Shape 0 exact in all 8 shapers; Chebyshev harmonics exact to 1e−15; Shape fade-in law and fold gain curve set by measurement · **You:** listen to presets 08–14 |
| 04 | **Band limiting** | polyBLAMP at CZ corners, polyBLEP at jumps, first-order ADAA on Fold, Saturate and Drawn, the exact Chebyshev fade. `alias.js`. | Alias below −60 dB at the defaults for every CZ wave × shaper, MIDI 24–108; the Chebyshev fade rule confirmed or replaced · **You:** listen to Folded Saw at high notes | Done: 87 tests; 593 of 700 measured settings below −60 dB (303 before), worst −38 dB (+21 before); fade rule confirmed at 0.3–0.45 of the internal rate; chain-aware pitch cap added · **You:** listen to presets 01–15 |
| 05 | **Cost** | `perf.js` at the worst case (8 voices, two lines, Fold, Morph, Twist placeholder), run by a GitHub Actions workflow on `macos-26-intel` (Intel, like your laptop) on every push; results posted on the run. | Decides the voice count and whether Eco (2×) is needed | Done: on an Intel i7-8700B, 8 voices worst case 43–46% of a core for one line (JS); projected 95–119% for full voices in JS; engine 2–4× faster, bit-identical; 8 voices kept, no Eco for now (checked again after the C++ port) |
| 06 | **Out-of-bounds warps** | Vector, Smooth (power, sigmoid, Bezier) and Sync, each with its band limiting. | Tests: Vector at (0.5, 1) and Sync at ratio 1 are a pure cosine; alias test extended to the new families · **You:** listen to Vowel; first say on which families ship | Done: 98 tests; every family pure at Warp 0, under the pitch cap, click-free under a Warp sweep; 429 of 490 family settings below −60 dB, worst −39 dB · **You:** all three families ship |
| 07 | **Order** | Shape → Warp definitions A and B, both Morph methods, behind a temporary switch. | Tests: Morph 0 equals Warp → Shape and Morph 1 equals Shape → Warp; alias test extended to every order · **You:** listen to Inside Out and Turning, pick A/B and the Morph method | Done: 106 tests; Morph ends bit-identical to the two orders; A at Warp 0 equals Warp → Shape; 447 of 600 order settings below −60 dB · **You:** keep both modes and both Morph ways as switches |
| 08 | **Twist** | The feedback loop: two-sample average, low-pass, soft limit, β scaled by shaper order and pitch, DC block before the tap. | Tests: no runaway over a β sweep at every pitch, shaper and order; DC in the tap stays near 0 · **You:** listen to Knot | Done: 113 tests; periodic up to Twist ¾ on every wave, in tune, never runs away (84 settings at full), controlled chaos above ¾ · **You:** listen to presets 24–27 |
| 09 | **Two lines and modulation** | Line 2, Line select, Ring, Noise, Detune. Pitch envelope. 2 LFOs and 2 mod envelopes with two destinations each, mod wheel and aftertouch. Twist reachable from them. | Tests: 1+1′ with zero detune equals line 1 doubled; every destination marked M responds; LFO sync locks to tempo · **You:** listen | Done: 125 tests; 1+1′ is line 1 doubled to 1e−7; all 14 destinations move the sound; synced LFO exact; same output at any buffer size with everything running; 8 full voices take 159% of one core in JavaScript · **You:** listen to presets 28–34 and the new Vowel and Turning |
| 10 | **Bench** | `pretzel.html`: keyboard as on the other benches, the pretzel live view (§12) with the warp curve, transfer curve and plain wave beside it, test presets, DSP meter. | **You:** first listening round. Settles the open items in `design.md` §14 | |
| 11 | **C++ port** | `PretzelDSP.h`, `dsp_cli.cpp`, `compare.js`. | Tests: C++ matches the reference sample by sample | |
| 12 | **Plugin** | JUCE wrapper, web-view UI with the live view, presets, credits (MAME BSD-3-Clause notice), installer, CI. | CI green · **You:** play it in a host | |
| 13 | **Listening round** | Tuning defaults, ranges and curves from what you hear. | **You** | |

## Notes

- **Order of batches.** Band limiting and cost come before the out-of-bounds warps, Order and
  Twist. Every later batch then runs at the real rate and is held to the same alias test.
- **MAME port.** Batch 02 ports the wave and window formulas from MAME's `upd933.cpp` and keeps its
  BSD-3-Clause notice in `pretzel-engine.js` and later `PretzelDSP.h`.
- **Order switches.** Batch 07's two Shape → Warp modes (Read, Bend) and two Morph ways
  (Through, Shared) were bench switches for choosing; after listening, all four stay as switches.
