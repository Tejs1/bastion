// Stress benchmark in headless Chromium.
//   node tools/bench.mjs [--size=1920x1080] [--dpr=1] [--gpu] [--canvas2d]
// Opens index.html?stress, lets the in-game benchmark run (3 s warm-up + 20 s
// sampling of every requestAnimationFrame) and prints window.__benchResult.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k)); return a ? (a.split('=')[1] ?? true) : d; };
const [w, h] = String(arg('size', '1920x1080')).split('x').map(Number);
const dpr = +arg('dpr', 1);
// --gpu       : use the machine's real GPU (run headed or on a GPU host)
// (default)   : ANGLE + SwiftShader software rasteriser — works anywhere, and is
//               a deliberately pessimistic stand-in for real graphics hardware.
// --llvmpipe  : headed Chromium (needs an X display, e.g. Xvfb) using Mesa's
//               llvmpipe — the fastest software rasteriser available without a GPU.
const flags = arg('gpu', false) ? ['--enable-gpu', '--ignore-gpu-blocklist']
  : arg('llvmpipe', false) ? ['--use-angle=gl', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const headless = !arg('headed', false) && !arg('llvmpipe', false);
// --unthrottled: rAF runs as fast as possible (measures headroom, not vsync-capped FPS)
const extra = arg('unthrottled', false) ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await pw.chromium.launch({ headless, args: [...flags, ...extra] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// --lockstep: exactly one 60 Hz sim tick per rendered frame, so per-frame CPU
//             cost is measured as it would be on a 60 Hz display even when the
//             (software) GPU makes frames slow.  --nodrs: fixed resolution.
const q = 'stress' + (arg('canvas2d', false) ? '&canvas2d' : '') + (arg('lockstep', false) ? '&lockstep' : '') + (arg('nodrs', false) ? '&nodrs' : '');
await page.goto('file://' + path.join(root, 'index.html') + '?' + q);
if (arg('cpu', false)) {
  // Pure CPU frame budget in the real browser engine: per 60 Hz frame we run
  // one sim tick + fx update + full scene build (instance buffer fill), with
  // the stress scenario live (5000 enemies / 100 towers / >=1000 projectiles).
  // GPU submission is excluded so a software GPU can't distort the numbers.
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const g = window.__td; g.paused = true;
    const N = 1800, sim = new Float64Array(N), scene = new Float64Array(N), tot = new Float64Array(N);
    let e = 0, p = 0, spr = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      g.sim.step();
      const t1 = performance.now();
      g.fx.update(1 / 60, 1 / 60);
      g.scene.build(g.sim, g.fx, g.rc, g.view, 1, g, i / 60);
      const t2 = performance.now();
      sim[i] = t1 - t0; scene[i] = t2 - t1; tot[i] = t2 - t0;
      e += g.sim.eCount; p += g.sim.pCount; spr += g.scene.stats.instances;
    }
    const q = (a, f) => { const b = Array.from(a).sort((x, y) => x - y); return +b[Math.floor(b.length * f)].toFixed(3); };
    const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
    return { frames: N, avgEnemies: Math.round(e / N), avgProjectiles: Math.round(p / N), towers: g.sim.towers.length, avgSprites: Math.round(spr / N),
      simAvg: avg(sim), simP95: q(sim, 0.95), sceneAvg: avg(scene), sceneP95: q(scene, 0.95),
      frameCpuAvg: avg(tot), frameCpuP50: q(tot, 0.5), frameCpuP95: q(tot, 0.95), frameCpuP99: q(tot, 0.99), frameCpuMax: q(tot, 1 - 1e-9),
      over22ms: tot.filter(x => x > 1000 / 45).length, over33ms: tot.filter(x => x > 33.3).length };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
  process.exit(0);
}
await page.waitForFunction(() => window.__benchResult, null, { timeout: 120000, polling: 500 });
const res = await page.evaluate(() => window.__benchResult);
console.log(JSON.stringify({ viewport: `${w}x${h}@${dpr}`, ...res }, null, 2));
if (arg('zoomtest', false)) {
  // culling check: render CPU + sprite count at fit zoom vs zoomed in
  for (const z of [1, 2, 4]) {
    const r = await page.evaluate(async (z) => {
      const g = window.__td; g.cam.zoom = g.fitZoom * z; g.userCam = true; g.clampCam();
      await new Promise(r => setTimeout(r, 2500));
      let sum = 0, n = 0; for (let i = 1; i <= 30; i++) { sum += g.fRender[(g.fHead - i + 600) % 600]; n++; }
      return { zoom: z, visibleEnemies: g.scene.stats.visibleEnemies, sprites: g.scene.stats.instances, renderCpuMs: +(sum / n).toFixed(2) };
    }, z);
    console.log(JSON.stringify(r));
  }
}
if (arg('shot', false)) await page.screenshot({ path: arg('shot'), timeout: 120000 });
if (errors.length) console.log('errors:', errors);
await browser.close();
