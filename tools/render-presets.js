// Renders every test preset to a WAV in renders/ (48 kHz, 24-bit, stereo).
// Run: node tools/render-presets.js [out-dir]
'use strict';
const fs = require('fs'), path = require('path');
const { PretzelEngine } = require(path.join(__dirname, '..', 'reference', 'pretzel-engine.js'));
const { PRESETS } = require(path.join(__dirname, '..', 'reference', 'presets.js'));

const SR = 48000, BL = 128;
const outDir = process.argv[2] || path.join(__dirname, '..', 'renders');
fs.mkdirSync(outDir, { recursive: true });

function wav24(L, R) {
  const n = L.length, data = Buffer.alloc(n * 6);
  for (let i = 0; i < n; i++) for (const [c, x] of [[0, L[i]], [1, R[i]]]) {
    const v = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
    data.writeIntLE(v, i * 6 + c * 3, 3);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// one preset → { L, R, seconds, ms }
function renderPreset(pr) {
  const e = new PretzelEngine(SR, 1234);
  for (const k in pr.params) e.setParam(k, pr.params[k]);
  const end = Math.max(...pr.phrase.map(([, t, d]) => t + d)) + 0.8;
  const n = Math.round(end * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const ev = [];
  for (const [note, t, d, vel] of pr.phrase) {
    ev.push([Math.round(t * SR), 1, note, vel || 100]);
    ev.push([Math.round((t + d) * SR), 0, note]);
  }
  for (const s of pr.steps || []) ev.push([Math.round(s.time * SR), 2, s.params]);
  // at the same sample: parameter steps, then note-offs, then note-ons
  ev.sort((a, b) => a[0] - b[0] || (a[1] === 2 ? -1 : b[1] === 2 ? 1 : a[1] - b[1]));
  const tl = new Float32Array(BL), tr = new Float32Array(BL);
  let k = 0;
  const t0 = Date.now();
  for (let i = 0; i < n; i += BL) {
    while (k < ev.length && ev[k][0] < i + BL) {
      const [, type, a, b] = ev[k++];
      if (type === 1) e.noteOn(a, b); else if (type === 0) e.noteOff(a); else for (const id in a) e.setParam(id, a[id]);
    }
    const m = Math.min(BL, n - i);
    e.process(tl, tr, m);
    L.set(tl.subarray(0, m), i); R.set(tr.subarray(0, m), i);
  }
  return { L, R, seconds: end, ms: Date.now() - t0 };
}

if (require.main === module) {
  PRESETS.forEach((pr, idx) => {
    const { L, R, seconds, ms } = renderPreset(pr);
    let pk = 0; for (const v of L) pk = Math.max(pk, Math.abs(v));
    const file = path.join(outDir, String(idx + 1).padStart(2, '0') + ' ' + pr.name.replace(/[^\w ()-]/g, '') + '.wav');
    fs.writeFileSync(file, wav24(L, R));
    console.log(path.basename(file).padEnd(34), 'peak', pk.toFixed(3), ' render', (ms / 1000 / seconds * 100).toFixed(1) + '% of real time');
  });
}
module.exports = { renderPreset, wav24 };
