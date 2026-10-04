/* Bastion — fixed-step loop driver and the stress-test scenario. */
var TD = globalThis.TD || (globalThis.TD = {});
(function () {
  'use strict';

  /** Fixed-timestep accumulator. Simulation always advances in DT ticks, so
   *  gameplay is identical at 30, 60, 144 or 240 Hz; only interpolation
   *  (alpha) differs. Large frame gaps are clamped so a stall never causes a
   *  catch-up spiral. */
  function FixedLoop() { this.acc = 0; this.alpha = 0; this.maxSteps = 12; this.dropped = 0; }
  FixedLoop.prototype.advance = function (frameSeconds, speed, stepFn) {
    if (frameSeconds > 0.25) frameSeconds = 0.25;
    if (frameSeconds < 0) frameSeconds = 0;
    this.acc += frameSeconds * speed;
    var n = 0, DT = TD.DT;
    while (this.acc >= DT && n < this.maxSteps) { stepFn(); this.acc -= DT; n++; }
    if (this.acc >= DT) { this.dropped += Math.floor(this.acc / DT); this.acc = this.acc % DT; }
    this.alpha = this.acc / DT;
    return n;
  };
  TD.FixedLoop = FixedLoop;

  /**
   * Stress scenario: 100 towers, 5,000 live enemies and >= 1,000 live
   * projectiles at all times. Enemies that die are replaced, enemies that reach
   * the base are recycled to the start, and the global fire-rate multiplier is
   * steered so projectile count stays at the target.
   */
  TD.setupStress = function (sim, opts) {
    opts = opts || {};
    var targetEnemies = opts.enemies || 5000;
    var targetTowers = opts.towers || 100;
    var targetProj = opts.projectiles || 1000;
    sim.gold = 1e9;
    sim.state = 'running';
    sim.wave = 20;
    sim.dmgMul = 0.04;      // keep enemies alive long enough to stay on screen
    sim.projSpeedMul = 0.55; // longer flights -> more projectiles alive per shot
    var bot = new TD.Bot(sim);
    var spots = bot.spots.slice().sort(function (a, b) { return b.mid - a.mid; });
    // tower mix: projectile towers dominate so the projectile target is reachable
    var mix = [0, 1, 0, 1, 0, 3, 0, 1, 2, 4];
    var placed = 0;
    for (var i = 0; i < spots.length && placed < targetTowers; i++) {
      var t = sim.placeTower(mix[placed % mix.length], spots[i].col, spots[i].row);
      if (typeof t === 'object') {
        t.level = placed % 4;
        if (t.def.kind === 'bullet') t.mode = placed % 4;
        placed++;
      }
    }
    var types = [];
    TD.ENEMIES.forEach(function (e, idx) { if (e.id !== 'boss') types.push(idx); });
    var nPaths = sim.map.paths.length;
    sim.stress = {
      targetEnemies: targetEnemies, targetProj: targetProj, towers: placed,
      update: function (s) {
        var need = targetEnemies - s.eCount;
        if (need > 400) need = 400;
        for (var k = 0; k < need; k++) {
          var path = s.rng.int(0, nPaths - 1);
          var type = types[s.rng.int(0, types.length - 1)];
          s.spawnEnemy(type, path, 20, 1, s.rng.next() * s.map.paths[path].len * 0.97);
        }
        if (s.pCount < targetProj) s.fireMul = Math.min(40, s.fireMul * 1.03);
        else if (s.pCount > targetProj * 1.15) s.fireMul = Math.max(0.2, s.fireMul * 0.98);
      }
    };
    sim.fireMul = 6;
    return sim.stress;
  };
})();
