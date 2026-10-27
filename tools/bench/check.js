// Opens tools/pretzel.html in headless Chromium (Playwright), powers it on, plays every test preset
// for a moment, opens every page, and fails on any console error or warning. Saves screenshots.
// Run: node tools/bench/check.js [out-dir]   (needs Playwright; not run on the Mac runner)
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const out = process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'tests');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 1400 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, '..', 'pretzel.html'));
  await p.click('#powerBtn');
  await p.waitForTimeout(400);
  const names = await p.$$eval('#presetSel option', (o) => o.map((x) => x.textContent));
  let maxLoad = 0, silent = [];
  for (let i = 0; i < names.length; i++) {
    await p.selectOption('#presetSel', String(i));
    await p.click('#presetPlay');
    await p.waitForTimeout(700);
    const [vo, cpu] = await p.evaluate(() => [document.getElementById('roVo').textContent, document.getElementById('roCpu').textContent]);
    if (vo.startsWith('0/')) silent.push(names[i]);
    maxLoad = Math.max(maxLoad, parseFloat(cpu));
  }
  for (const t of ['l2', 'voice', 'mod', 'l1']) { await p.click('#tab-' + t); await p.waitForTimeout(100); }
  // the picture for tests.md: CZ Duo (two lines) and Knot to chaos (Twist), screen only
  for (const [name, file, wait] of [['CZ Duo', '10-bench-duo.png', 1200], ['Knot to chaos', '10-bench-knot.png', 3500]]) {
    await p.selectOption('#presetSel', String(names.indexOf(name)));
    await p.click('#presetPlay');
    await p.waitForTimeout(wait);
    await (await p.$('.screen')).screenshot({ path: path.join(out, file) });
  }
  await p.selectOption('#presetSel', String(names.indexOf('CZ Brass')));
  await p.click('#presetPlay');
  await p.waitForTimeout(1000);
  await p.screenshot({ path: path.join(out, '10-bench.png'), fullPage: true });
  await b.close();
  console.log(names.length + ' presets played; no voice: ' + (silent.join(', ') || 'none') + '; highest DSP reading ' + maxLoad + '%');
  console.log(errs.length ? 'console: ' + errs.join(' | ') : 'no console errors or warnings');
  process.exit(errs.length || silent.length ? 1 : 0);
})();
