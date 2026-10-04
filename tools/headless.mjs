// Headless simulation harness (Node). Loads the DOM-free core and runs it.
//   node tools/headless.mjs balance      bot plays every map/difficulty to the end
//   node tools/headless.mjs determinism  same inputs at 30/60/144/240 Hz + jitter -> same state hash
//   node tools/headless.mjs memory       full 50-wave run, heap sampled every wave
//   node tools/headless.mjs stress       sim-only cost of the 5000/100/1000 stress scenario
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['util', 'data', 'map', 'sim', 'bot', 'stress']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js/core', `${f}.js`), 'utf8'), { filename: `${f}.js` });
}
const TD = globalThis.TD;

function playGame(map, diff, botOpts, maxTicks = 60 * 60 * 120) {
  const sim = new TD.Sim({ map, difficulty: diff, seed: 7 });
  const bot = new TD.Bot(sim, botOpts);
  const t0 = performance.now();
  let maxE = 0, maxP = 0, lifeLog = [];
  let lastWave = 0;
  while (sim.state !== 'victory' && sim.state !== 'defeat' && sim.tick < maxTicks) {
    bot.update();
    sim.step();
    if (sim.eCount > maxE) maxE = sim.eCount;
    if (sim.pCount > maxP) maxP = sim.pCount;
    if (sim.wave !== lastWave) { lastWave = sim.wave; lifeLog.push(sim.lives); }
  }
  return { state: sim.state, wave: sim.wave, cleared: sim.wavesCleared, lives: sim.lives, gold: Math.floor(sim.gold),
    towers: sim.towers.length, levels: sim.towers.reduce((a, t) => a + t.level, 0), score: sim.score,
    minutes: (sim.tick / 3600).toFixed(1), ms: Math.round(performance.now() - t0), maxE, maxP,
    lifeLog: lifeLog.filter((_, i) => i % 5 === 4).join(',') };
}

const mode = process.argv[2] || 'balance';

if (mode === 'balance') {
  const profiles = [
    ['good bot', { skill: 1 }],
    ['lazy bot (75% towers)', { skill: 0.75 }],
    ['no upgrades', { skill: 1, upgrades: false }],
    ['blasters only', { skill: 1, towers: [0] }],
  ];
  for (let m = 0; m < TD.MAPS.length; m++) {
    for (const diff of ['easy', 'normal', 'hard']) {
      for (const [name, opts] of profiles) {
        const r = playGame(m, diff, opts);
        console.log(`${TD.MAPS[m].id.padEnd(10)} ${diff.padEnd(6)} ${name.padEnd(22)} -> ${r.state.padEnd(7)} wave ${String(r.wave).padStart(2)} lives ${String(r.lives).padStart(2)} towers ${r.towers} lv+${r.levels} gold ${r.gold} maxE ${r.maxE} maxP ${r.maxP} (${r.minutes} game-min, ${r.ms}ms) lives@5w ${r.lifeLog}`);
      }
    }
  }
}

if (mode === 'waves') {
  for (let w = 1; w <= 50; w++) {
    const s = TD.waveSummary(w, 2).map(g => `${TD.ENEMIES[g.type].id}x${g.count}`).join(' ');
    const hp = TD.buildWave(w, 2).reduce((a, g) => a + g.count * TD.ENEMIES[g.type].hp * g.hp * TD.hpMult(w), 0);
    console.log(`wave ${String(w).padStart(2)}  hpMult ${TD.hpMult(w).toFixed(2).padStart(5)}  totalHP ${Math.round(hp).toString().padStart(7)}  ${s}`);
  }
}

