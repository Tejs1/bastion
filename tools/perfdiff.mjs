// Compare two stress-matrix runs from perf/results.jsonl.
//   node tools/perfdiff.mjs <labelA> <labelB>
// Prints per-cell sim ms/tick, frame CPU, FPS and achieved speed with % change,
// plus the geometric-mean change of ms/tick and frame CPU across all cells.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [a, b] = process.argv.slice(2);
const rows = fs.readFileSync(path.join(root, 'perf/results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pick = (label) => {
  const m = new Map();
  for (const r of rows) if (r.label === label && !r.error) m.set(`${r.throttle}/${r.speed}`, r); // last run of a label wins
  return m;
};
const A = pick(a), B = pick(b);
const pct = (x, y) => `${((y / x - 1) * 100).toFixed(1)}%`;
let lt = 0, lc = 0, n = 0, passA = 0, passB = 0;
console.log(`| CPU | speed | ms/tick ${a} → ${b} | frame CPU ms | avg FPS | speed achieved | pass |`);
console.log('|---|---|---|---|---|---|---|');
for (const [k, ra] of A) {
  const rb = B.get(k);
  if (!rb) continue;
  n++; lt += Math.log(rb.simPerTick / ra.simPerTick); lc += Math.log(rb.cpuAvg / ra.cpuAvg);
  passA += ra.pass ? 1 : 0; passB += rb.pass ? 1 : 0;
  console.log(`| ${ra.throttle}× | ${ra.speed}× | ${ra.simPerTick.toFixed(3)} → ${rb.simPerTick.toFixed(3)} (${pct(ra.simPerTick, rb.simPerTick)}) | ${ra.cpuAvg.toFixed(1)} → ${rb.cpuAvg.toFixed(1)} (${pct(ra.cpuAvg, rb.cpuAvg)}) | ${ra.avgFps.toFixed(1)} → ${rb.avgFps.toFixed(1)} | ${(ra.simRate * ra.speed).toFixed(2)}× → ${(rb.simRate * rb.speed).toFixed(2)}× | ${ra.pass ? '✅' : '❌'} → ${rb.pass ? '✅' : '❌'} |`);
}
console.log(`\nGeomean over ${n} cells: sim ms/tick ${((Math.exp(lt / n) - 1) * 100).toFixed(1)}%, frame CPU ${((Math.exp(lc / n) - 1) * 100).toFixed(1)}%; passing cells ${passA} → ${passB}`);
