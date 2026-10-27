// Builds tools/pretzel.html: the reference engine and the worklet wrapper inlined into one page,
// plus the parameter table, the engine's lists and the test presets. Run: node tools/bench/build.js
// (node tools/bench/build.js --check: fail if tools/pretzel.html is not up to date)
'use strict';
const fs = require('fs'), path = require('path');
const d = __dirname, ref = path.join(d, '..', '..', 'reference');
const enginePath = path.join(ref, 'pretzel-engine.js');
const dsp = [enginePath, path.join(d, 'processor.js')].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const presets = fs.readFileSync(path.join(ref, 'presets.js'), 'utf8');
// the page takes ids, ranges and defaults from the engine's own table, so they can't drift
const E = require(enginePath), c = E.core;
const lists = {
  PARAMS: E.PARAMS, DEST_IDS: E.DEST_IDS, LINE_SELECT: E.LINE_SELECT, LFO_SHAPES: E.LFO_SHAPES, SYNC_BEATS: E.SYNC_BEATS,
  WAVES: c.WAVES, WINDOWS: c.WINDOWS, FAMILIES: c.FAMILIES, SHAPERS: c.SHAPERS, FOLDS: c.FOLDS, SATS: c.SATS, ORDERS: c.ORDERS, NH: c.NH,
  // the default drawn keyframes, 33 points each (the editor's resolution)
  CURVES: c.DEFAULT_CURVES.map((y) => Array.from({ length: 33 }, (_, i) => +y[i * (y.length - 1) / 32].toFixed(4))),
};
const params = 'window.PRETZEL = ' + JSON.stringify(lists) + ';';
for (const [name, src] of [['DSP', dsp], ['presets', presets]]) if (/<\/script/i.test(src)) throw new Error(name + ' source contains </script');
const tpl = fs.readFileSync(path.join(d, 'template.html'), 'utf8');
for (const ph of ['/*__DSP__*/', '/*__PRESETS__*/', '/*__PARAMS__*/']) if (tpl.split(ph).length !== 2) throw new Error('placeholder missing: ' + ph);
const html = tpl.replace('/*__DSP__*/', () => dsp).replace('/*__PRESETS__*/', () => presets).replace('/*__PARAMS__*/', () => params);
const out = path.join(d, '..', 'pretzel.html');
if (process.argv.includes('--check')) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now !== html) { console.error('tools/pretzel.html is out of date: run node tools/bench/build.js'); process.exit(1); }
  console.log('tools/pretzel.html is up to date');
} else {
  fs.writeFileSync(out, html);
  console.log('tools/pretzel.html', Math.round(fs.statSync(out).size / 1024), 'KB');
}
