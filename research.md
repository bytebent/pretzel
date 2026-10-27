# Pretzel · research

The sources behind `design.md` and what was taken from each. First pass: most were read through a
research brief (web survey, October 2026), not in full. **Read** marks a source read directly.

## Phase distortion

| Source | What Pretzel takes from it |
|---|---|
| MAME `src/devices/sound/upd933.cpp`, Devin Acker, 2023, BSD-3-Clause. **Read** | Bit-level emulation of the NEC µPD933 (CZ-101 sound chip). Every wave reads one unipolar cosine table, (1 − cos)/2, 2048 entries, 12-bit, then is centred. DCW sets a pivot = 0x400 − dcw in an 11-bit cycle. Wave formulas: saw, square, pulse, double sine, saw-pulse, resonance (phase × (1 + dcw/64), hard-synced), plus hidden "silent" and "double pulse". Windows multiply the level and apply to any wave: saw, triangle, trapezoid, plus hidden pulse and double saw. DCW is capped by pitch (`m_dcw_limit`). Ring mod multiplies by the other voice's last sample. Basis for §4.1. |
| Ishibashi (Casio), US4658691, *Electronic musical instrument*, priority 1982, granted 1987 (expired) | The PD mechanism: an address that "changes at a uniform rate" turned into one "whose changing rate varies in one cycle"; addresses beyond one cycle for the resonant waves. Half-cosine ROM; SAT (saw) and SQU (square) modes; Fig. 19 resonance circuit (fast counter reset each cycle, multiplied by an inverted ramp). |
| Casio CZ series: CZ-1 manual; Mulcahy, *The Casio CZ series*; Weltenschule CZ-230S page | Lines of DCO/DCW/DCA with 8-stage envelopes; DCW is PD's equivalent of the filter, DCW 0 is a sine; DCW key follow; eight waves, alternating wave pairs (two resonant waves cannot pair); line select 1, 2, 1+1′, 1+2′; ring and noise modulation. |
| Kleimola, Lazzarini, Timoney & Välimäki 2010, *Phaseshaping oscillator algorithms for musical sound synthesis*, SMC 2010 | PD as "double waveshaping"; nested phaseshaping as function composition; elementary phaseshapers (linear + mod 1 as one-oscillator sync, triangle, ripple); polyBLEP for discontinuous phaseshapers. Basis for Sync and Shape → Warp B. |
| Kleimola, Lazzarini, Timoney & Välimäki 2011, *Vector phaseshaping synthesis*, DAFx-11, pp. 233–240 | The (d, v) breakpoint: v > 1 reads more than one cycle and gives formant peaks; some settings alias audibly. Basis for the Vector family. Also Csound `vps`. |
| Csound manual: `pdhalf`, `pdhalfy`, `pdclip`, `vps` | Two-segment PD maps and their parameter conventions. |
| Mutable Instruments Braids, `digital_oscillator.cc` (open source) | CZ-style windowed resonance on a unipolar carrier with the modulator phase reset each cycle. |
| keithadler/pdsynth (GPL-2) | Reports the resonant sweep running from about the 3rd to the 13th harmonic. |

## Waveshaping

| Source | What Pretzel takes from it |
|---|---|
| Le Brun 1979, *Digital waveshaping synthesis*, JAES 27(4):250–265; Arfib 1979, JAES 27(10):757–779; Roads 1979, CMJ | Chebyshev identity T_k(cos θ) = cos kθ; shaper Σ h_k·T_k gives exactly harmonics 1…N at full scale; distortion index a·cos θ brightens toward the design; normalising gain; a degree-N polynomial reaches N·f0. Basis for §5.1. |
| Lazzarini, *Distortion synthesis*, Csound Journal 11 | Input amplitude sets bandwidth proportionally. |
| Esqueda, Pöntynen, Välimäki & Parker 2017, *Virtual analog Buchla 259 wavefolder*, DAFx-17 | Parallel folding stages; aliasing from frequency expansion. |
| Esqueda, Pöntynen, Parker & Bilbao 2017, *Virtual analog models of the Lockhart and Serge wavefolders*, Applied Sciences 7(12):1328 | Lockhart folder in closed form (Lambert W); first-order ADAA cuts the oversampling needed. Basis for Fold: Analog. |
| Mutable Instruments Plaits manual | Waveshaping model: asymmetric triangle → shaper → folder; band-limited at 48 kHz. |

## Antialiasing

| Source | What Pretzel takes from it |
|---|---|
| Parker, Zavalishin & Le Bivic 2016, *Reducing the aliasing of nonlinear waveshaping using continuous-time convolution*, DAFx-16 | First-order ADAA: y = (F1(x[n]) − F1(x[n−1]))/(x[n] − x[n−1]), midpoint fallback for small steps; half-sample delay and mild high-frequency droop. |
| Bilbao, Esqueda, Parker & Välimäki 2017, *Antiderivative antialiasing for memoryless nonlinearities*, IEEE SPL 24(7):1049–1053 | Higher orders; second order needs F2 and three samples. |
| Bilbao, Esqueda & Välimäki, *Antiderivative antialiasing for arbitrary waveform generation* | ADAA on a phase ramp (integrated wavetables). Background for the Drawn tables. |
| Kahles, Esqueda & Välimäki, *Oversampling for nonlinear waveshaping: choosing the right filters*, JAES | Half-band FIR vs IIR trade-offs for the decimator. |
| Chowdhury, ADAA experiments (GitHub) | Practical C++ reference. |

## Feedback

| Source | What Pretzel takes from it |
|---|---|
| Shirriff, DX7 chip reverse engineering, part 4, righto.com, December 2021 | Self-feedback averages the previous two samples "to provide stability", then scales by a power of two. Basis for Twist. |
| ajxs.me, *Yamaha DX7 technical analysis* | The same average as the "anti-hunting" filter of Yamaha's patents. |

## Survey

Products checked for phase warp and amplitude shaping in one voice: Casio CZ and VZ, Arturia CZ V,
Behringer CZ-1 Mini, pdsynth, VirtualCZ, Csound, Braids, Plaits, Bitwig Phase-4/Phase-1/Grid,
Vital, Serum 1 and 2, Surge XT, Phase Plant, Korg opsix, logue SDK VPS oscillator. None found with
order as a control, shaper-to-phase feedback, one envelope over both axes, or Chebyshev-exact band
limiting of the chain. Not checked: u-he, Ableton, Plogue, Elektron, Novation, Waldorf and most
Eurorack makers.

## Own derivations (to confirm in the bench)

- After a warp g, a Chebyshev shaper gives Σ h_k·cos(2πk·g(φ)); harmonic k peaks at
  k·f0·max g′, so fading h_k near Nyquist band-limits the chain exactly.
- Cost of one line: about 150–250 operations per sample at 2×, roughly double with Twist.
