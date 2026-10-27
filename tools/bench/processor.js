/* AudioWorklet wrapper: pretzel engine → stereo output, plus the data for the live view.
   Runs after pretzel-engine.js, which leaves PretzelEngine on the worklet's global scope. */
const VIEW_N = 256;     // points per cycle in the live view
const XFER_N = 65;      // points on the transfer curve
class PretzelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.eng = new PretzelEngine(sampleRate, 1234);
    this.all = this.eng.voices.slice();
    this.setVoices(4);
    this.core = PretzelEngine.core;
    this.vizEvery = Math.round(sampleRate / 30); this.vizCount = 0;
    // a test preset's phrase, played to the sample as tools/render-presets.js does
    this.ev = null; this.evAt = 0; this.evPos = 0; this.sweeps = null;
    this.moved = {};      // parameters the phrase moved since the last frame, so the page's knobs follow
    // DSP load: time spent in the engine / length of audio produced
    this.hiRes = typeof performance !== 'undefined' && typeof performance.now === 'function';
    this.clock = this.hiRes ? () => performance.now() : () => Date.now();
    this.busyMs = 0; this.audioMs = 0; this.load = 0; this.peak = 0; this.winPeak = 0; this.peakAge = 0;
    this.port.onmessage = (e) => {
      const m = e.data, eng = this.eng;
      if (m.t === 'p') eng.setParam(m.id, m.v);
      else if (m.t === 'many') { for (const k in m.p) eng.setParam(k, m.p[k]); }
      else if (m.t === 'on') eng.noteOn(m.n, m.v);
      else if (m.t === 'off') eng.noteOff(m.n);
      else if (m.t === 'bend') eng.setBend(m.v);
      else if (m.t === 'wheel') eng.setModWheel(m.v);
      else if (m.t === 'press') eng.setAftertouch(m.v);
      else if (m.t === 'tempo') eng.setTempo(m.v);
      else if (m.t === 'curve') eng.setCurve(m.line, m.key, m.pts, true);
      else if (m.t === 'voices') { eng.allNotesOff(); this.setVoices(m.n); }
      else if (m.t === 'play') this.play(m.pr);
      else if (m.t === 'panic') { this.ev = null; this.sweeps = null; eng.allNotesOff(); }
    };
    this.port.postMessage({ t: 'ready', sr: sampleRate });
  }
  // the bench can play fewer voices than the engine has (design.md §14): new notes then steal sooner
  setVoices(n) {
    for (const v of this.all) if (v.active) { v.release(); }
    this.eng.voices = this.all.slice(0, Math.max(1, Math.min(this.all.length, n)));
    for (const v of this.all.slice(this.eng.voices.length)) { v.active = false; v.held = false; for (const l of v.lines) l.on = false; }
  }
  play(pr) {
    const ev = [];
    for (const [note, t, d, vel] of pr.phrase) { ev.push([Math.round(t * sampleRate), 1, note, vel || 100]); ev.push([Math.round((t + d) * sampleRate), 0, note]); }
    for (const s of pr.steps || []) ev.push([Math.round(s.time * sampleRate), 2, s.params]);
    ev.sort((a, b) => a[0] - b[0] || (a[1] === 2 ? -1 : b[1] === 2 ? 1 : a[1] - b[1]));
    this.ev = ev; this.evPos = 0; this.evAt = 0; this.sweeps = pr.sweeps || null;
    this.eng.allNotesOff();
  }
  // events of the playing phrase that fall in the next n samples (whole blocks, as the renderer does)
  runPhrase(n) {
    const e = this.eng, ev = this.ev;
    while (this.evPos < ev.length && ev[this.evPos][0] < this.evAt + n) {
      const [, type, a, b] = ev[this.evPos++];
      if (type === 1) e.noteOn(a, b); else if (type === 0) e.noteOff(a); else for (const id in a) { e.setParam(id, a[id]); this.moved[id] = a[id]; }
    }
    if (this.sweeps) {
      const t = this.evAt / sampleRate, bl = n / sampleRate;
      for (const sw of this.sweeps) if (t >= sw.start - bl && t <= sw.end + bl) {
        const v = sw.from + (sw.to - sw.from) * Math.min(1, Math.max(0, (t - sw.start) / (sw.end - sw.start)));
        if (sw.id === 'wheel') e.setModWheel(v); else if (sw.id === 'aftertouch') e.setAftertouch(v); else e.setParam(sw.id, v);
        this.moved[sw.id] = v;
      }
    }
    this.evAt += n;
    if (this.evPos >= ev.length && (!this.sweeps || this.sweeps.every((s) => this.evAt / sampleRate > s.end + 0.05))) { this.ev = null; this.sweeps = null; this.port.postMessage({ t: 'done' }); }
  }
  // one line of a voice as the live view draws it: the wave over one cycle, the phase the warp reads
  // (with the shaper on the phase), and the transfer curve at the Shape it has now
  lineView(ln) {
    const c = this.core, k = ln.k, pre = ln.pre, sh = ln.sh, s = ln.sPost, p = ln.wp, kr = ln.wk;
    const w = k.w0, win = k.win, toff = k.twist ? ln.toff : 0;
    const wave = new Float32Array(VIEW_N), read = new Float32Array(VIEW_N), xfer = new Float32Array(XFER_N);
    for (let i = 0; i < VIEW_N; i++) {
      const ph = i / VIEW_N, r0 = ph + toff, r = r0 - Math.floor(r0);
      const u = pre.s > 0 ? c.prePhase(sh, r, pre.s, pre.def) : r;
      read[i] = c.warpU(w, u, p, kr);
      wave[i] = c.shapeSample(sh, c.waveAt(w, win, ph, p, kr, pre, r), s);
    }
    const sAll = pre.s + s;
    for (let i = 0; i < XFER_N; i++) xfer[i] = c.shapeSample(sh, -1 + 2 * i / (XFER_N - 1), sAll);
    return { L: ln.L, src: ln.src, hz: k.hz, warp: ln.warpAt(ln.wenv.v), shape: sAll, pre: pre.s, post: s,
      order: k.order, tm: k.tm, twist: k.twist, toff, amp: ln.aenv.v, wave, read, xfer };
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] || null, n = l.length;
    const t0 = this.clock();
    if (this.ev) this.runPhrase(n);
    this.eng.process(l, r, n);
    const spent = this.clock() - t0, len = n / sampleRate * 1000;
    this.busyMs += spent; this.audioMs += len;
    if (this.hiRes && spent / len > this.winPeak) this.winPeak = spent / len;
    if (this.audioMs >= 500) {
      this.load = this.busyMs / this.audioMs; this.busyMs = 0; this.audioMs = 0;
      if (this.winPeak >= this.peak || ++this.peakAge >= 4) { this.peak = this.winPeak; this.peakAge = 0; }
      this.winPeak = 0;
    }
    this.vizCount += n;
    if (this.vizCount >= this.vizEvery) {
      this.vizCount = 0;
      const e = this.eng;
      // the newest sounding voice is the one shown
      let v = null; for (const x of e.voices) if (x.active && (!v || x.age > v.age)) v = x;
      const msg = { t: 'stat', voices: e.info.voices, max: e.voices.length, load: this.load, peak: this.hiRes ? this.peak : -1, lines: [], moved: this.moved };
      this.moved = {};
      if (v) for (const ln of v.lines) if (ln.on) msg.lines.push(this.lineView(ln));
      this.port.postMessage(msg);
    }
    return true;
  }
}
registerProcessor('pretzel-processor', PretzelProcessor);
