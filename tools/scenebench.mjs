// Main-thread render-CPU microbenchmark: freezes one stress-scenario state and
// times Scene.build (+ renderer upload) repeatedly under DevTools CPU throttling.
//   node tools/scenebench.mjs [--throttle=20] [--iters=300] [--url=http://127.0.0.1:8765/index.html]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}`)); return a ? (a.split('=')[1] ?? true) : d; };
const thr = +arg('throttle', 20), iters = +arg('iters', 300);
const base = arg('url', `file://${path.join(root, 'index.html')}`);
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto(`${base}?stress&benchdur=600`);
await page.waitForTimeout(5000);
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
const r = await page.evaluate((n) => {
  const g = window.__td;
  g.setPaused(true);
  const fx = g.fx, sim = g.sim, sc = g.scene;
  // freeze fx too: snapshot particle lifetimes so every iteration draws the same set
  const life = fx.life.slice();
  const t = new Float64Array(n), up = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fx.life.set(life);
    const t0 = performance.now();
    sc.build(sim, fx, g.rc, g.view, 0.5, g, 1);
    const t1 = performance.now();
    g.renderer.flush(g.rc, 'bg', 'atlas', g.bgRect, [0, 0, 0]);
    t[i] = t1 - t0; up[i] = performance.now() - t1;
  }
  const q = (a, f) => Array.from(a).sort((x, y) => x - y)[Math.floor(a.length * f)];
  return { sprites: sc.stats.instances, buildP50: +q(t, 0.5).toFixed(3), buildMean: +(t.reduce((a, b) => a + b) / n).toFixed(3), flushP50: +q(up, 0.5).toFixed(3) };
}, iters);
console.log(JSON.stringify({ throttle: thr, ...r }));
await browser.close();
