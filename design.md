# Pretzel · design

A playable synth that bends a wave on both axes. Phase distortion bends **time** (how fast each
part of the cycle is read), waveshaping bends **level** (where each value is sent). MIDI in,
stereo audio out. No audio input.

Labels: **[Decided]** you chose it, **[Proposed]** suggested and not yet confirmed, **[Open]**
still to decide. Sources for every number go in `research.md` (first research pass done, file not
written yet).

Second pass, settled. Nothing is built; the batches are in `plan.md`.

---

## 1. What it is

- An **AU/VST3 instrument for macOS** plus a standalone app, like Throat. No audio input; it is
  not an effect. [Decided]
- Two methods in one oscillator: **phase distortion**, mostly Casio CZ style, and **waveshaping**
  in four families (Chebyshev, fold, saturate, drawn). [Decided]
- **Not a CZ remake.** The CZ is the starting point for the warp, not a target to match. Nothing
  is tested against a real CZ. [Decided]
- Some out-of-bounds phase warps beyond the CZ: Vector Phaseshaping, smooth curves, sync, and
  feedback into the phase. All three warp families ship (decided after the batch 06 renders).
  [Decided]
- Not a creature or a body. Pretzel is abstract, but it is a good source for mouth-tube and
  beak-tube. [Decided]
- Built the bytebent way: JavaScript reference engine and browser bench first, then the C++
  port, then the JUCE plugin. [Decided]

**What no other synth does** (from the survey in the research pass, which covered about 15 products):

1. **Order is a control.** Warp then shape, shape then warp, or a true morph between the two.
2. **The Twist loop**: the shaped output feeds back into the phase, held stable the way the
   DX7 holds its feedback.
3. **One CZ-style envelope drives both axes**, each with its own depth.
4. **Exact band limiting for the Chebyshev shaper**, because a warped cosine through a
   Chebyshev shaper is a sum of warped harmonics.
5. **A pretzel-shaped live view** that shows the wave being warped and shaped (section 12).

## 2. Signal flow

One voice has two **lines** (section 3). One line:

```
            ┌──────────────── Twist (feedback) ◄───────────────┐
            ▼                                                  │
pitch ─► phase φ ─► Warp g ─► carrier ─► Shaper S ─► DC block ─┴─► Amp ─► line out
           (DCO)     (PD)    cos × window   (WS)                  (DCA)
                      ▲                       ▲
                Warp env × depth        Shape env × depth
```

The voice mixes its two lines through **Line select** and **Ring** / **Noise**, then goes to pan
and output:

```
line 1 ─┬───────────────────────────► mix ─► out
line 2 ─┴─► (ring with 1 / noise) ───►
```

In **Shape → Warp** order, the Warp and Shaper blocks swap roles (section 6).

## 3. Lines and voices

A **line** is one complete oscillator: its own wave, warp, shaper and envelopes, from pitch to
level. It is the CZ's word. A voice with two lines is two of these, layered, detuned or
ring-modulated. [Decided: two lines, called lines]

- **Line select**, as on the CZ [Decided; built in batch 09]:
  - 1;
  - 2;
  - 1+1′: line 1 played twice, the copy with line 2's octave, fifth and detune;
  - 1+2: both lines (the default; line 2 starts 7 cents sharp).
  Two lines together are each 3 dB down, so the pair sits near one line's level. Presets made
  before batch 09 set Line select to 1, as they were made.
- **Ring**: line 2 (with its own envelope) is multiplied by line 1's wave, at twice the gain; line
  1 still sounds. **Noise**: line 2's pitch jumps by up to ±90% every internal sample, from the
  voice's own seeded generator, as on the CZ. [Decided]
- **Per line**: Level (dB), Octave (±3), Fifth (+7 semitones), Detune (±100 cents) and a pitch
  envelope with its depth (±24 semitones). [Decided]
- **Voices**: 8 in Poly, 1 in Mono with glide and legato. [Decided; batch 05 benchmark on the Intel
  Mac runner, checked again after the C++ port]

## 4. Warp (phase distortion)

