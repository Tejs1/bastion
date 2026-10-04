// Node sim benchmark + behaviour fingerprint, for fast optimisation loops.
//   node tools/simbench.mjs [--ticks=3600] [--reps=3]
// Prints stress ms/tick (best of reps) and state hashes for the stress
// scenario and for a full bot game on both maps. A pure performance refactor
// must leave every hash unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['util', 'data', 'map', 'sim', 'bot', 'stress']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js/core', `${f}.js`), 'utf8'), { filename: `${f}.js` });
}
const TD = globalThis.TD;
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}`)); return a ? (a.split('=')[1] ?? true) : d; };
const ticks = +arg('ticks', 3600), reps = +arg('reps', 3);

let best = null, stressHash = 0;
for (let r = 0; r < reps; r++) {
  const sim = new TD.Sim({ map: 0, difficulty: 'normal', seed: 1 });
  TD.setupStress(sim);
  const times = new Float64Array(ticks);
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    sim.step();
    times[i] = performance.now() - t0;
  }
  const s = Array.from(times.subarray(600)).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const res = { mean, p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], e: sim.eCount, p: sim.pCount };
  if (!best || res.mean < best.mean) best = res;
  stressHash = sim.hash();
}
const games = [];
for (const map of [0, 1]) {
  const sim = new TD.Sim({ map, difficulty: 'normal', seed: 7 });
  const bot = new TD.Bot(sim, { skill: 1 });
  while (sim.state !== 'victory' && sim.state !== 'defeat' && sim.tick < 60 * 60 * 120) { bot.update(); sim.step(); }
  games.push(`${sim.state}/w${sim.wave}/${sim.hash()}`);
}
console.log(`stress ms/tick mean ${best.mean.toFixed(3)} p50 ${best.p50.toFixed(3)} p95 ${best.p95.toFixed(3)}  (enemies ${best.e}, projectiles ${best.p})`);
console.log(`hash stress ${stressHash}  games ${games.join('  ')}`);
