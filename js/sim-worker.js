/* Bastion — simulation worker. Owns the authoritative Sim (and the bot),
 * steps it on its own fixed-step clock and posts snapshots (see
 * core/snapshot.js) to the main thread, which only renders. */
/* global importScripts */
if (typeof importScripts === 'function' && !globalThis.TD) {
  importScripts('core/util.js', 'core/data.js', 'core/map.js', 'core/sim.js', 'core/bot.js', 'core/stress.js', 'core/snapshot.js');
}
(() => {
  'use strict';
  var TD = globalThis.TD;
  var sim = null, bot = null, fxr = new TD.FxRecorder(), loop = new TD.FixedLoop();
  var speed = 1, paused = false, game = 0, towersVer = 0, sentVer = -1;
  var pool = [], ticks = 0, busyMs = 0, last = 0, timer = 0, lastPost = 0;
  // Chrome's DevTools CPU throttling does not reach workers, so the stress
  // harness asks the worker to emulate an N× slower core: every pump's work
  // is followed by a busy-wait of (N - 1) × its duration.
  var slow = 1;
  loop.budgetMs = 12;   // keep posting snapshots at >= ~60 Hz even when overloaded

  function stepFn() { if (bot) bot.update(); sim.step(); ticks++; }

  function bump() { towersVer++; }
  var CMD = {
    place: (a) => { var r = sim.placeTower(a[0], a[1], a[2]); if (typeof r === 'object') bump(); },
    upgrade: (a) => { if (typeof sim.upgradeTower(a[0]) === 'object') bump(); },
    sell: (a) => { if (sim.sellTower(a[0])) bump(); },
    mode: (a) => { sim.setTargetMode(a[0], a[1]); bump(); },
    call: () => { sim.callWave(); },
    autoStart: (a) => { sim.autoStart = a[0]; },
    speed: (a) => { speed = a[0]; loop.maxSteps = Math.max(12, speed * 3); },
    pause: (a) => { paused = a[0]; }
  };

  globalThis.onmessage = (e) => {
    var m = e.data;
    if (m.t === 'buf') { if (m.game === game) pool.push(m.buf); return; }
    if (m.t === 'new') {
      game = m.game; slow = m.slow || 1;
      sim = new TD.Sim({ map: m.map, difficulty: m.diff, fx: fxr, seed: m.seed });
      sim.autoStart = m.autoStart;
      sim.onWaveCleared = (w, b) => { fxr.cleared(w, b); };
      bot = m.bot ? new TD.Bot(sim, { skill: 1 }) : null;
      if (m.stress) TD.setupStress(sim);
      loop = new TD.FixedLoop(); loop.budgetMs = 12;
      speed = m.speed; loop.maxSteps = Math.max(12, speed * 3);
      paused = false; ticks = 0; busyMs = 0; towersVer = 1; sentVer = -1; fxr.n = 0;
      // two buffers: one shown by the main thread, one in flight
      pool = [new ArrayBuffer(TD.SNAP.BYTES), new ArrayBuffer(TD.SNAP.BYTES)];
      last = performance.now();
      if (!timer) timer = setTimeout(pump, 0);
      return;
    }
    if (m.t === 'cmd' && sim && CMD[m.c]) CMD[m.c](m.a || []);
  };

  function pump() {
    timer = 0;
    var t0 = performance.now();
    var dt = (t0 - last) / 1000; last = t0;
    if (sim && !paused) loop.advance(dt, speed, stepFn);
    if (sim && pool.length && t0 - lastPost >= 8) {   // <= ~120 snapshots/s
      lastPost = t0;
      const buf = pool.pop();
      TD.encodeSnapshot(buf, sim, fxr, { alpha: loop.alpha, towersVer: towersVer, busyMs: busyMs, ticks: ticks, game: game });
      const msg = { t: 'snap', buf: buf, game: game, towers: towersVer !== sentVer ? TD.towerList(sim) : null };
      sentVer = towersVer;
      postMessage(msg, [buf]);
    }
    var work = performance.now() - t0;
    if (slow > 1 && work > 0) { const until = performance.now() + work * (slow - 1); while (performance.now() < until) { /* emulated slow core */ } }
    busyMs += performance.now() - t0;
    // sleep until the next tick is due (setTimeout clamps to ~4 ms when nested)
    var wait = sim && !paused ? (TD.DT - loop.acc) / speed * 1000 : 16;
    timer = setTimeout(pump, wait > 1 ? wait : 0);
  }
})();
