/* Bastion — deterministic fixed-step simulation.
 *
 * All hot entity state lives in preallocated typed arrays (structure-of-arrays)
 * so that steady-state play performs no allocations and memory stays flat.
 *  - enemies:     stable slots + free-list + dense active list (swap-remove)
 *  - projectiles: dense arrays, swap-remove
 *  - towers:      small array of plain objects (<= one per tile, created on build)
 *  - spatial hash: uniform grid rebuilt each tick with a counting sort
 * The sim knows nothing about rendering; visual/audio side effects are emitted
 * through the optional `fx` hook object.
 */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var DT = TD.DT;
  var EC = 8192;     // enemy capacity
  var PC = 4096;     // projectile capacity
  var CELL = 40;     // spatial grid cell size (px)

  var K_BULLET = 0, K_SHELL = 1;
  TD.PROJ_BULLET = K_BULLET; TD.PROJ_SHELL = K_SHELL;

  var NOFX = {
    shoot: () => {}, hit: () => {}, explosion: () => {}, death: () => {},
    arc: () => {}, beam: () => {}, pulse: () => {}, heal: () => {},
    leak: () => {}, popup: () => {}, sound: () => {}, summon: () => {}
  };
  TD.NOFX = NOFX;

  function Sim(opts) {
    opts = opts || {};
    this.mapDef = typeof opts.map === 'object' ? opts.map : TD.MAPS[opts.map | 0];
    this.map = TD.buildMap(this.mapDef);
    this.diffId = opts.difficulty || 'normal';
    this.diff = TD.DIFFICULTY[this.diffId];
    this.fx = opts.fx || NOFX;
    this.rng = new TD.RNG(opts.seed == null ? 12345 : opts.seed);

    this.tick = 0;
    this.time = 0;
    this.gold = this.diff.gold;
    this.lives = this.diff.lives;
    this.maxLives = this.diff.lives;
    this.score = 0;
    this.kills = 0;
    this.leaked = 0;
    this.state = 'prep';        // prep | running | victory | defeat
    this.wave = 0;              // number of waves started
    this.wavesCleared = 0;
    this.countdown = -1;        // seconds until auto-start (-1 = waiting for player)
    this.autoStart = opts.autoStart !== false;
    this.spawners = [];
    this.waveAlive = new Int32Array(TD.TOTAL_WAVES + 2);
    this.waveSpawning = new Int32Array(TD.TOTAL_WAVES + 2);
    this.waveDone = new Uint8Array(TD.TOTAL_WAVES + 2);
    this.fireMul = 1;           // global multipliers (stress harness only)
    this.dmgMul = 1;
    this.projSpeedMul = 1;
    this.stress = null;

    // ----- enemy pool (SoA)
    this.eAlive = new Uint8Array(EC);
    this.eUid = new Uint32Array(EC);
    this.eType = new Uint8Array(EC);
    this.ePath = new Uint8Array(EC);
    this.eWave = new Uint8Array(EC);
    this.eDist = new Float32Array(EC);
    this.eOff = new Float32Array(EC);
    this.eSpeed = new Float32Array(EC);
    this.eHp = new Float32Array(EC);
    this.eMaxHp = new Float32Array(EC);
    this.eArmor = new Float32Array(EC);
    this.eSlowT = new Float32Array(EC);
    this.eSlowF = new Float32Array(EC);
    this.eX = new Float32Array(EC);
    this.eY = new Float32Array(EC);
    this.ePX = new Float32Array(EC);
    this.ePY = new Float32Array(EC);
    this.eRot = new Float32Array(EC);
    this.eFlash = new Float32Array(EC);
    this.eTimer = new Float32Array(EC);
    this.eReward = new Float32Array(EC);
    this.eList = new Int32Array(EC);
    this.eListPos = new Int32Array(EC);
    this.eCount = 0;
    this.eFree = new Int32Array(EC);
    this.eFreeTop = EC;
    for (let i = 0; i < EC; i++) this.eFree[i] = EC - 1 - i;
    this.nextUid = 1;
    this.eCap = EC;

    // ----- spatial grid (counting sort)
    this.gCols = Math.ceil(this.map.width / CELL) + 1;
    this.gRows = Math.ceil(this.map.height / CELL) + 1;
    this.gN = this.gCols * this.gRows;
    this.gStart = new Int32Array(this.gN + 1);
    this.gFill = new Int32Array(this.gN);
    this.gItems = new Int32Array(EC);
    this.eCell = new Int32Array(EC);
    this.qBuf = new Int32Array(EC);       // scratch buffer for range queries
    this.chainHit = new Int32Array(16);
    // per-cell best target for modes first/last/strong, computed lazily and
    // invalidated when an enemy in the cell is damaged or removed
    this.aggOk = new Uint8Array(this.gN * 3);
    this.aggS = new Int32Array(this.gN * 3);
    this.aggV = new Float64Array(this.gN * 3);

    // ----- projectile pool (dense SoA)
    this.pKind = new Uint8Array(PC);
    this.pX = new Float32Array(PC);
    this.pY = new Float32Array(PC);
    this.pPX = new Float32Array(PC);
    this.pPY = new Float32Array(PC);
    this.pTX = new Float32Array(PC);
    this.pTY = new Float32Array(PC);
    this.pSpeed = new Float32Array(PC);
    this.pDmg = new Float32Array(PC);
    this.pSplash = new Float32Array(PC);
    this.pTgt = new Int32Array(PC);
    this.pTgtUid = new Uint32Array(PC);
    this.pTower = new Int32Array(PC);
    this.pAge = new Float32Array(PC);
    this.pCount = 0;
    this.pCap = PC;

    // ----- towers
    this.towers = [];
    this.towerAt = new Int32Array(this.map.cols * this.map.rows).fill(-1);
    this.towerById = {};
    this.nextTowerId = 1;

    this.pathLen = new Float64Array(this.map.paths.map((p) => p.len));

    this.buildGrid();
  }
  TD.Sim = Sim;
  var S = Sim.prototype;

  // ================================================================ queries
  S.canBuild = function (col, row) {
    var m = this.map;
    if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return false;
    var i = row * m.cols + col;
    return m.grid[i] === TD.TILE_FREE && this.towerAt[i] < 0;
  };

  S.towerStats = (t, level) => t.def.levels[level == null ? t.level : level];

  /** Rebuild the uniform grid with a counting sort: O(n), cache friendly,
   *  allocation-free. Each cell's enemies end up contiguous in gItems. */
  S.buildGrid = function () {
    var gc = this.gCols, gr = this.gRows, n = this.eCount;
    var start = this.gStart, fill = this.gFill, items = this.gItems;
    var list = this.eList, ex = this.eX, ey = this.eY, cellOf = this.eCell;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      let cx = (ex[s] / CELL) | 0, cy = (ey[s] / CELL) | 0;
      if (cx < 0) cx = 0; else if (cx >= gc) cx = gc - 1;
      if (cy < 0) cy = 0; else if (cy >= gr) cy = gr - 1;
      const c = cy * gc + cx;
      cellOf[s] = c;
      start[c + 1]++;
    }
    for (let i = 0; i < this.gN; i++) { start[i + 1] += start[i]; fill[i] = start[i]; }
    for (let i = 0; i < n; i++) {
      const s = list[i];
      items[fill[cellOf[s]]++] = s;
    }
    this.aggOk.fill(0);
  };

  /** Best target in grid cell c for mode 0..2 (first occurrence of the max,
   *  i.e. exactly what a linear scan of the cell would pick). Cached. */
  S.cellBest = function (c, mode) {
    var i = mode * this.gN + c;
    if (this.aggOk[i]) return this.aggS[i];
    var start = this.gStart, items = this.gItems, alive = this.eAlive;
    var dist = this.eDist, ePath = this.ePath, plen = this.pathLen, hp = this.eHp;
    var best = -1, bestV = -Infinity;
    for (let k = start[c], e = start[c + 1]; k < e; k++) {
      const s = items[k];
      if (!alive[s]) continue;
      let v;
      if (mode === 0) v = -(plen[ePath[s]] - dist[s]);
      else if (mode === 1) v = plen[ePath[s]] - dist[s];
      else v = hp[s] - (plen[ePath[s]] - dist[s]) * 0.001;
      if (v > bestV) { bestV = v; best = s; }
    }
    this.aggOk[i] = 1; this.aggS[i] = best; this.aggV[i] = bestV;
    return best;
  };

  /** Collect live enemies within radius r of (x,y) into qBuf; returns count.
   *  Grid cells whose nearest point lies outside the circle are skipped. */
  S.queryCircle = function (x, y, r, out) {
    out = out || this.qBuf;
    var gc = this.gCols, gr = this.gRows;
    var c0 = ((x - r) / CELL) | 0, c1 = ((x + r) / CELL) | 0;
    var r0 = ((y - r) / CELL) | 0, r1 = ((y + r) / CELL) | 0;
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
    if (c1 >= gc) c1 = gc - 1; if (r1 >= gr) r1 = gr - 1;
    var start = this.gStart, items = this.gItems, ex = this.eX, ey = this.eY, alive = this.eAlive;
    var rr = r * r, n = 0;
    for (let cy = r0; cy <= r1; cy++) {
      const ny = y < cy * CELL ? cy * CELL - y : y > (cy + 1) * CELL ? y - (cy + 1) * CELL : 0;
      const ny2 = ny * ny;
      if (ny2 > rr) continue;
      for (let cx = c0; cx <= c1; cx++) {
        const nx = x < cx * CELL ? cx * CELL - x : x > (cx + 1) * CELL ? x - (cx + 1) * CELL : 0;
        if (nx * nx + ny2 > rr) continue;
        const c = cy * gc + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const s = items[k];
          if (!alive[s]) continue;
          const dx = ex[s] - x, dy = ey[s] - y;
          if (dx * dx + dy * dy <= rr) out[n++] = s;
        }
      }
    }
    return n;
  };

  /** Pick the best target for a tower according to its targeting mode.
   *  Fused with the circle query (one pass, no scratch buffer) and scored
   *  from flat typed arrays; visits candidates in the same order as
   *  queryCircle, so ties resolve identically. */
  S.findTarget = function (t, range) {
    var x = t.x, y = t.y, gc = this.gCols, gr = this.gRows;
    var c0 = ((x - range) / CELL) | 0, c1 = ((x + range) / CELL) | 0;
    var r0 = ((y - range) / CELL) | 0, r1 = ((y + range) / CELL) | 0;
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
    if (c1 >= gc) c1 = gc - 1; if (r1 >= gr) r1 = gr - 1;
    var start = this.gStart, items = this.gItems, ex = this.eX, ey = this.eY, alive = this.eAlive;
    var dist = this.eDist, ePath = this.ePath, plen = this.pathLen, hp = this.eHp;
    var rr = range * range, best = -1, bestV = -Infinity, mode = t.mode;
    var aggV = this.aggV, gN = this.gN;
    for (let cy = r0; cy <= r1; cy++) {
      const ny = y < cy * CELL ? cy * CELL - y : y > (cy + 1) * CELL ? y - (cy + 1) * CELL : 0;
      const ny2 = ny * ny;
      if (ny2 > rr) continue;
      for (let cx = c0; cx <= c1; cx++) {
        const nx = x < cx * CELL ? cx * CELL - x : x > (cx + 1) * CELL ? x - (cx + 1) * CELL : 0;
        if (nx * nx + ny2 > rr) continue;
        const c = cy * gc + cx;
        if (start[c] === start[c + 1]) continue;
        // The cell's cached best over ALL its enemies bounds what any in-range
        // enemy there can score: skip the cell if it can't win, take the
        // cached best directly if it is itself in range, else scan the cell.
        if (mode < 3) {
          const b = this.cellBest(c, mode);
          if (b < 0) continue;
          const V = aggV[mode * gN + c];
          if (V <= bestV) continue;
          const bx = ex[b] - x, by = ey[b] - y;
          if (bx * bx + by * by <= rr) { bestV = V; best = b; continue; }
        }
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const s = items[k];
          if (!alive[s]) continue;
          const dx = ex[s] - x, dy = ey[s] - y, d2 = dx * dx + dy * dy;
          if (d2 > rr) continue;
          let v;
          if (mode === 0) v = -(plen[ePath[s]] - dist[s]);          // first: least remaining
          else if (mode === 1) v = plen[ePath[s]] - dist[s];        // last
          else if (mode === 2) v = hp[s] - (plen[ePath[s]] - dist[s]) * 0.001; // strong
          else v = -d2;                                             // close
          if (v > bestV) { bestV = v; best = s; }
        }
      }
    }
    return best;
  };

  // ================================================================= enemies
  S.spawnEnemy = function (type, path, wave, hpMul, dist) {
    if (this.eFreeTop === 0) return -1;
    var s = this.eFree[--this.eFreeTop];
    var def = TD.ENEMIES[type];
    var w = Math.max(1, wave);
    var hp = def.hp * TD.hpMult(w) * this.diff.hp * (hpMul || 1);
    this.eAlive[s] = 1;
    this.eUid[s] = this.nextUid++;
    this.eType[s] = type;
    this.ePath[s] = path;
    this.eWave[s] = wave;
    this.eDist[s] = dist || 0;
    this.eOff[s] = def.radius > 15 ? 0 : (this.rng.next() * 2 - 1) * (13 - def.radius * 0.5);
    this.eSpeed[s] = def.speed * (0.94 + this.rng.next() * 0.12);
    this.eHp[s] = hp;
    this.eMaxHp[s] = hp;
    this.eArmor[s] = def.armor + (def.armorGrowth || 0) * (w - 1);
    this.eSlowT[s] = 0;
    this.eSlowF[s] = 1;
    this.eFlash[s] = 0;
    this.eTimer[s] = this.rng.next() * 2;
    this.eReward[s] = def.reward * TD.rewardMult(w) * this.diff.reward;
    this.placeEnemy(s);
    this.ePX[s] = this.eX[s];
    this.ePY[s] = this.eY[s];
    this.eListPos[s] = this.eCount;
    this.eList[this.eCount++] = s;
    if (wave > 0 && wave <= TD.TOTAL_WAVES) this.waveAlive[wave]++;
    return s;
  };

  S.placeEnemy = function (s) {
    var p = this.map.paths[this.ePath[s]];
    var k = (this.eDist[s] * p.inv) | 0;
    if (k >= p.n) k = p.n - 1;
    var off = this.eOff[s];
    this.eX[s] = p.x[k] - p.ty[k] * off;
    this.eY[s] = p.y[k] + p.tx[k] * off;
    this.eRot[s] = p.ang[k];
  };

  S.removeEnemy = function (s) {
    this.eAlive[s] = 0;
    var c = this.eCell[s], gN = this.gN;
    this.aggOk[c] = 0; this.aggOk[gN + c] = 0; this.aggOk[2 * gN + c] = 0;
    var pos = this.eListPos[s];
    var last = this.eList[--this.eCount];
    this.eList[pos] = last;
    this.eListPos[last] = pos;
    this.eFree[this.eFreeTop++] = s;
    var w = this.eWave[s];
    if (w > 0 && w <= TD.TOTAL_WAVES) this.waveAlive[w]--;
  };

  /** Apply damage. pierce = fraction of armour ignored. Returns true if killed. */
  S.damage = function (s, dmg, pierce, tower) {
    if (!this.eAlive[s]) return false;
    dmg *= this.dmgMul;
    var d = dmg - this.eArmor[s] * (1 - pierce);
    if (d < dmg * 0.2) d = dmg * 0.2;
    if (d > this.eHp[s]) d = this.eHp[s];
    this.eHp[s] -= d;
    this.eFlash[s] = 1;
    this.aggOk[2 * this.gN + this.eCell[s]] = 0;
    if (tower) tower.dmgDone += d;
    if (this.eHp[s] <= 0.001) { this.kill(s, tower); return true; }
    return false;
  };

  S.kill = function (s, tower) {
    var type = this.eType[s];
    var x = this.eX[s], y = this.eY[s];
    var reward = Math.max(1, Math.round(this.eReward[s]));
    this.gold += reward;
    this.score += reward * 10;
    this.kills++;
    if (tower) tower.kills++;
    this.fx.death(type, x, y, TD.ENEMIES[type].radius);
    if (type === TD.ENEMY_INDEX.boss || reward >= 8) this.fx.popup(x, y - 10, reward);
    var path = this.ePath[s], dist = this.eDist[s], wave = this.eWave[s], maxHp = this.eMaxHp[s];
    this.removeEnemy(s);
    if (this.stress) return;
    if (type === TD.ENEMY_INDEX.splitter) {
      const sp = TD.ENEMY_INDEX.spawnling;
      const baseHp = TD.ENEMIES[sp].hp * TD.hpMult(Math.max(1, wave)) * this.diff.hp;
      const mul = (maxHp * 0.24) / baseHp;
      for (let i = 0; i < 3; i++) {
        const c = this.spawnEnemy(sp, path, wave, mul, Math.max(0, dist - 6 + i * 6));
        if (c >= 0) this.eFlash[c] = 0.6;
      }
    }
  };

  S.updateEnemies = function () {
    var list = this.eList, paths = this.map.paths;
    var dist = this.eDist, speed = this.eSpeed, slowT = this.eSlowT, slowF = this.eSlowF;
    var ex = this.eX, ey = this.eY, epx = this.ePX, epy = this.ePY, rot = this.eRot, off = this.eOff;
    var flash = this.eFlash, type = this.eType, timer = this.eTimer, ePath = this.ePath;
    var HEALER = TD.ENEMY_INDEX.healer, BOSS = TD.ENEMY_INDEX.boss;
    for (let i = this.eCount - 1; i >= 0; i--) {
      const s = list[i];
      let sp = speed[s];
      if (slowT[s] > 0) {
        sp *= slowF[s];
        slowT[s] -= DT;
        if (slowT[s] <= 0) { slowT[s] = 0; slowF[s] = 1; }
      }
      const p = paths[ePath[s]];
      const d = dist[s] + sp * DT;
      epx[s] = ex[s]; epy[s] = ey[s];
      if (d >= p.len) { this.leak(s); continue; }
      dist[s] = d;
      const k = (d * p.inv) | 0;
      const o = off[s];
      ex[s] = p.x[k] - p.ty[k] * o;
      ey[s] = p.y[k] + p.tx[k] * o;
      rot[s] = p.ang[k];
      if (flash[s] > 0) flash[s] -= DT * 6;
      const ty = type[s];
      if (ty === HEALER || ty === BOSS) {
        timer[s] -= DT;
        if (timer[s] <= 0) {
          if (ty === HEALER) { timer[s] = 2.2; this.healPulse(s); }
          else if (!this.stress) { timer[s] = 4.5; this.bossSummon(s); }
          else timer[s] = 4.5;
        }
      }
    }
  };

  S.healPulse = function (s) {
    var n = this.queryCircle(this.eX[s], this.eY[s], 78);
    var buf = this.qBuf, hp = this.eHp, max = this.eMaxHp;
    for (let i = 0; i < n; i++) {
      const o = buf[i];
      hp[o] = Math.min(max[o], hp[o] + max[o] * 0.07);
    }
    this.fx.heal(this.eX[s], this.eY[s], 78);
  };

  S.bossSummon = function (s) {
    var n = this.eWave[s] >= 30 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      this.spawnEnemy(TD.ENEMY_INDEX.swarm, this.ePath[s], this.eWave[s], 1, Math.max(0, this.eDist[s] - 10 - i * 7));
    }
    this.fx.summon(this.eX[s], this.eY[s]);
  };

  S.leak = function (s) {
    if (this.stress) {   // stress harness: recycle to start instead of costing lives
      this.eDist[s] = 0; this.placeEnemy(s); this.ePX[s] = this.eX[s]; this.ePY[s] = this.eY[s];
      return;
    }
    var def = TD.ENEMIES[this.eType[s]];
    this.fx.leak(this.eX[s], this.eY[s], def.leak);
    this.lives -= def.leak;
    this.leaked++;
    this.removeEnemy(s);
    if (this.lives <= 0) {
      this.lives = 0;
      if (this.state === 'running' || this.state === 'prep') { this.state = 'defeat'; this.fx.sound('defeat'); }
    }
  };

  // ================================================================== towers
  S.placeTower = function (typeIndex, col, row) {
    var def = TD.TOWERS[typeIndex];
    if (!def) return 'bad';
    if (this.state === 'victory' || this.state === 'defeat') return 'over';
    if (!this.canBuild(col, row)) return 'blocked';
    if (this.gold < def.cost) return 'gold';
    this.gold -= def.cost;
    var t = {
      id: this.nextTowerId++, type: typeIndex, def: def, level: 0,
      col: col, row: row, x: (col + 0.5) * TD.TILE, y: (row + 0.5) * TD.TILE,
      cd: 0.15, target: -1, targetUid: 0, angle: -Math.PI / 2, mode: def.kind === 'beam' ? 2 : 0,
      kills: 0, dmgDone: 0, invested: def.cost, scanWait: 0, recoil: 0, barrel: 0, built: this.tick
    };
    this.towers.push(t);
    this.towerById[t.id] = t;
    this.towerAt[row * this.map.cols + col] = t.id;
    this.fx.sound('build');
    return t;
  };

  S.upgradeCost = (t) => {
    var nx = t.def.levels[t.level + 1];
    return nx ? nx.up : 0;
  };

  S.upgradeTower = function (id) {
    var t = this.towerById[id];
    if (!t) return 'bad';
    var nx = t.def.levels[t.level + 1];
    if (!nx) return 'max';
    if (this.gold < nx.up) return 'gold';
    this.gold -= nx.up;
    t.invested += nx.up;
    t.level++;
    this.fx.sound('upgrade');
    return t;
  };

  S.sellValue = function (t) {
    // full refund on the same tick window it was built (misclick forgiveness: 3s)
    if (this.tick - t.built < 180 && t.level === 0) return t.invested;
    return Math.floor(t.invested * 0.7);
  };

  S.sellTower = function (id) {
    var t = this.towerById[id];
    if (!t) return 0;
    var v = this.sellValue(t);
    this.gold += v;
    this.towerAt[t.row * this.map.cols + t.col] = -1;
    delete this.towerById[id];
    this.towers.splice(this.towers.indexOf(t), 1);
    this.fx.sound('sell');
    return v;
  };

  S.setTargetMode = function (id, mode) {
    var t = this.towerById[id];
    if (t) t.mode = mode;
  };

  S.targetValid = function (t, range) {
    var s = t.target;
    if (s < 0 || !this.eAlive[s] || this.eUid[s] !== t.targetUid) return false;
    var dx = this.eX[s] - t.x, dy = this.eY[s] - t.y;
    return dx * dx + dy * dy <= range * range;
  };

  S.updateTowers = function () {
    var towers = this.towers;
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      const L = t.def.levels[t.level];
      if (t.recoil > 0) t.recoil -= DT * 5;
      // keep aiming at the current target between shots
      if (t.target >= 0) {
        if (this.targetValid(t, L.range)) {
          const want = Math.atan2(this.eY[t.target] - t.y, this.eX[t.target] - t.x);
          let da = want - t.angle;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          t.angle += da * 0.35;
        } else t.target = -1;
      }
      t.cd -= DT * this.fireMul;
      if (t.cd > 0) continue;
      if (t.scanWait > 0) { t.scanWait--; continue; }
      const kind = t.def.kind;
      if (kind === 'pulse') {
        if (!this.firePulse(t, L)) { t.scanWait = 5; t.cd = 0; continue; }
      } else {
        const tg = this.findTarget(t, L.range);
        if (tg < 0) { t.target = -1; t.scanWait = 5; t.cd = 0; continue; }
        t.target = tg; t.targetUid = this.eUid[tg];
        t.angle = Math.atan2(this.eY[tg] - t.y, this.eX[tg] - t.x);
        if (kind === 'bullet' || kind === 'shell') this.fireProjectile(t, L, tg);
        else if (kind === 'chain') this.fireChain(t, L, tg);
        else if (kind === 'beam') this.fireBeam(t, L, tg);
      }
      t.recoil = 1;
      t.cd += 1 / L.rate;
      if (t.cd < 0) t.cd = 0;
    }
  };

  S.fireProjectile = function (t, L, tg) {
    if (this.pCount >= this.pCap) return;
    var p = this.pCount++;
    var ca = Math.cos(t.angle), sa = Math.sin(t.angle);
    var muzzle = 16;
    t.barrel ^= 1;
    var side = t.def.kind === 'bullet' && t.level >= 2 ? (t.barrel ? 4 : -4) : 0;
    this.pKind[p] = t.def.kind === 'shell' ? K_SHELL : K_BULLET;
    this.pX[p] = this.pPX[p] = t.x + ca * muzzle - sa * side;
    this.pY[p] = this.pPY[p] = t.y + sa * muzzle + ca * side;
    this.pTX[p] = this.eX[tg]; this.pTY[p] = this.eY[tg];
    this.pTgt[p] = tg; this.pTgtUid[p] = this.eUid[tg];
    this.pSpeed[p] = t.def.projSpeed * this.projSpeedMul;
    this.pDmg[p] = L.dmg;
    this.pSplash[p] = L.splash || 0;
    this.pTower[p] = t.id;
    this.pAge[p] = 0;
    this.fx.shoot(t.type, this.pX[p], this.pY[p], t.angle);
  };

  S.firePulse = function (t, L) {
    var n = this.queryCircle(t.x, t.y, L.range);
    if (n === 0) return false;
    var buf = this.qBuf;
    // copy targets first: damage() may trigger kills which spawn and mutate lists
    if (!this.pulseBuf) this.pulseBuf = new Int32Array(EC);
    var tmp = this.pulseBuf;
    for (let i = 0; i < n; i++) tmp[i] = buf[i];
    var slow = 1 - L.slow, dur = L.dur;
    for (let i = 0; i < n; i++) {
      const s = tmp[i];
      if (!this.eAlive[s]) continue;
      const def = TD.ENEMIES[this.eType[s]];
      const f = def.slowResist ? 1 - L.slow * def.slowResist : slow;
      if (this.eSlowT[s] <= 0 || f < this.eSlowF[s]) this.eSlowF[s] = f;
      if (this.eSlowT[s] < dur) this.eSlowT[s] = dur;
      this.damage(s, L.dmg, 0, t);
    }
    this.fx.pulse(t.x, t.y, L.range);
    return true;
  };

  S.fireChain = function (t, L, tg) {
    var hits = this.chainHit, nh = 0;
    var cur = tg, px = t.x, py = t.y - 10, dmg = L.dmg;
    var jump = t.def.jump;
    for (let c = 0; c < L.chains && cur >= 0; c++) {
      const cx = this.eX[cur], cy = this.eY[cur];
      this.fx.arc(px, py, cx, cy, c);
      hits[nh++] = cur;
      this.damage(cur, dmg, t.def.pierce, t);
      dmg *= 0.88;
      px = cx; py = cy;
      // nearest un-hit enemy within jump range
      cur = this.nearestUnhit(cx, cy, jump, hits, nh);
    }
    this.fx.sound('zap');
  };

  /** Nearest live enemy within r of (x,y) that is not in hits[0..nh).
   *  Visits the centre cell first and skips cells that cannot hold anything
   *  closer than the best so far. Ties go to the lower grid item index, which
   *  is the order a row-major scan would meet them, so the pick is identical. */
  S.nearestUnhit = function (x, y, r, hits, nh) {
    var gc = this.gCols, gr = this.gRows;
    var c0 = ((x - r) / CELL) | 0, c1 = ((x + r) / CELL) | 0;
    var r0 = ((y - r) / CELL) | 0, r1 = ((y + r) / CELL) | 0;
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
    if (c1 >= gc) c1 = gc - 1; if (r1 >= gr) r1 = gr - 1;
    var mx = (x / CELL) | 0, my = (y / CELL) | 0;
    if (mx < c0) mx = c0; else if (mx > c1) mx = c1;
    if (my < r0) my = r0; else if (my > r1) my = r1;
    var start = this.gStart, items = this.gItems, ex = this.eX, ey = this.eY, alive = this.eAlive;
    var rr = r * r, best = -1, bd = Infinity, bk = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let cy = r0; cy <= r1; cy++) {
        const ny = y < cy * CELL ? cy * CELL - y : y > (cy + 1) * CELL ? y - (cy + 1) * CELL : 0;
        for (let cx = c0; cx <= c1; cx++) {
          if ((cx === mx && cy === my) !== (pass === 0)) continue;
          const nx = x < cx * CELL ? cx * CELL - x : x > (cx + 1) * CELL ? x - (cx + 1) * CELL : 0;
          const cm = nx * nx + ny * ny;
          if (cm > rr || cm > bd) continue;
          const c = cy * gc + cx;
          for (let k = start[c], e = start[c + 1]; k < e; k++) {
            const s = items[k];
            if (!alive[s]) continue;
            const dx = ex[s] - x, dy = ey[s] - y, d2 = dx * dx + dy * dy;
            if (d2 > rr || d2 > bd || (d2 === bd && k > bk)) continue;
            let seen = false;
            for (let h = 0; h < nh; h++) if (hits[h] === s) { seen = true; break; }
            if (seen) continue;
            best = s; bd = d2; bk = k;
          }
        }
      }
    }
    return best;
  };

  S.fireBeam = function (t, L, _tg) {
    var ang = t.angle, ca = Math.cos(ang), sa = Math.sin(ang);
    var len = L.range + 30;
    var x0 = t.x + ca * 14, y0 = t.y + sa * 14;
    var x1 = t.x + ca * len, y1 = t.y + sa * len;
    // gather candidates from the grid cells covering the segment's bbox
    var gc = this.gCols, gr = this.gRows;
    var c0 = (Math.min(x0, x1) - 16) / CELL | 0, c1 = (Math.max(x0, x1) + 16) / CELL | 0;
    var r0 = (Math.min(y0, y1) - 16) / CELL | 0, r1 = (Math.max(y0, y1) + 16) / CELL | 0;
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 >= gc) c1 = gc - 1; if (r1 >= gr) r1 = gr - 1;
    if (!this.pulseBuf) this.pulseBuf = new Int32Array(EC);
    var tmp = this.pulseBuf;
    var n = 0, start = this.gStart, items = this.gItems;
    var dxl = x1 - x0, dyl = y1 - y0, ll = dxl * dxl + dyl * dyl;
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const c = cy * gc + cx;
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const s = items[k];
        if (!this.eAlive[s]) continue;
        const ex = this.eX[s] - x0, ey = this.eY[s] - y0;
        const u = (ex * dxl + ey * dyl) / ll;
        if (u < 0 || u > 1) continue;
        const qx = ex - dxl * u, qy = ey - dyl * u;
        const rad = TD.ENEMIES[this.eType[s]].radius + 5;
        if (qx * qx + qy * qy <= rad * rad) tmp[n++] = s;
      }
    }
    for (let i = 0; i < n; i++) this.damage(tmp[i], L.dmg, 1, t);
    this.fx.beam(x0, y0, x1, y1, t.level);
  };

  // ============================================================= projectiles
  S.updateProjectiles = function () {
    var alive = this.eAlive, uid = this.eUid, ex = this.eX, ey = this.eY;
    for (let p = this.pCount - 1; p >= 0; p--) {
      const tg = this.pTgt[p];
      const live = tg >= 0 && alive[tg] && uid[tg] === this.pTgtUid[p];
      if (live) { this.pTX[p] = ex[tg]; this.pTY[p] = ey[tg]; }
      else this.pTgt[p] = -1;
      const x = this.pX[p], y = this.pY[p];
      this.pPX[p] = x; this.pPY[p] = y;
      const dx = this.pTX[p] - x, dy = this.pTY[p] - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = this.pSpeed[p] * DT;
      this.pAge[p] += DT;
      if (d <= step + 2 || this.pAge[p] > 3) {
        this.impact(p, live ? tg : -1);
        this.removeProjectile(p);
        continue;
      }
      this.pX[p] = x + dx / d * step;
      this.pY[p] = y + dy / d * step;
    }
  };

  S.impact = function (p, tg) {
    var tower = this.towerById[this.pTower[p]] || null;
    var x = this.pTX[p], y = this.pTY[p];
    if (this.pKind[p] === K_SHELL) {
      const r = this.pSplash[p], dmg = this.pDmg[p];
      const n = this.queryCircle(x, y, r);
      if (!this.pulseBuf) this.pulseBuf = new Int32Array(EC);
      const tmp = this.pulseBuf;
      for (let i = 0; i < n; i++) tmp[i] = this.qBuf[i];
      for (let i = 0; i < n; i++) {
        const s = tmp[i];
        const dx = this.eX[s] - x, dy = this.eY[s] - y;
        const f = 1 - 0.5 * Math.max(0, Math.sqrt(dx * dx + dy * dy) / r - 0.35) / 0.65;
        this.damage(s, dmg * f, 0, tower);
      }
      this.fx.explosion(x, y, r);
    } else {
      if (tg >= 0) this.damage(tg, this.pDmg[p], 0, tower);
      this.fx.hit(x, y);
    }
  };

  S.removeProjectile = function (p) {
    var l = --this.pCount;
    if (p === l) return;
    this.pKind[p] = this.pKind[l]; this.pX[p] = this.pX[l]; this.pY[p] = this.pY[l];
    this.pPX[p] = this.pPX[l]; this.pPY[p] = this.pPY[l]; this.pTX[p] = this.pTX[l]; this.pTY[p] = this.pTY[l];
    this.pSpeed[p] = this.pSpeed[l]; this.pDmg[p] = this.pDmg[l]; this.pSplash[p] = this.pSplash[l];
    this.pTgt[p] = this.pTgt[l]; this.pTgtUid[p] = this.pTgtUid[l]; this.pTower[p] = this.pTower[l];
    this.pAge[p] = this.pAge[l];
  };

  // =================================================================== waves
  S.canCallWave = function () {
    if (this.state !== 'prep' && this.state !== 'running') return false;
    if (this.wave >= TD.TOTAL_WAVES) return false;
    return this.waveSpawning[this.wave] === 0 || this.wave === 0;
  };

  /** Start the next wave. Returns early-call bonus gold (0 if none). */
  S.callWave = function () {
    if (!this.canCallWave()) return -1;
    var bonus = 0;
    if (this.wave > 0) {
      let frac = this.countdown > 0 ? this.countdown / TD.WAVE_COUNTDOWN : 1;
      if (this.waveDone[this.wave] && this.countdown <= 0) frac = 0;
      bonus = Math.round(TD.earlyCallBonus(this.wave + 1) * frac);
      this.gold += bonus;
    }
    this.wave++;
    this.state = 'running';
    this.countdown = -1;
    var groups = TD.buildWave(this.wave, this.map.paths.length);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      this.spawners.push({ wave: this.wave, type: g.type, left: g.count, gap: g.gap, t: g.delay,
        path: g.path, hp: g.hp, k: i });
      this.waveSpawning[this.wave] += g.count;
    }
    this.fx.sound(this.wave % 10 === 0 ? 'boss' : 'wave');
    return bonus;
  };

  S.updateSpawners = function () {
    var sp = this.spawners;
    var nPaths = this.map.paths.length;
    for (let i = sp.length - 1; i >= 0; i--) {
      const g = sp[i];
      g.t -= DT;
      while (g.t <= 0 && g.left > 0) {
        const path = g.path >= 0 ? g.path : (g.left + g.k) % nPaths;
        this.spawnEnemy(g.type, path, g.wave, g.hp, 0);
        g.left--;
        this.waveSpawning[g.wave]--;
        g.t += g.gap;
      }
      if (g.left <= 0) sp.splice(i, 1);
    }
  };

  S.updateWaves = function () {
    // detect cleared waves (all spawned and none alive)
    for (let w = this.wavesCleared + 1; w <= this.wave; w++) {
      if (!this.waveDone[w] && this.waveSpawning[w] === 0 && this.waveAlive[w] === 0) {
        this.waveDone[w] = 1;
        this.wavesCleared++;
        const bonus = TD.waveClearBonus(w);
        this.gold += bonus;
        this.score += 50 * w;
        this.fx.sound('clear');
        if (this.onWaveCleared) this.onWaveCleared(w, bonus);
      } else break;
    }
    if (this.state !== 'running') return;
    if (this.wavesCleared >= TD.TOTAL_WAVES) {
      this.state = 'victory';
      this.score += this.lives * 500 + Math.floor(this.gold);
      this.fx.sound('victory');
      return;
    }
    // countdown to auto-start once the field is clear
    if (this.wave < TD.TOTAL_WAVES && this.waveSpawning[this.wave] === 0 && this.eCount === 0) {
      if (this.countdown < 0) this.countdown = TD.WAVE_COUNTDOWN;
      else {
        this.countdown -= DT;
        if (this.countdown <= 0) { this.countdown = 0; if (this.autoStart) this.callWave(); }
      }
    }
  };

  // ==================================================================== step
  S.step = function () {
    if (this.state === 'victory' || this.state === 'defeat') {
      // let the world keep animating (projectiles land) but nothing new happens
      this.updateProjectiles();
      return;
    }
    this.tick++;
    this.time += DT;
    if (this.stress) this.stress.update(this);
    this.updateSpawners();
    this.updateEnemies();
    this.buildGrid();
    this.updateTowers();
    this.updateProjectiles();
    if (!this.stress) this.updateWaves();
  };

  /** Cheap order-dependent hash of the full gameplay state (determinism tests). */
  S.hash = function () {
    var h = 2166136261 >>> 0;
    function mix(v) { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; }
    mix(this.tick); mix(this.gold * 100); mix(this.lives); mix(this.score); mix(this.eCount); mix(this.pCount);
    for (let i = 0; i < this.eCount; i++) {
      const s = this.eList[i];
      mix(s); mix(this.eDist[s] * 1000); mix(this.eHp[s] * 1000);
    }
    for (let i = 0; i < this.pCount; i++) { mix(this.pX[i] * 100); mix(this.pY[i] * 100); }
    return h >>> 0;
  };
})();
