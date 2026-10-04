// DevTools CPU profile of the stress scenario under CPU throttling.
//   node tools/profile.mjs [--throttle=4] [--speed=8] [--secs=6] [--top=25] [--out=perf/profiles/x.cpuprofile]
// Uses the Chrome DevTools Protocol directly (Emulation.setCPUThrottlingRate +
// Profiler.start/stop), prints functions ranked by self time and optionally
// saves the .cpuprofile (open it in DevTools > Performance to inspect).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}`)); return a ? (a.split('=')[1] ?? true) : d; };
const thr = +arg('throttle', 4), speed = +arg('speed', 8), secs = +arg('secs', 6), top = +arg('top', 25);

const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
const base = arg('url', `file://${path.join(root, 'index.html')}`);   // e.g. --url=http://127.0.0.1:8765/index.html (worker mode)
await page.goto(`${base}?stress&speed=${speed}&benchdur=600&workerslow=${thr}`);
await page.waitForTimeout(4000);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('Profiler.stop');
await browser.close();

const out = arg('out', '');
if (out) { fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true }); fs.writeFileSync(path.resolve(root, out), JSON.stringify(profile)); }

// self time per node = samples hitting it × average interval
const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
const hits = new Map();
for (const s of profile.samples) hits.set(s, (hits.get(s) || 0) + 1);
const agg = new Map();
let total = 0;
for (const n of profile.nodes) {
  const c = hits.get(n.id) || 0;
  total += c;
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url ? `${path.basename(f.url)}:${f.lineNumber + 1}` : ''}`.trim();
  agg.set(key, (agg.get(key) || 0) + c);
}
const rows = [...agg].sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`CPU ${thr}x, speed ${speed}x, ${secs}s, ${total} samples`);
for (const [k, c] of rows) console.log(`${(c / total * 100).toFixed(1).padStart(5)}%  ${(c * dt).toFixed(0).padStart(6)} ms  ${k}`);
