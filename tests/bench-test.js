// Bench checks: the built page is up to date, and the bench's audio worklet plays every test preset
// exactly as its WAV (tools/render-presets.js), sample for sample, while it measures and draws the
// live view. Run: node tests/bench-test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const { renderPreset } = require(path.join(root, 'tools', 'render-presets.js'));
const { PRESETS } = require(path.join(root, 'reference', 'presets.js'));

let count = 0, failed = 0;
function check(name, ok, info) { count++; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : '')); }

// 1. tools/pretzel.html matches its sources
let upToDate = true;
try { execFileSync(process.execPath, [path.join(root, 'tools', 'bench', 'build.js'), '--check'], { stdio: 'pipe' }); } catch (e) { upToDate = false; }
check('1. tools/pretzel.html is built from the current engine, processor, presets and template', upToDate);

// 2. the worklet code from the page, run in a sandbox that stands in for the AudioWorklet scope
const html = fs.readFileSync(path.join(root, 'tools', 'pretzel.html'), 'utf8');
const dsp = /<script type="text\/plain" id="dsp">\n([\s\S]*?)<\/script>/.exec(html)[1];
function makeProcessor() {
  let Cls = null;
  const sandbox = {
    sampleRate: 48000, performance: { now: () => 0 },
    AudioWorkletProcessor: class { constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); }, onmessage: null }; } },
    registerProcessor: (name, c) => { Cls = c; },
  };
  vm.createContext(sandbox);
  vm.runInContext(dsp, sandbox);
  const p = new Cls();
  p.send = (m) => p.port.onmessage({ data: m });
  return p;
}
const SR = 48000, BL = 128;
let worst = 0, bad = [];
let stats = 0, drawn = 0;
for (const pr of PRESETS) {
  const want = renderPreset(pr).L;
  const p = makeProcessor();
  p.send({ t: 'voices', n: 8 });
  p.send({ t: 'many', p: pr.params });
  p.send({ t: 'play', pr: { phrase: pr.phrase, steps: pr.steps || [], sweeps: pr.sweeps || [] } });
  const L = new Float32Array(BL), R = new Float32Array(BL), got = new Float32Array(want.length);
  for (let i = 0; i < want.length; i += BL) {
    p.process([], [[L, R]]);
    got.set(L.subarray(0, Math.min(BL, want.length - i)), i);
  }
  let d = 0; for (let i = 0; i < want.length; i++) d = Math.max(d, Math.abs(got[i] - want[i]));
  if (d > 0) bad.push(pr.name);
  worst = Math.max(worst, d);
  for (const m of p.port.posted) if (m.t === 'stat') { stats++; if (m.lines.length) drawn++; }
}
check('2. the bench plays all ' + PRESETS.length + ' test presets exactly as their WAVs, with the live view running', worst === 0, bad.length ? bad.join(', ') : 'max difference ' + worst);
check('2. the live view gets a frame 30 times a second, with a voice in most', stats > 30 * 60 && drawn > stats * 0.6, stats + ' frames, ' + drawn + ' with a voice');

// 3. a frame of the live view: the wave, the read phase and the transfer curve, for each line sounding
{
  const p = makeProcessor();
  p.send({ t: 'many', p: { lines: 3, wave1: 0, warp1: 0.6, wenvdepth1: 0, sfamily2: 1, shape2: 0.5, senvdepth2: 0 } });
  p.send({ t: 'on', n: 60, v: 100 });
  const L = new Float32Array(BL);
  for (let i = 0; i < 40; i++) p.process([], [[L]]);
  const st = p.port.posted.filter((m) => m.t === 'stat').pop();
  const l1 = st.lines.find((l) => l.L === 1), l2 = st.lines.find((l) => l.L === 2);
  const finite = (a) => a.every(Number.isFinite);
  // the warped Saw reads the first half of the cosine in less than half the cycle
  const half = l1.read.findIndex((u) => u >= 0.5) / l1.read.length;
  check('3. a frame shows both lines; line 1 Saw at Warp 0.6 reads half the cosine early', !!(l1 && l2) && finite(l1.wave) && finite(l2.xfer) && half > 0 && half < 0.2, half.toFixed(3));
  const pre = p.port.posted.length;
  p.send({ t: 'voices', n: 2 });
  for (const n of [48, 52, 55, 59]) p.send({ t: 'on', n, v: 100 });
  for (let i = 0; i < 20; i++) p.process([], [[L]]);
  const st2 = p.port.posted.slice(pre).filter((m) => m.t === 'stat').pop();
  check('3. Bench poly voices 2 plays two voices at most', st2.voices <= 2 && st2.max === 2, st2.voices + ' of ' + st2.max);
}

console.log('\n' + (count - failed) + ' of ' + count + ' tests passed');
process.exit(failed ? 1 : 0);