if (mode === 'determinism') {
  // Drive the sim through the same accumulator loop the browser uses, with
  // different "display refresh rates", and compare state at fixed ticks.
  const rates = [[30, 0], [60, 0], [144, 0], [240, 0], [60, 0.6], [75, 0.3]];
  const results = [];
  for (const [hz, jitter] of rates) {
    const sim = new TD.Sim({ map: 0, difficulty: 'normal', seed: 99 });
    const bot = new TD.Bot(sim, { skill: 1 });
    const loop = new TD.FixedLoop();
    let rnd = 1;
    const checkpoints = {};
    const targetTicks = [600, 3600, 18000, 36000];
    while (sim.tick < 36000 && sim.state !== 'defeat' && sim.state !== 'victory') {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      const frame = (1 / hz) * (1 + jitter * ((rnd / 0x7fffffff) * 2 - 1));
      loop.advance(frame, 1, () => {
        bot.update();          // inputs are applied at tick boundaries
        sim.step();
        if (targetTicks.includes(sim.tick)) checkpoints[sim.tick] = sim.hash();
      });
    }
    results.push({ hz, jitter, checkpoints });
    console.log(`${String(hz).padStart(3)} Hz jitter ${jitter}:`, JSON.stringify(checkpoints));
  }
  const ref = JSON.stringify(results[0].checkpoints);
  const ok = results.every(r => JSON.stringify(r.checkpoints) === ref);
  console.log(ok ? 'DETERMINISM OK: identical state at every checkpoint' : 'DETERMINISM FAILED');
  process.exit(ok ? 0 : 1);
}

if (mode === 'memory') {
  const sim = new TD.Sim({ map: 0, difficulty: 'easy', seed: 3 });
  const bot = new TD.Bot(sim, { skill: 1 });
  let last = 0;
  const samples = [];
  while (sim.state !== 'victory' && sim.state !== 'defeat') {
    bot.update(); sim.step();
    if (sim.wave !== last) {
      last = sim.wave;
      if (global.gc) global.gc();
      const mb = process.memoryUsage().heapUsed / 1048576;
      samples.push(mb);
      if (last % 5 === 0 || last === 1) console.log(`wave ${String(last).padStart(2)} heapUsed ${mb.toFixed(2)} MB  enemies ${sim.eCount}`);
    }
  }
  console.log('final state', sim.state, 'waves', sim.wavesCleared);
  console.log(`heap min ${Math.min(...samples).toFixed(2)} MB, max ${Math.max(...samples).toFixed(2)} MB`);
}

if (mode === 'stress') {
  const sim = new TD.Sim({ map: 0, difficulty: 'normal', seed: 1 });
  TD.setupStress(sim);
  const times = [];
  for (let i = 0; i < 60 * 30; i++) {
    const t0 = performance.now();
    sim.step();
    times.push(performance.now() - t0);
    if (i % 300 === 299) console.log(`t=${((i + 1) / 60).toFixed(0)}s enemies ${sim.eCount} towers ${sim.towers.length} projectiles ${sim.pCount} fireMul ${sim.fireMul.toFixed(2)}`);
  }
  times.sort((a, b) => a - b);
  const _tail = times.slice(300);
  console.log(`sim step ms: median ${times[times.length >> 1].toFixed(3)} p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} max ${times[times.length - 1].toFixed(3)}`);
}

if (mode === 'trace') {
  const map = +(process.argv[3] || 0), diff = process.argv[4] || 'normal', skill = +(process.argv[5] || 1);
  const sim = new TD.Sim({ map, difficulty: diff, seed: 7 });
  const bot = new TD.Bot(sim, { skill });
  let last = 0, lives = sim.lives;
  while (sim.state !== 'victory' && sim.state !== 'defeat') {
    bot.update(); sim.step();
    if (sim.wave !== last) {
      const counts = [0,0,0,0,0]; sim.towers.forEach(t => counts[t.type]++);
      console.log(`w${String(last).padStart(2)} lost ${lives - sim.lives} gold ${Math.floor(sim.gold)} towers ${counts.join('/')} levels ${sim.towers.reduce((a, t) => a + t.level, 0)}`);
      last = sim.wave; lives = sim.lives;
    }
  }
  console.log(sim.state, sim.wave, sim.lives);
}
