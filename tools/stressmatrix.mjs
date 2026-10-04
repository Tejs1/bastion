// Stress matrix: game speed × Chrome CPU throttling, real Chrome + real GPU.
//   node tools/stressmatrix.mjs --label=baseline [--throttle=1,4,6,20] [--speeds=1,2,4,8,12]
//                               [--warm=3] [--dur=8] [--url=https://…] [--headed]
// Each cell opens a fresh tab, applies CDP Emulation.setCPUThrottlingRate (the
// same knob as DevTools' "CPU: N× slowdown"), loads ?stress at the given game
// speed and reads the in-game benchmark (window.__benchResult). Every cell is
// appended to perf/results.jsonl and the matrix is written to perf/runs/<label>.md.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}`)); return a ? (a.split('=')[1] ?? true) : d; };
const list = (s) => String(s).split(',').map(Number);

const label = arg('label', 'run');
const throttles = list(arg('throttle', '1,4,6,20'));
const speeds = list(arg('speeds', '1,2,4,8,12'));
const warm = +arg('warm', 3), dur = +arg('dur', 8);
const base = arg('url', `file://${path.join(root, 'index.html')}`);
const [w, h] = String(arg('size', '1920x1080')).split('x').map(Number);
let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a repo */ }
const dirty = (() => { try { return execSync('git status --porcelain js', { cwd: root }).toString().trim() !== ''; } catch { return false; } })();

const browser = await pw.chromium.launch({ channel: 'chrome', headless: !arg('headed', false) });
const gpu = await (async () => {
  const p = await browser.newPage();
  const r = await p.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const e = gl?.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await p.close();
  return r;
})();

// A cell passes when it holds 45 FPS on >= 95% of frames, < 5% of frames over
// 33 ms, and simulates >= 98% of the requested game speed.
const pass = (r) => r.pctAt45 >= 0.95 && r.pctOver33 < 0.05 && r.simRate >= 0.98;

const rows = [];
for (const thr of throttles) {
  for (const sp of speeds) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
    const sep = base.includes('?') ? '&' : '?';
    await page.goto(`${base}${sep}stress&speed=${sp}&benchwarm=${warm}&benchdur=${dur}`, { timeout: 300000 });
    let r;
    try {
      await page.waitForFunction(() => window.__benchResult, null, { timeout: (warm + dur) * 1000 * 6 + 120000, polling: 500 });
      r = await page.evaluate(() => window.__benchResult);
    } catch (e) {
      r = { error: String(e.message || e).slice(0, 200) };
    }
    await ctx.close();
    const row = { ts: new Date().toISOString(), label, sha, dirty, gpu, throttle: thr, speed: sp, ...r, errors };
    row.pass = !r.error && pass(r);
    rows.push(row);
    fs.appendFileSync(path.join(root, 'perf/results.jsonl'), `${JSON.stringify(row)}\n`);
    console.log(r.error ? `cpu ${thr}x speed ${sp}x ERROR ${r.error}`
      : `cpu ${String(thr).padStart(2)}x speed ${String(sp).padStart(2)}x  fps ${r.avgFps.toFixed(1).padStart(5)}  p95 ${r.p95.toFixed(1).padStart(6)}ms  >33ms ${(r.pctOver33 * 100).toFixed(1).padStart(5)}%  cpu ${r.cpuAvg.toFixed(2).padStart(6)}ms (sim ${r.simAvg.toFixed(2)} + render ${r.renderAvg.toFixed(2)})  ms/tick ${r.simPerTick.toFixed(3)}  speed achieved ${(r.simRate * sp).toFixed(2)}x  ${row.pass ? 'PASS' : 'FAIL'}`);
  }
}
await browser.close();

// ---- markdown summary
const f = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));
let md = `# Stress matrix — ${label}\n\n`;
md += `commit \`${sha}\`${dirty ? ' (+uncommitted js changes)' : ''} · ${new Date().toISOString()} · ${w}×${h}@1 · GPU: ${gpu}\n`;
md += `Scenario: \`?stress\` (5 000 enemies, 100 towers, ≥ 1 000 projectiles), ${warm} s warm-up + ${dur} s sampled per cell.\n\n`;
md += '| CPU throttle | speed | avg FPS | p50 / p95 / p99 ms | > 33 ms | CPU/frame ms | sim ms | render ms | ms/tick | ticks/frame | speed achieved | result |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const r of rows) {
  if (r.error) { md += `| ${r.throttle}× | ${r.speed}× | error: ${r.error} |||||||||| FAIL |\n`; continue; }
  md += `| ${r.throttle}× | ${r.speed}× | ${f(r.avgFps)} | ${f(r.p50)} / ${f(r.p95)} / ${f(r.p99)} | ${f(r.pctOver33 * 100)}% | ${f(r.cpuAvg, 2)} | ${f(r.simAvg, 2)} | ${f(r.renderAvg, 2)} | ${f(r.simPerTick, 3)} | ${f(r.ticksPerFrame, 2)} | ${f(r.simRate * r.speed, 2)}× | ${r.pass ? '✅' : '❌'} |\n`;
}
md += '\nBreaking point (highest passing speed per throttle):\n\n';
for (const thr of throttles) {
  const ok = rows.filter((r) => r.throttle === thr && r.pass).map((r) => r.speed);
  md += `- CPU ${thr}×: ${ok.length ? `passes up to ${Math.max(...ok)}×` : 'fails at every speed'}\n`;
}
fs.mkdirSync(path.join(root, 'perf/runs'), { recursive: true });
fs.writeFileSync(path.join(root, `perf/runs/${label}.md`), md);
console.log(`\nwrote perf/runs/${label}.md`);
