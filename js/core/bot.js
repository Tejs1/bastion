/* Bastion — simple autoplay bot. Used for the in-game "autoplay" demo, the
 * stress/long-run harnesses and headless balance testing. Purely uses the
 * public command API of TD.Sim (placeTower / upgradeTower / callWave). */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  function Bot(sim, opts) {
    opts = opts || {};
    this.sim = sim;
    this.skill = opts.skill == null ? 1 : opts.skill;   // 0..1
    this.rushWaves = opts.rushWaves !== false;
    this.allowed = opts.towers || [0, 1, 2, 3, 4];
    this.upgrades = opts.upgrades !== false;
    this.timer = 0;
    this.built = 0;
    this.spots = this.rankSpots();
  }

  /** Score every buildable tile by how much path lies within a given range. */
  Bot.prototype.rankSpots = function () {
    var m = this.sim.map, out = [];
    var samples = [];
    m.paths.forEach((p, pi) => {
      for (let k = 0; k < p.n; k += 5) samples.push(p.x[k], p.y[k], pi === 0 ? 1 : 1);
    });
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      if (m.grid[r * m.cols + c] !== TD.TILE_FREE) continue;
      const x = (c + 0.5) * m.tile, y = (r + 0.5) * m.tile;
      let near = 0, mid = 0, far = 0;
      for (let i = 0; i < samples.length; i += 3) {
        const dx = samples[i] - x, dy = samples[i + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 < 90 * 90) near++;
        if (d2 < 130 * 130) mid++;
        if (d2 < 240 * 240) far++;
      }
      out.push({ col: c, row: r, near: near, mid: mid, far: far });
    }
    return out;
  };

  Bot.prototype.chooseType = function () {
    var w = this.sim.wave, n = this.sim.towers.length;
    var a = this.allowed;
    var plan;
    if (n < 2) plan = 0;
    else if (w < 5) plan = n % 3 === 2 ? 1 : 0;
    else {
      const cycle = [1, 0, 2, 3, 1, 4, 0, 3, 4, 1];
      plan = cycle[n % cycle.length];
      if (plan === 4 && w < 10) plan = 1;
      if (plan === 3 && w < 7) plan = 0;
    }
    if (a.indexOf(plan) < 0) plan = a[n % a.length];
    return plan;
  };

  Bot.prototype.bestSpot = function (type) {
    var sim = this.sim, best = null, bv = -1;
    var key = type === 4 ? 'far' : type === 2 ? 'near' : 'mid';
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (!sim.canBuild(s.col, s.row)) continue;
      const v = s[key];
      if (v > bv) { bv = v; best = s; }
    }
    return best;
  };

  Bot.prototype.update = function () {
    var sim = this.sim;
    if (sim.state === 'victory' || sim.state === 'defeat') return;
    if (++this.timer < 20) return;
    this.timer = 0;
    var w = sim.wave;
    // Spend: build towers up to a wave-scaled count, otherwise upgrade.
    var target = Math.min(70, 3 + Math.floor(w * 1.15 * this.skill));
    for (let guard = 0; guard < 6; guard++) {
      let acted = false;
      if (sim.towers.length < target) {
        const type = this.chooseType();
        if (sim.gold >= TD.TOWERS[type].cost) {
          const spot = this.bestSpot(type);
          if (spot && sim.placeTower(type, spot.col, spot.row) !== 'blocked') { acted = true; this.built++; }
        }
      }
      if (!acted && this.upgrades && (sim.towers.length >= target || w > 6)) {
        // upgrade the cheapest upgradable tower (spreads levels evenly)
        let best = null, bc = Infinity;
        for (let i = 0; i < sim.towers.length; i++) {
          const t = sim.towers[i], c = sim.upgradeCost(t);
          if (c && c < bc) { bc = c; best = t; }
        }
        if (best && sim.gold >= bc + (sim.towers.length < target ? TD.TOWERS[0].cost : 0)) {
          sim.upgradeTower(best.id); acted = true;
        }
      }
      if (!acted) break;
    }
    if (this.rushWaves && sim.canCallWave() && (sim.wave === 0 || sim.countdown > 0)) sim.callWave();
  };

  TD.Bot = Bot;
})();
