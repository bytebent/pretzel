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
| 05 | **Cost** | `perf.js` at the worst case (8 voices, two lines, Fold, Morph, Twist placeholder), run by a GitHub Actions workflow on `macos-26-intel` (Intel, like your laptop) on every push; results posted on the run. | Decides the voice count and whether Eco (2×) is needed | |
| 06 | **Out-of-bounds warps** | Vector, Smooth (power, sigmoid, Bezier) and Sync, each with its band limiting. | Tests: Vector at (0.5, 1) and Sync at ratio 1 are a pure cosine; alias test extended to the new families · **You:** listen to Vowel; first say on which families ship | |
| 07 | **Order** | Shape → Warp definitions A and B, both Morph methods, behind a temporary switch. | Tests: Morph 0 equals Warp → Shape and Morph 1 equals Shape → Warp; alias test extended to every order · **You:** listen to Inside Out and Turning, pick A/B and the Morph method | |
| 08 | **Twist** | The feedback loop: two-sample average, low-pass, soft limit, β scaled by shaper order and pitch, DC block before the tap. | Tests: no runaway over a β sweep at every pitch, shaper and order; DC in the tap stays near 0 · **You:** listen to Knot | |
| 09 | **Two lines and modulation** | Line 2, Line select, Ring, Noise, Detune. Pitch envelope. 2 LFOs and 2 mod envelopes with two destinations each, mod wheel and aftertouch. Twist reachable from them. | Tests: 1+1′ with zero detune equals line 1 doubled; every destination marked M responds; LFO sync locks to tempo · **You:** listen | |
| 10 | **Bench** | `pretzel.html`: keyboard as on the other benches, the pretzel live view (§12) with the warp curve, transfer curve and plain wave beside it, test presets, DSP meter. | **You:** first listening round. Settles the open items in `design.md` §14 | |
| 11 | **C++ port** | `PretzelDSP.h`, `dsp_cli.cpp`, `compare.js`. | Tests: C++ matches the reference sample by sample | |
| 12 | **Plugin** | JUCE wrapper, web-view UI with the live view, presets, credits (MAME BSD-3-Clause notice), installer, CI. | CI green · **You:** play it in a host | |
| 13 | **Listening round** | Tuning defaults, ranges and curves from what you hear. | **You** | |

## Notes

- **Order of batches.** Band limiting and cost come before the out-of-bounds warps, Order and
  Twist. Every later batch then runs at the real rate and is held to the same alias test.
- **MAME port.** Batch 02 ports the wave and window formulas from MAME's `upd933.cpp` and keeps its
  BSD-3-Clause notice in `pretzel-engine.js` and later `PretzelDSP.h`.
- **Temporary switches.** Batch 07's A/B and Morph-method switches are for the bench only. The
  loser is removed after your listening round, so the plugin ships one behaviour.