**Warp is Pretzel's name for phase distortion**, the stage the CZ called DCW. Warp amount is the
DCW amount.

The phase φ runs from 0 to 1 once per cycle. The warp is a function g, and the carrier reads a
cosine at g(φ). At Warp 0, g(φ) = φ and every warp is a pure cosine, as at DCW 0 on a CZ. The
Warp amount is what the CZ called DCW.

### 4.1 CZ family [Decided as the core]

**Reference: MAME's `upd933.cpp`**, Devin Acker's emulation of the CZ-101's sound chip (the NEC
µPD933). Its licence is **BSD-3-Clause**, so Pretzel may port from it. The conditions are: keep
its copyright notice and licence text in the source and in the plugin's credits, and do not use
the author's name to promote Pretzel. [Decided: port from it, with credit]

How the chip works, read from that code:

- **One carrier for every wave.** The chip reads a **unipolar** cosine, c(u) = (1 − cos 2πu)/2,
  then centres the result. Every wave starts and ends at zero.
- **DCW sets a pivot.** With the cycle as 0–1 and DCW as w (0 to about 0.5), the pivot is
  p = 0.5 − w. DCW 0 puts the pivot in the middle, which gives a pure cosine.
- **A window can apply to any wave.** The CZ only uses windows with its resonance wave, but the
  chip multiplies any wave by any window.

The waves, normalised from the chip code:

| Wave | Phase read (u, then c(u)) |
|---|---|
| Saw | φ < p: u = 0.5·φ/p. Otherwise u = 0.5 + 0.5·(φ − p)/(1 − p) |
| Square | In each half-cycle (h = φ mod 0.5): u = 0.5·h/p until h = p, then hold at 0.5. The second half is offset by 0.5, so it mirrors |
| Pulse | φ < 2p: u = φ/(2p), one full cosine. Then hold at the bottom |
| Double sine | φ < p: u = φ/p. Otherwise u = (φ − p)/(1 − p). Two full cosines, squeezed and stretched |
| Saw-pulse | φ < 0.5: u = φ. Then u = 0.5 + 0.5·(φ − 0.5)/p until φ = 0.5 + p, then hold at the bottom |
| Resonance | u = (k·φ) mod 1, where k = 1 + 32·w (up to about 17). Hard-synced to the cycle |
| Double pulse (hidden) | Pulse at twice the rate. Not on the CZ panel |

The windows multiply the wave's level:

| Window | Level over the cycle |
|---|---|
| None | 1 |
| Saw | Falls from 1 to 0 |
| Triangle | Rises from 0 to 1, then falls back to 0 |
| Trapezoid | 1 for the first half, then falls to 0 |
| Pulse (hidden) | Falls to 0 over the first half, then stays at 0 |
| Double saw (hidden) | Rises twice, once per half |

- **CZ Reso 1, 2 and 3** are Resonance with the Saw, Triangle and Trapezoid windows.
- **Window on any wave** is a Pretzel control, as the chip allows. The hidden waves and windows
  are included. [Decided]
- **Wave pairs.** As on the CZ, a line can **alternate two waves** on successive cycles (saw on
  one cycle, pulse on the next). This halves the pitch and adds subharmonic colour. Two reso waves
  cannot pair. [Decided]
- **Built-in band limit.** The chip caps DCW by pitch, so the first segment never gets shorter
  than about 4 samples' worth of phase. Pretzel keeps this rule at its own internal rate.
  [Decided]
- **The DCW curve.** Inside the chip, DCW is linear in its register. The CZ's 0–99 panel scale is
  mapped to that register by the CZ firmware, which MAME does not contain and which is Casio's.
  Pretzel uses its own perceptual curve, tuned by ear. [Decided]

### 4.2 Out-of-bounds families [Decided: all three ship; built in batch 06]

