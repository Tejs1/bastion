// Full 50-wave run in a real browser (AI autoplay at turbo speed) while
// sampling the JS heap after forced GC. Verifies memory stays flat.
//   node tools/longrun.mjs [--turbo=24] [--map=0] [--diff=normal]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}`)); return a ? a.split('=')[1] : d; };
const turbo = +arg('turbo', 24), map = +arg('map', 0), diff = arg('diff', 'normal');
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`file://${path.join(root, 'index.html')}?autoplay&turbo=${turbo}&map=${map}&diff=${diff}&nodrs`);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const samples = [];
let lastWave = -1;
const t0 = Date.now();
for (;;) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => { const g = window.__td, s = g.sim; return { wave: s.wave, state: s.state, lives: s.lives, enemies: s.eCount, towers: s.towers.length, kills: s.kills, particles: g.fx.count() }; });
  const done = s.state === 'victory' || s.state === 'defeat';
  if ((s.wave !== lastWave && s.wave % 5 === 0) || done) {
    lastWave = s.wave;
    await cdp.send('HeapProfiler.collectGarbage');
    const m = await cdp.send('Performance.getMetrics');
    const get = n => m.metrics.find(x => x.name === n).value;
    const row = { ...s, heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(2), totalMB: +(get('JSHeapTotalSize') / 1048576).toFixed(2), nodes: get('Nodes'), listeners: get('JSEventListeners'), secs: Math.round((Date.now() - t0) / 1000) };
    samples.push(row);
    console.log(JSON.stringify(row));
  }
  if (s.state === 'victory' || s.state === 'defeat') break;
  if (Date.now() - t0 > 25 * 60 * 1000) { console.log('timeout'); break; }
}
const hs = samples.map(s => s.heapMB);
console.log(`heap after GC: min ${Math.min(...hs)} MB, max ${Math.max(...hs)} MB over ${samples.length} samples`);
fs.writeFileSync(path.join(root, 'tools', 'longrun-result.json'), JSON.stringify({ turbo, map, diff, samples, errors }, null, 2));
if (errors.length) console.log('errors', errors);
await browser.close();
