/* Bastion — sim snapshots for the worker split.
 *
 * The simulation can run in a Web Worker (js/sim-worker.js). After each batch
 * of ticks the worker packs everything the main thread needs to draw a frame
 * into one transferable ArrayBuffer:
 *   - a Float64 header (scalars: tick, gold, lives, wave, state, ...)
 *   - enemy and projectile render state as fixed-capacity Float32 SoA blocks
 *   - per-tower dynamic state (angle, recoil, kills, damage)
 *   - the stream of fx/sound events the sim emitted since the last snapshot
 * Buffers are recycled through a small pool, so steady state allocates no
 * buffers. On the main thread a SimView exposes the same field names the
 * scene and UI already read from a local Sim.
 */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var EC = 8192, PC = 4096, TC = 512, EVCAP = 16384;
  var HDR = 32;                                   // Float64 header slots
  var H = {
    tick: 0, time: 1, gold: 2, lives: 3, maxLives: 4, score: 5, kills: 6, wave: 7, cleared: 8, state: 9,
    countdown: 10, canCall: 11, eCount: 12, pCount: 13, nTowers: 14, nEv: 15, alpha: 16, postAbs: 17,
    towersVer: 18, leaked: 19, busyMs: 20, ticks: 21, game: 22, nextTowerId: 23, callBonus: 24
  };
  var STATES = ['prep', 'running', 'victory', 'defeat'];
  // Float32 block layout (offsets in floats, after the header)
  var E_FIELDS = ['eX', 'eY', 'ePX', 'ePY', 'eRot', 'eType', 'eFlash', 'eSlowT', 'eHf', 'eSlot'];
  var P_FIELDS = ['pX', 'pY', 'pPX', 'pPY', 'pTX', 'pTY', 'pKind', 'pAge'];
  var T_STRIDE = 5;                               // id angle recoil kills dmgDone
  var OFF = {}, o = 0;
  E_FIELDS.forEach((f) => { OFF[f] = o; o += EC; });
  P_FIELDS.forEach((f) => { OFF[f] = o; o += PC; });
  OFF.towers = o; o += TC * T_STRIDE;
  OFF.ev = o; o += EVCAP;
  var BYTES = HDR * 8 + o * 4;

  // fx event opcodes and argument counts (index = opcode)
  var EV = ['', 'shoot', 'hit', 'explosion', 'death', 'arc', 'beam', 'pulse', 'heal', 'leak', 'popup', 'sound', 'summon', 'cleared'];
  var ARGS = [0, 4, 2, 3, 4, 5, 5, 3, 3, 3, 3, 1, 2, 2];
  var SOUNDS = ['build', 'upgrade', 'sell', 'wave', 'boss', 'clear', 'victory', 'defeat', 'zap', 'cannon', 'blaster',
    'boom', 'pop', 'bossdie', 'rail', 'frost', 'leak', 'click', 'error'];

  TD.SNAP = { EC: EC, PC: PC, TC: TC, HDR: HDR, H: H, OFF: OFF, BYTES: BYTES, STATES: STATES, EV: EV, ARGS: ARGS, SOUNDS: SOUNDS };

  // ------------------------------------------------------------ worker side
  /** fx hook object for the sim inside the worker: records events as floats. */
  function FxRecorder() { this.ev = new Float32Array(EVCAP); this.n = 0; }
  var R = FxRecorder.prototype;
  R.rec = function (op, a, b, c, d, e) {
    var k = ARGS[op];
    if (this.n + k + 1 > EVCAP) return;           // visual only: drop on overflow
    var v = this.ev, i = this.n;
    v[i] = op;
    if (k > 0) v[i + 1] = a;
    if (k > 1) v[i + 2] = b;
    if (k > 2) v[i + 3] = c;
    if (k > 3) v[i + 4] = d;
    if (k > 4) v[i + 5] = e;
    this.n = i + k + 1;
  };
  EV.forEach((name, op) => {
    if (!name || name === 'sound' || name === 'cleared') return;
    R[name] = function (a, b, c, d, e) { this.rec(op, a, b, c, d, e); };
  });
  R.sound = function (name) { var id = SOUNDS.indexOf(name); if (id >= 0) this.rec(11, id); };
  R.cleared = function (w, bonus) { this.rec(13, w, bonus); };
  TD.FxRecorder = FxRecorder;

  /** Pack the sim into buf (an ArrayBuffer of SNAP.BYTES). */
  TD.encodeSnapshot = (buf, sim, fxr, extra) => {
    var h = new Float64Array(buf, 0, HDR), f = new Float32Array(buf, HDR * 8);
    h[H.tick] = sim.tick; h[H.time] = sim.time; h[H.gold] = sim.gold; h[H.lives] = sim.lives;
    h[H.maxLives] = sim.maxLives; h[H.score] = sim.score; h[H.kills] = sim.kills; h[H.wave] = sim.wave;
    h[H.cleared] = sim.wavesCleared; h[H.state] = STATES.indexOf(sim.state); h[H.countdown] = sim.countdown;
    var can = sim.canCallWave(), bonus = 0;
    if (can && sim.wave > 0) {   // what callWave() would pay right now
      let frac = sim.countdown > 0 ? sim.countdown / TD.WAVE_COUNTDOWN : 1;
      if (sim.waveDone[sim.wave] && sim.countdown <= 0) frac = 0;
      bonus = Math.round(TD.earlyCallBonus(sim.wave + 1) * frac);
    }
    h[H.canCall] = can ? 1 : 0; h[H.callBonus] = bonus; h[H.leaked] = sim.leaked; h[H.nextTowerId] = sim.nextTowerId;
    var n = sim.eCount, list = sim.eList, hp = sim.eHp, mhp = sim.eMaxHp;
    var oX = OFF.eX, oY = OFF.eY, oPX = OFF.ePX, oPY = OFF.ePY, oR = OFF.eRot, oT = OFF.eType, oF = OFF.eFlash,
      oS = OFF.eSlowT, oH = OFF.eHf, oSl = OFF.eSlot;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      f[oX + i] = sim.eX[s]; f[oY + i] = sim.eY[s]; f[oPX + i] = sim.ePX[s]; f[oPY + i] = sim.ePY[s];
      f[oR + i] = sim.eRot[s]; f[oT + i] = sim.eType[s]; f[oF + i] = sim.eFlash[s]; f[oS + i] = sim.eSlowT[s];
      f[oH + i] = hp[s] / mhp[s]; f[oSl + i] = s;
    }
    h[H.eCount] = n;
    var pc = sim.pCount;
    f.set(sim.pX.subarray(0, pc), OFF.pX); f.set(sim.pY.subarray(0, pc), OFF.pY);
    f.set(sim.pPX.subarray(0, pc), OFF.pPX); f.set(sim.pPY.subarray(0, pc), OFF.pPY);
    f.set(sim.pTX.subarray(0, pc), OFF.pTX); f.set(sim.pTY.subarray(0, pc), OFF.pTY);
    f.set(sim.pAge.subarray(0, pc), OFF.pAge);
    for (let i = 0; i < pc; i++) f[OFF.pKind + i] = sim.pKind[i];
    h[H.pCount] = pc;
    var towers = sim.towers, nt = Math.min(towers.length, TC);
    for (let i = 0; i < nt; i++) {
      const t = towers[i], k = OFF.towers + i * T_STRIDE;
      f[k] = t.id; f[k + 1] = t.angle; f[k + 2] = t.recoil; f[k + 3] = t.kills; f[k + 4] = t.dmgDone;
    }
    h[H.nTowers] = nt;
    var ne = fxr.n;
    f.set(fxr.ev.subarray(0, ne), OFF.ev);
    h[H.nEv] = ne; fxr.n = 0;
    h[H.alpha] = extra.alpha; h[H.postAbs] = performance.timeOrigin + performance.now();
    h[H.towersVer] = extra.towersVer; h[H.busyMs] = extra.busyMs; h[H.ticks] = extra.ticks; h[H.game] = extra.game;
  };

  /** Static tower description sent only when the tower set changes. */
  TD.towerList = (sim) => sim.towers.map((t) => ({ id: t.id, type: t.type, level: t.level, col: t.col, row: t.row,
    mode: t.mode, invested: t.invested, built: t.built }));

  // -------------------------------------------------------------- main side
  /** Read-only stand-in for Sim on the main thread, fed by snapshots. Field
   *  names match Sim so the scene and UI read either one. Enemy arrays are
   *  indexed by dense position (eAlive is all ones, eMaxHp all ones with eHp
   *  holding the health fraction); eSlot keeps per-enemy wobble stable. */
  function SimView(opts) {
    this.isView = true;
    this.mapDef = TD.MAPS[opts.map | 0];
    this.map = TD.buildMap(this.mapDef);
    this.diffId = opts.difficulty || 'normal';
    this.diff = TD.DIFFICULTY[this.diffId];
    this.tick = 0; this.time = 0; this.gold = this.diff.gold; this.lives = this.diff.lives; this.maxLives = this.diff.lives;
    this.score = 0; this.kills = 0; this.leaked = 0; this.wave = 0; this.wavesCleared = 0; this.state = 'prep';
    this.countdown = -1; this.canCall = true; this.eCount = 0; this.pCount = 0; this.autoStart = true;
    this.towers = []; this.towerById = {}; this.towerAt = new Int32Array(this.map.cols * this.map.rows).fill(-1);
    this.towersVer = -1; this.nextTowerId = 1; this.ticks = 0; this.busyMs = 0;
    this.eAlive = new Uint8Array(EC).fill(1);
    this.eMaxHp = new Float32Array(EC).fill(1);
    var empty = new Float32Array(EC);
    E_FIELDS.forEach((k) => { this[k] = empty; });
    P_FIELDS.forEach((k) => { this[k] = empty; });
    this.eHp = empty;
    this.buf = null;
  }
  var V = SimView.prototype;

  /** Point the view at a snapshot buffer, rebuild towers if their version
   *  changed, and replay fx events into fx. Returns the previous buffer. */
  V.apply = function (buf, towerList, fx, onCleared) {
    var h = new Float64Array(buf, 0, HDR), base = HDR * 8;
    this.tick = h[H.tick]; this.time = h[H.time]; this.gold = h[H.gold]; this.lives = h[H.lives];
    this.maxLives = h[H.maxLives]; this.score = h[H.score]; this.kills = h[H.kills]; this.wave = h[H.wave];
    this.wavesCleared = h[H.cleared]; this.state = STATES[h[H.state]]; this.countdown = h[H.countdown];
    this.canCall = h[H.canCall] === 1; this.eCount = h[H.eCount]; this.pCount = h[H.pCount]; this.leaked = h[H.leaked];
    this.alpha = h[H.alpha]; this.postAbs = h[H.postAbs]; this.ticks = h[H.ticks]; this.busyMs = h[H.busyMs];
    this.nextTowerId = h[H.nextTowerId]; this.callBonus = h[H.callBonus];
    E_FIELDS.forEach((k) => { this[k] = new Float32Array(buf, base + OFF[k] * 4, EC); });
    P_FIELDS.forEach((k) => { this[k] = new Float32Array(buf, base + OFF[k] * 4, PC); });
    this.eHp = this.eHf;
    if (towerList && h[H.towersVer] !== this.towersVer) this.setTowers(towerList, h[H.towersVer]);
    var f = new Float32Array(buf, base);
    for (let i = 0, nt = h[H.nTowers]; i < nt; i++) {
      const k = OFF.towers + i * T_STRIDE, t = this.towerById[f[k]];
      if (!t) continue;
      t.angle = f[k + 1]; t.recoil = f[k + 2]; t.kills = f[k + 3]; t.dmgDone = f[k + 4];
    }
    replay(f, OFF.ev, OFF.ev + h[H.nEv], fx, onCleared);
    var prev = this.buf;
    this.buf = buf;
    return prev;
  };

  V.setTowers = function (list, ver) {
    var old = this.towerById;
    this.towers = []; this.towerById = {}; this.towerAt.fill(-1);
    for (let i = 0; i < list.length; i++) {
      const d = list[i], prev = old[d.id];
      const t = { id: d.id, type: d.type, def: TD.TOWERS[d.type], level: d.level, col: d.col, row: d.row,
        x: (d.col + 0.5) * TD.TILE, y: (d.row + 0.5) * TD.TILE, mode: d.mode, invested: d.invested, built: d.built,
        angle: prev ? prev.angle : -Math.PI / 2, recoil: prev ? prev.recoil : 0, kills: prev ? prev.kills : 0,
        dmgDone: prev ? prev.dmgDone : 0 };
      this.towers.push(t); this.towerById[t.id] = t; this.towerAt[t.row * this.map.cols + t.col] = t.id;
    }
    this.towersVer = ver;
  };

  function replay(f, i, end, fx, onCleared) {
    while (i < end) {
      const op = f[i];
      switch (op) {
        case 1: fx.shoot(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); break;
        case 2: fx.hit(f[i + 1], f[i + 2]); break;
        case 3: fx.explosion(f[i + 1], f[i + 2], f[i + 3]); break;
        case 4: fx.death(f[i + 1], f[i + 2], f[i + 3], f[i + 4]); break;
        case 5: fx.arc(f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]); break;
        case 6: fx.beam(f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]); break;
        case 7: fx.pulse(f[i + 1], f[i + 2], f[i + 3]); break;
        case 8: fx.heal(f[i + 1], f[i + 2], f[i + 3]); break;
        case 9: fx.leak(f[i + 1], f[i + 2], f[i + 3]); break;
        case 10: fx.popup(f[i + 1], f[i + 2], f[i + 3]); break;
        case 11: fx.sound(SOUNDS[f[i + 1]]); break;
        case 12: fx.summon(f[i + 1], f[i + 2]); break;
        case 13: if (onCleared) onCleared(f[i + 1], f[i + 2]); break;
        default: return;
      }
      i += ARGS[op] + 1;
    }
  }

  // Same rules as Sim, evaluated on mirrored state so the UI can answer
  // immediately; the worker re-checks and stays authoritative.
  V.canBuild = function (col, row) {
    var m = this.map;
    if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return false;
    var i = row * m.cols + col;
    return m.grid[i] === TD.TILE_FREE && this.towerAt[i] < 0;
  };
  V.canCallWave = function () { return this.canCall; };

  // Player commands: validated here with Sim's rules so the UI can answer at
  // once, applied optimistically, and sent to the worker (authoritative).
  V.placeTower = function (type, col, row) {
    var def = TD.TOWERS[type];
    if (!def) return 'bad';
    if (this.state === 'victory' || this.state === 'defeat') return 'over';
    if (!this.canBuild(col, row)) return 'blocked';
    if (this.gold < def.cost) return 'gold';
    this.gold -= def.cost;
    this.towerAt[row * this.map.cols + col] = 0;   // occupied until the next tower list arrives
    this.send('place', [type, col, row]);
    return { x: (col + 0.5) * TD.TILE, y: (row + 0.5) * TD.TILE };
  };
  V.upgradeTower = function (id) {
    var t = this.towerById[id];
    if (!t) return 'bad';
    var nx = t.def.levels[t.level + 1];
    if (!nx) return 'max';
    if (this.gold < nx.up) return 'gold';
    this.gold -= nx.up; t.invested += nx.up; t.level++;
    this.send('upgrade', [id]);
    return t;
  };
  V.sellTower = function (id) {
    var t = this.towerById[id];
    if (!t) return 0;
    var v = this.sellValue(t);
    this.gold += v;
    this.towerAt[t.row * this.map.cols + t.col] = -1;
    delete this.towerById[id];
    this.towers.splice(this.towers.indexOf(t), 1);
    this.send('sell', [id]);
    return v;
  };
  V.setTargetMode = function (id, mode) {
    var t = this.towerById[id];
    if (t) t.mode = mode;
    this.send('mode', [id, mode]);
  };
  V.callWave = function () {
    if (!this.canCall) return -1;
    this.canCall = false;
    this.send('call', []);
    return this.callBonus;
  };
  V.sellValue = function (t) {
    if (this.tick - t.built < 180 && t.level === 0) return t.invested;
    return Math.floor(t.invested * 0.7);
  };
  TD.SimView = SimView;
})();