**Family** chooses CZ, Vector, Smooth or Sync. In every family Warp 0 is a pure cosine and the
knobs set where Warp 1 goes, so the Warp envelope sweeps from a plain cosine to the family's
shape. Each family is held under the pitch cap (divided by the shaper's steepening), and wave
pairs are a CZ feature only.

- **Vector (VPS).** The CZ breakpoint becomes a point (d, v):
  g = v·φ/d before d, then v + (1 − v)(φ − d)/(1 − d). (½, ½) is the plain phase; Warp moves the
  point from there to (Vector x, Vector y). When v > 1, the first part of the cycle reads more than
  one cycle and a formant appears; d moves it. The wave kinks at d, so the sample is split there.
  (Kleimola, Lazzarini, Timoney and Välimäki, DAFx-11.) The design first had (½, 1) as the
  plain point; that reads a whole cycle in the first half (an octave up), so it is (½, ½).
- **Smooth.** Bends with no corners, so they alias least:
  - *Power*, g = φ^q with q = 2^(5·Warp): the cosine pushed toward the end of the cycle, a smooth
    pulse at the top.
  - *Sigmoid*, a tanh S through the middle with steepness 4(2^(4·Warp) − 1): squeezed into the
    middle.
  - *Bezier*, handles (hx, hy) and (1 − hx, 1 − hy), moving from a straight line toward (Vector x,
    Vector y / 4). Handles near (0.1, 0.9) give a rounded square.
  (Power 2^(7·Warp) and Sigmoid 2^(6·Warp) were first tried; both were a needle by Warp ¼.)
- **Sync.** g = (r·φ) mod 1, with r from 1 at Warp 0 to Ratio (1–16) at Warp 1: hard sync inside
  one oscillator, a linear sweep. Plain (it jumps at every cycle, split and corrected like
  Resonance) or with any window.
- **Twist** is the fourth out-of-bounds warp, but it is a loop rather than a shape (section 7).

## 5. Shaper (waveshaping)

The shaper is a function S applied to the carrier. **Shape** (0–1) is the drive into it, so
Shape 0 always passes the carrier through unchanged. Every family has **Bias** (−1 to +1), which
offsets the input to add even harmonics. [Decided: all four families]

### 5.1 Chebyshev [Decided]

S(x) = Σ h_k·T_k(x), for k = 1…16. The identity T_k(cos θ) = cos kθ means a full-scale cosine
produces exactly harmonic k at level h_k.

- **Harmonics**: 16 sliders, h_1…h_16. Plus **Tilt** (harmonic k × k^Tilt) and **Odd/Even**
  (> 0 cuts even harmonics, < 0 cuts odd ones above the fundamental), which scale all 16 at once.
  The weights are scaled to add up to 1, so the output never passes ±1 and the harmonics keep
  exactly the sliders' ratios.
- **Shape** fades the harmonics in, like a waveshaping index: harmonic k comes in as
  Shape^(1 + (k−2)/4), so harmonic 2 arrives first and the high ones last, and the fundamental moves
  from 1 to its slider. Shape 0 is the wave unchanged. This is the waveshaping version of DCW.
  (Scaling the input, a·cos θ, as Le Brun does, cannot leave Shape 0 unchanged.) [Decided, batch 03]
- **After a warp**, the shaper turns cos(2π·g) into Σ h_k·cos(2πk·g), a stack of warped
  harmonics. That is what makes exact band limiting possible (section 9).

### 5.2 Fold [Decided]

- **Triangle** fold: reflect at ±1.
- **Sine** fold: sin(G·asin x). At G = 1 it is the wave itself; on a cosine it is a sine of the
  wave's own phase, folded G times.
- **Analog**: four Lockhart stages in closed form, with Lambert W, between a 1/3 pre-gain and a ×3
  post-gain (Esqueda, Pöntynen, Parker and Bilbao, 2017). The stages bend the wave a little even at
  G = 1; that bend is added back, so Shape 0 is exact.
- **Shape** is the fold gain G = 10^Shape: 1 to 10, evenly in log (1.8 at ¼, 3.2 at ½).
  [Decided, batch 03]

### 5.3 Saturate [Decided]

tanh, arctan and a cubic soft clip, as f(d·x)/f(d), so the peak stays at 1. **Shape** sets the
drive, d = 16·Shape². Bias makes the curve asymmetric.

### 5.4 Drawn [Decided]

- Two to four **keyframe curves**, drawn as breakpoints or splines. **Morph** runs through them in
  order. **Shape** fades the curve in (Shape 0 is the wave unchanged).
- Four defaults: a soft S, terraces, a sine fold and a full-wave rectifier (which sounds an octave
  up).
- Each curve stores its first antiderivative, computed in double precision, for antialiasing
  (section 9). Morphing the curves and morphing the antiderivatives with the same weights give the
  same result, so morphing costs nothing extra.

## 6. Order

Pretzel's first headline. [Decided; built in batch 07]

| Order | Output | Character |
|---|---|---|
| **Warp → Shape** (default) | S(c(g(φ))) | Predictable. The Chebyshev analysis holds. CZ waves come out "shaped" |
| **Shape → Warp** | The shaper works on the phase, then the warp reads it | Closer to FM: brighter, with more movement |
| **Morph** | A true morph between the two | Not a crossfade |

**Shape → Warp: two modes, both kept** as a switch (`swmode`) after the batch 07 listening: each
sounded worth having. Both leave the plain phase at Shape 0, so every order is the same wave there.
[Decided]

- **Read (A). The shaped wave becomes the phase.** The plain cosine is shaped, and the result is read back
  as the phase a plain cosine would need to make it (acos, one branch per half cycle); the warp then
  reads that phase. At Warp 0 this is exactly Warp → Shape; with a warp it is the warp read along the
  shaped wave. Chebyshev harmonic k makes the phase k times as fast, folded back. (The first form,
  u = ½(S(cos 2πφ) + 1), reads a cosine of a cosine even at Shape 0, so it was changed.) The phase
  can jump at ½ and at the end of the cycle, where the branches meet; the sample is split there.
- **Bend (B). The shaper bends the phase ramp.** u = ½(S(2φ − 1) + 1), then the warp reads u: two phase
  warps in a row (nested phaseshaping, Kleimola and others, SMC 2010). The phase can jump at the end
  of the cycle; split there.

**Morph.** One knob, t from 0 to 1: Warp → Shape at 0, Shape → Warp at 1. Two ways, behind a
switch (`morphway`), both kept after the batch 07 listening [Decided]:

- **Through the warp.** From 0 to ½ the shaper leaves the output; from ½ to 1 it enters the phase.
  The middle is the warp alone, so the sound turns inside out through its plain self.
- **Shared.** Shape is split between the output (1 − t) and the phase (t) all the way.

Both ways run one chain (a shaper on the phase and one after the warp, each with its own share of
Shape), so the cost is that of both shapers at once at most.

**Band limits.** The shaper on the phase steepens the phase itself, so its share of Shape is held
under the pitch cap on its own (Chebyshev harmonic 16 on the ramp, B, steepens it 256 times), and
the warp's cap is divided by both shapers' steepening. Aliasing (`docs/tests/07-alias-orders.txt`):
447 of 600 order settings below −60 dB; the worst, −27 dB, are folds on the phase (the Triangle fold
most) with Vector, Sync or windowed Resonance at MIDI 48 and up. Bend aliases less than Read.
[Open: smoothing the phase shaper's creases, if they are heard]

## 7. Twist (feedback)

Pretzel's second headline. The line's shaped output is fed back into the phase the warp reads,
so the knot ties itself. [Decided; built in batch 08]

```
read phase = φ + depth · tanh( LP( ½(y[n] + y[n−1]) ) )
depth      = Twist · ½ cycle · min(1, √(440 Hz / f)) / (shaper steepening × warp steepening)
```

- **Averaging the last two samples** is the DX7's "anti-hunting" filter (Ken Shirriff's DX7 chip
  analysis; Yamaha's patents). It stops the loop from flipping between two states.
- **LP** is a one-pole low-pass at a quarter of the internal sample rate; **tanh** limits it, so
  the phase never moves more than the depth.
- **The same feedback index on every wave.** The depth is divided by how much the shaper and the
  warp multiply a shift of the phase: a Resonance ratio of 17 turns a phase shift into 17 times
  that in the wave. Without this, steep waves (windowed Resonance, Vector, folds) broke into chaos
  at Twist ¼; with it, every wave stays periodic up to ¾. Depth also falls above 440 Hz.
- **No DC blocker in the loop.** The design first had one before the tap. The loop has no
  integrator, so DC can only shift the phase by a fixed amount; it never builds up.
- **The last quarter of the knob** deepens the loop up to four times: steady up to ¾, then
  controlled chaos at full Twist (a pure cosine breaks up into noise).
- **What it sounds like**: low Twist turns a sine toward a saw, as DX feedback does (by Twist ½
  the harmonics fall like a saw's). On shaped waves it adds a rough, vocal edge; the top quarter
  breaks up. [Open: listening test]
- **Band limiting.** The read phase can run backwards, so breakpoints are not where time puts them:
  with Twist on, samples are not split. Twist relies on the 4× oversampling, the loop's low-pass
  and ADAA on the output, and the warp's pitch cap counts Twist's speed-up (1 + 2π × depth).
- The loop is one sample per voice and cannot be vectorised within a voice. Across voices it
  still can be.
- **Moving Twist over time.** There is no Twist envelope of its own. Either mod envelope or LFO
  (section 8) can drive it. [Decided]

## 8. Envelopes and modulation

**Four CZ-style 8-stage envelopes per line**: Pitch, Warp, Shape and Amp. Each stage has a rate
and a level, plus a sustain point and an end point, as on the CZ. [Decided]

- **Link.** The Warp envelope can also drive Shape, with a signed depth. One envelope then opens
  both axes together: Pretzel's version of the CZ's "filter without a filter". [Decided]
- **Key follow** on Warp and Shape, as on the CZ's DCW. High notes get less warp and shape. This
  is both a musical choice and a band limit. [Decided]
- **Velocity** to Amp, Warp and Shape, each with its own depth. [Decided]
- **Amp level curve.** Amp gain is the envelope level squared: 0.5 is −12 dB. (A 72 dB log scale,
  as on the CZ, made every sustain below 1 sound much too quiet: 0.7 was −22 dB.) [Decided, batch 02]
- **Levels are evened out.** Every block, each line measures its wave's RMS at the current Warp
  and divides by it to the power 0.7, as in Throat, up to +12 dB. Without it a narrow Pulse is
  16 dB down and the windows take 3–11 dB off. Spiky waves stop at 4 times their peak, so a narrow
  pulse at full Warp stays up to 12 dB down instead of clipping. [Decided, batch 02]
- **No XY pad.** [Decided]

**Free modulators**: 2 LFOs and 2 mod envelopes per voice, on top of the four fixed envelopes.
[Decided; built in batch 09]

- The mod envelopes are the same 8-stage kind.
- Each modulator has **two destinations**, each with its own depth (±1). This replaces a separate
  mod matrix. [Decided]
- **Destinations** (each on both lines, line 1 or line 2): pitch, level, detune, Warp, Vector x,
  Vector y, Sync ratio, Shape, Bias, Tilt, Odd/Even, Morph (drawn), Order Morph, Twist. Depth adds
  to the knob's position (0–1, so the knob's own curve applies); pitch moves ±12 semitones at depth
  1. A line playing line 1's settings (1+1′) follows line 1's modulation. [Decided]
- **Mod wheel** and **aftertouch** each get one destination and depth too. [Decided]
- LFO shapes: sine, triangle, saw, square, random (sample and hold). Rate 0.01–50 Hz free, or
  synced to tempo: 1/32, 1/16, 1/8 triplet, 1/8, 1/4 triplet, 1/4, 1/2, 1, 2 or 4 bars. Each LFO
  restarts on a new note unless Retrigger is off. [Decided]
- **Rate.** The modulators run once per 32-sample block (1,500 times a second at 48 kHz); pitch
  moves smoothly within the block. [Decided]

## 9. Band limiting

Both methods alias, and chaining them makes it worse. A warp with maximum slope g′ raises the
top frequency to f0·g′. A shaper of order N multiplies it by N. Folds, drawn kinks and Twist have
no top at all.

So Pretzel band-limits the whole chain, not each block on its own. [Decided; built in batch 04,
numbers in `tests.md`]

- **The CZ waves are smooth where they bend.** Every breakpoint of the CZ waves falls where the
  cosine is flat (its top or bottom), so the wave has no jump and no kink there, only a change of
  curvature. They need no corrections of their own.
- **Pitch cap, the same for every wave.** The steepest part of a wave never reads the cosine
  faster than 1/8 of the internal rate (24 kHz at 48 kHz): the chip's cap, which for the Saw is a
  first segment of 4 samples. Double sine, which reads a whole cosine in its first segment, gets
  twice the room.
- **Chain-aware cap.** The shaper steepens the wave: a fold of gain G makes every frequency G times
  higher, a saturator by d/f(d) near zero, a drawn curve by its steepest slope. The pitch cap and
  the resonance ratio are divided by that factor, so a wave going into a hard fold is never steeper
  than the fold can take. The resonance formant stays below 0.45 of the host rate and below 0.12 of
  the internal rate divided by the factor.
- **Chebyshev, exact.** Harmonic k's highest instantaneous frequency is k·f0·max g′, and max g′ is
  known in closed form for every warp. Each harmonic fades out as that frequency goes from 0.3 to
  0.45 of the internal rate. (Fading from 0.6 to 0.85, where folding would first reach the audio
  band, left 10 dB more aliasing: the steep part of the wave spreads widely.)
- **Shaper: first-order ADAA** (Parker, Zavalishin and Le Bivic, DAFx-16) on every family,
  Chebyshev included: the shaped wave averaged over each sample, a box filter. Every family has a
  closed-form antiderivative (Chebyshev through its coefficients, triangle fold piecewise
  quadratic, sine fold in θ = asin x, saturators with log cosh and its kin) or a stored one (Analog
  fold and Drawn, as tables). This adds half a sample of delay, the same at every Shape, so Shape 0
  is the plain average of two samples (−0.5 dB at 20 kHz) and switching families never jumps.
- **Jumps and kinks: split the sample.** Where the wave itself jumps or kinks (Resonance's hard
  sync at the end of the cycle, Double pulse at p and ½ + p, the windows at ½ and the end), the
  sample is split there and each piece is averaged on its own, so a jump goes through the shaper
  as the jump it is, not as a line through the values between (which turned a jump into a spike
  when the curve sends +1 and −1 to the same place). The shaped jump and kink then get
  second-order residuals that turn the box into a triangle filter, as polyBLEP and polyBLAMP do.
  This adds one more internal sample of delay. Splitting where the wave is smooth made things
  worse (the steep peaks of a Pulse into Chebyshev aliased at −32 dB instead of −66), so only those
  places split.
- **Oversampling.** 4× with a windowed-sinc decimator, the same as Throat and Syrinx. An Eco mode
  at 2× comes only if performance is bad on the Mac. Batch 05: not needed for now; checked again
  with the C++ port. [Decided]
- **Twist.** Each ADAA stage adds half a sample of delay, and inside the loop that changes the
  loop. So Twist relies on oversampling and its low-pass, not on ADAA.
- **Result** (`tools/alias.js`: 10 waves × 7 shapers × Warp ½ and 1 × MIDI 24, 48, 72, 96, 108):
  593 of 700 settings below −60 dB (303 before), the worst −38 dB (+21 before). Up to MIDI 72 the
  only settings above −60 dB are the Triangle fold at full gain and Chebyshev on Double pulse or a
  windowed Resonance. The hardest is the Triangle fold at gain 10 on the top notes: its own sharp
  creases need more than first-order ADAA. Second-order ADAA or 8× for that fold is an option if
  it is heard. [Open]

## 10. Parameters

Accepted as a first pass; it changes as the bench runs. Each line has its own copy of the Line,
Warp, Shaper and Envelope rows (ids end in 1 or 2). Ids follow the style of Throat and Syrinx.
Defaults are design values to tune by ear. **M** marks a knob that the free modulators can reach.

| Group | id | Range | Default | What it does |
|---|---|---|---|---|
| Voice | `lines` | 1, 2, 1+1′, 1+2 | 1+2 | Line select |
| | `ring` | Off, On | Off | Line 2 × line 1 |
| | `noise` | Off, On | Off | Noise on line 2's pitch |
| | `mode` | Mono, Poly | Poly | Poly: 8 voices |
| | `glide` | 0–2 s | 0 | Mono only. A straight line in pitch that arrives in this time |
| Line | `octave` | −3 to +3 | 0 | |
| | `fifth` | Off, On | Off | +7 semitones |
| | `detune` | ±100 cents | 0 / +7 | M. Line 2 slightly off |
| | `level` | −48 to +6 dB | 0 dB | M |
| Warp | `wfamily` | CZ, Vector, Smooth, Sync | CZ | |
| | `wave` | Saw … Resonance, Double pulse | Saw | CZ wave |
| | `pair` | None, Saw … Double pulse | None | Alternating second wave |
| | `window` | None, Saw, Tri, Trap, Pulse, Double saw | None | On any wave |
| | `warp` | 0–1 | 0 | M. Warp amount; the Warp envelope adds to it |
| | `vecx`, `vecy` | 0–1, 0–4 | 0.5, 1.5 | M. Vector point (d, v) at Warp 1; also the Bezier's handle |
| | `curve` | Power, Sigmoid, Bezier | Sigmoid | Smooth curve type |
| | `ratio` | 1–16 | 2 | M. Sync ratio at Warp 1 |
| | `warpkey` | 0–1 | 0.3 | Key follow |
| Shaper | `sfamily` | Chebyshev, Fold, Saturate, Drawn | Chebyshev | |
| | `shape` | 0–1 | 0 | M. Drive into the shaper |
| | `bias` | −1 to +1 | 0 | M. Asymmetry |
| | `h1`…`h16` | 0–1 | 1, 0 … | Chebyshev harmonics (ids `h1_1` … `h16_1` on line 1) |
| | `tilt`, `oddeven` | −1 to +1 | 0, 0 | M. Set all harmonics |
| | `fold` | Triangle, Sine, Analog | Sine | |
| | `sat` | Tanh, Arctan, Cubic | Tanh | |
| | `keys` | 2–4 | 4 | Drawn keyframes in use |
| | `morph` | 0–1 | 0 | M. Drawn keyframes |
| | `shapekey` | 0–1 | 0.3 | Key follow |
| Knot | `order` | Warp→Shape, Shape→Warp, Morph | Warp→Shape | |
| | `ordermorph` | 0–1 | 0 | M. Morph position |
| | `swmode` | Read, Bend | Read | How Shape → Warp works |
| | `morphway` | Through the warp, Shared | Through | How Morph moves the shaper |
| | `twist` | 0–1 | 0 | M. Feedback into phase |
| Envelopes | `penv`, `wenv`, `senv`, `aenv` | 8 × rate/level, sustain, end | CZ-like | Pitch, Warp, Shape, Amp |
| | `penvdepth` | ±24 st | 0 | |
| | `wenvdepth`, `senvdepth` | ±1 | +1, 0 | |
| | `link` | −1 to +1 | 0 | Warp env also drives Shape |
| | `velwarp`, `velshape`, `velamp` | 0–1 | 0.3, 0.3, 0.7 | Velocity depths |
| Modulators | `lfo1`, `lfo2` | shape, rate, sync, division, retrigger, 2 × (destination, depth) | Off | ids `lfo1shape`, `lfo1dest1`, `lfo1depth1` … |
| | `menv1`, `menv2` | 8 stages, 2 × (destination, depth) | Off | |
| | `wheel`, `aftertouch` | destination, depth | Off | ids `wheeldest`, `wheeldepth`, `atdest`, `atdepth` |
| Pitch | `transpose` | ±24 st | 0 | |
| | `bendrange` | 2–24 st | 2 | |
| Output | `volume` | −48 to +6 dB | −6 dB | |

## 11. Test presets

Each one checks one claim of the design. [Decided]

| Preset | Settings | Checks |
|---|---|---|
| CZ Brass | Saw, Warp env attack, Shape 0 | The CZ core, alone |
| CZ Reso Sweep | Resonance + Triangle window, slow Warp env | Reso waves, no jumps |
| Organ Pretzel | Sine (Warp 0), Chebyshev drawbar set | Shaper alone, exact harmonics |
| Linked | Saw + Chebyshev, Link 1 | One envelope opening both axes |
| Folded Saw | Saw → Fold, Shape env | Chain and band limit |
| Inside Out | Shape→Warp, Sine fold | Order |
| Turning | Saw + Fold, LFO on Morph | Morph sounds like one wave, not two |
| Knot | Saw, Fold, Twist 0.6 | Twist stays stable at every pitch |
| Vowel | Vector, v = 2.5, `vecx` swept (mod wheel from batch 09) | VPS formants |

## 12. Live view

The wave is drawn **around a pretzel**: one closed path with two loops that cross, like the knot of
a pretzel. One trip around the path is one cycle of the wave. [Decided: the idea]

How it shows the two axes [Decided; built in the bench, batch 10]:

- **The level bends the path.** One trip around the pretzel is one cycle of time. The wave's value
  pushes the line out from the pretzel or in toward its middle, so the line is the real wave. A
  pure cosine is a gentle ripple around the shape. Shaping makes the ripple sharp, folded or
  flattened.
- **The warp moves the ticks.** Small ticks sit at even steps of the phase the warp reads (24 per
  cycle of the cosine). At Warp 0 they are evenly spaced. Warp bunches them where the cycle is read
  fast and leaves gaps where it holds. A Resonance or Sync ratio of 8 gives 8 rounds of ticks.
  (The first draft put the ticks at even steps of time; with the path traced in time, that shows
  nothing. Even steps of the read phase show the warp.)
- **Order shows as which happens first.** With the shaper on the phase (Shape → Warp), Shape moves
  the ticks; after the warp, it bends the line. Morph moves between the two. The order is written
  under the view.
- **Twist pulls the knot tighter.** The lobes draw in and the crossing rises as Twist goes up.
- **One line, or both.** Line 1 is orange, line 2 green, on the same pretzel. A dot marks where
  the cycle starts.

Smaller views beside it: the warp curve g (the read phase over one cycle), the transfer curve S at
the Shape it has now, and the plain wave on a straight line. [Decided]

The view shows the newest voice. When it ends, the last picture stays, dimmed.

## 13. Code architecture

Same rules as Throat and Syrinx. [Decided]

- Everything runs at 4× the host rate in fixed 32-sample blocks. The block is the latency,
  reported to the host. Band limiting adds 1.5 internal samples (under 8 µs at 48 kHz).
- `process()` never allocates. Parameters are read once per block; envelopes and Twist are
  sample-accurate.
- Each voice has its own seeded xorshift generator, used by Noise and the random LFO. Same seed and
  notes give the same output at any buffer size.
- The C++ port is checked sample by sample against the reference, built with `-ffp-contract=off`.
- Cosine is read from a table; the Chebyshev sum uses Clenshaw's recurrence.
- Code ported from MAME keeps its BSD-3-Clause notice in the file.
- Idle voices and lines do no work.
- **Cost** (batch 05, JavaScript reference on GitHub's Intel Mac, an i7-8700B): 3–8% of one core per
  line per voice, 43–46% for 8 voices in the worst case; full voices projected at 95–119% in
  JavaScript. The C++ port is measured on the same runner.
- **Mac runs happen on GitHub Actions** (`macos-26-intel`), never by hand.

Engine interface: `new PretzelEngine(sr, seed)`, `setParam`, `noteOn` / `noteOff`, `setBend`,
`process(L, R, n)`.

## 14. Open

1. Twist: what it sounds like across pitches and shapers, and where the chaos should start (listening).
2. Eco (2×) mode and the voice count: checked again with the C++ port on the Intel Mac runner.
3. ~~How many voices the browser bench plays.~~ Settled in batch 10: 4 by default, with a 2 / 4 / 8
   switch on the Voice page (the JavaScript engine needs about 20% of a core per full voice).
4. Smoothing the creases of a fold on the phase (Shape → Warp), if they are heard.
