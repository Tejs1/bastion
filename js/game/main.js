/* Bastion — game controller: owns the single requestAnimationFrame loop,
 * the camera, player intents and game-mode orchestration. */
var TD = globalThis.TD || (globalThis.TD = {});
(() => {
  'use strict';

  var params = new URLSearchParams(location.search);
  var CLEAR = [0.035, 0.05, 0.08];

  function Game() {
    this.canvas = document.getElementById('view');
    this.speed = 1;
    this.paused = false;
    this.placing = -1;
    this.selected = 0;
    this.hoverCol = -1; this.hoverRow = -1; this.hoverValid = false; this.hoverTower = 0;
    this.touchGhostSet = false;
    this.cam = { x: 640, y: 360, zoom: 1, rot: 0 };
    this.fitZoom = 1;
    this.userCam = false;
    this.sim = null;
    this.mode = 'menu';
    this.loop = new TD.FixedLoop();
    this.autoStart = true;
    this.lastWave = 0;
    this.endShown = false;
    this.endTimer = 0;
    this.renderT = 0;
    // frame statistics ring buffers (no allocation per frame)
    this.statN = 600;
    this.fDelta = new Float32Array(this.statN);
    this.fCpu = new Float32Array(this.statN);
    this.fSim = new Float32Array(this.statN);
    this.fRender = new Float32Array(this.statN);
    this.fTicks = new Uint8Array(this.statN);
    this.fHead = 0; this.fCount = 0;
    this.sortBuf = new Float32Array(this.statN);
    this.bench = null;
    this.perfTimer = 0;
    this.lastTs = 0;
    this.rc = { x: 0, y: 0, zoom: 1, rot: 0 };
    // dynamic resolution scaling (only kicks in when GPU-bound)
    this.renderScale = 1; this.drs = !params.has('nodrs');
    this.drsAcc = 0; this.drsFrames = 0; this.drsCpu = 0; this.drsGood = 0;
    this.drsPrevAvg = 0; this.drsPrevScale = 1; this.drsLocked = false;
    this.lockstep = params.has('lockstep');
    this.view = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this.bgRect = { x: 0, y: 0, w: 1, h: 1 };
    // one reusable step closure: no per-frame function allocation
    this.stepFn = () => { if (this.bot) this.bot.update(); this.sim.step(); };
    this.frameFn = (t) => { this.frame(t); };
  }
  TD.Game = Game;
  var G = Game.prototype;

  G.init = function () {
    var forced2d = params.has('canvas2d');
    this.renderer = new TD.Renderer(this.canvas, { force2d: forced2d });
    this.atlas = new TD.Atlas();
    this.renderer.setTexture('atlas', this.atlas.canvas);
    this.scene = new TD.Scene(this.renderer, this.atlas);
    this.audio = new TD.Audio();
    var muted = false;
    try { muted = localStorage.getItem('bastion.muted') === '1'; } catch (_e) { /* storage unavailable */ }
    this.audio.setMuted(muted);
    this.fx = new TD.Fx(this.audio);
    this.ui = new TD.UI(this);
    this.ui.init(this.atlas);
    this.ui.setMuted(muted);
    this.input = new TD.Input(this.canvas, this);
    this.renderer.onRestore = () => {
      this.renderer.initGL();
      this.renderer.setTexture('atlas', this.atlas.canvas);
      if (this.bgCanvas) this.renderer.setTexture('bg', this.bgCanvas);
    };
    window.addEventListener('resize', () => { this.resize(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'play' && !this.paused && this.sim && this.sim.state === 'running') this.setPaused(true);
    });
    this.resize();

    // menu backdrop: a live demo battle behind the title screen
    this.newGame(0, 'normal', 'backdrop');
    this.ui.enterMenu();

    if (params.has('stress')) this.newGame(0, 'normal', 'stress');
    else if (params.has('autoplay')) {
      this.newGame(+(params.get('map') || 0), params.get('diff') || 'normal', 'demo');
      if (params.has('turbo')) { this.speed = +params.get('turbo'); this.loop.maxSteps = this.speed * 3; }
    }
    requestAnimationFrame((ts) => { this.frame(ts); });
    window.__td = this;
  };

  // ------------------------------------------------------------ game modes
  G.newGame = function (mapIndex, diff, mode) {
    this.mapIndex = mapIndex; this.diffId = diff; this.mode = mode;
    this.fx.reset();
    this.sim = new TD.Sim({ map: mapIndex, difficulty: diff, fx: mode === 'backdrop' ? TD.NOFX : this.fx, seed: (Math.random() * 1e9) | 0 });
    this.sim.autoStart = this.autoStart;
    this.sim.onWaveCleared = (w, bonus) => { if (this.mode !== 'backdrop') this.ui.toast(`Wave ${w} cleared  +${bonus} credits`); };
    this.bot = (mode === 'demo' || mode === 'backdrop') ? new TD.Bot(this.sim, { skill: 1 }) : null;
    if (mode === 'backdrop') { this.sim.fx = this.fx; this.fx.audio = null; }
    else this.fx.audio = this.audio;
    if (mode === 'stress') TD.setupStress(this.sim);
    this.loop = new TD.FixedLoop();
    this.placing = -1; this.selected = 0; this.hoverTower = 0;
    this.lastWave = 0; this.endShown = false; this.endTimer = 0;
    this.paused = false;
    this.speed = mode === 'backdrop' ? 2 : 1;
    this.bgCanvas = TD.renderBackground(this.sim.map, Math.min(2.5, Math.max(1.25, (window.devicePixelRatio || 1) * 1.25)));
    this.renderer.setTexture('bg', this.bgCanvas);
    this.userCam = false;
    if (mode !== 'backdrop') this.ui.enterGame(mode);
    this.fitCamera();
    if (mode !== 'backdrop') {
      this.canvas.classList.remove('placing');
      if (mode === 'stress') { this.startBench(); }
      if (mode === 'play') this.ui.banner(this.sim.mapDef.name.toUpperCase(), 'Build defenses, then start wave 1');
      if (mode === 'demo') this.speed = 2;
      this.ui.showSpeed(this.speed);
    }
  };

  G.restart = function () {
    var m = this.mode === 'backdrop' || this.mode === 'menu' ? 'play' : this.mode;
    this.newGame(this.mapIndex, this.diffId, m);
  };

  G.quit = function () {
    this.newGame(this.mapIndex, 'normal', 'backdrop');
    this.ui.enterMenu();
  };

  G.isPlay = function () { return this.mode === 'play' || this.mode === 'demo' || this.mode === 'stress'; };

  // ------------------------------------------------------------ camera
  G.resize = function () {
    var w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(w, h, this.dpr * this.renderScale);
    this.cssW = w; this.cssH = h;
    this.fitCamera(true);
  };

  /** Fit the map into the screen area not covered by HUD panels. */
  G.fitCamera = function (keepUser) {
    var W = this.sim ? this.sim.map.width : 1280, H = this.sim ? this.sim.map.height : 720;
    var top = 0, bottom = 0, left = 0;
    if (this.isPlay()) {
      var tb = document.querySelector('.topbar').getBoundingClientRect();
      top = tb.bottom;
      var dockTop = this.cssH;
      ['palette', 'waveBox'].forEach((id) => {
        var e = document.getElementById(id);
        if (!e.classList.contains('hidden')) { var r = e.getBoundingClientRect(); if (r.height) dockTop = Math.min(dockTop, r.top); }
      });
      bottom = this.cssH - dockTop;
    }
    // portrait screens: rotate the camera 90deg so the wide map fills the tall screen
    var rot = this.cssH > this.cssW * 1.15 ? 1 : 0;
    this.cam.rot = rot;
    var Ws = rot ? H : W, Hs = rot ? W : H;
    var availW = this.cssW - left - 8, availH = this.cssH - top - bottom - 8;
    var z = Math.min(availW / Ws, availH / Hs);
    var zFull = Math.min(this.cssW / Ws, (this.cssH - top) / Hs);
    if (z < zFull * 0.78) { z = zFull; bottom = 0; }   // short screens: let the dock overlay the map
    if (this.mode === 'backdrop') z = Math.max(this.cssW / Ws, this.cssH / Hs) * 1.02;
    this.fitZoom = z;
    this.minZoom = z * 0.85;
    this.maxZoom = Math.max(z * 4, 3);
    if (keepUser && this.userCam) { this.clampCam(); return; }
    this.cam.zoom = z;
    var cy = (top + this.cssH - bottom) / 2;
    if (rot) { this.cam.y = H / 2; this.cam.x = W / 2 - (cy - this.cssH / 2) / z; }
    else { this.cam.x = W / 2; this.cam.y = H / 2 - (cy - this.cssH / 2) / z; }
  };

  G.clampCam = function () {
    var c = this.cam, W = this.sim.map.width, H = this.sim.map.height;
    c.zoom = TD.clamp(c.zoom, this.minZoom, this.maxZoom);
    var hw = (c.rot ? this.cssH : this.cssW) / 2 / c.zoom, hh = (c.rot ? this.cssW : this.cssH) / 2 / c.zoom;
    // keep the map at least partly on screen
    c.x = TD.clamp(c.x, Math.min(W / 2, hw - 60), Math.max(W / 2, W - hw + 60));
    c.y = TD.clamp(c.y, Math.min(H / 2, hh - 100), Math.max(H / 2, H - hh + 100));
  };

  G.screenToWorld = function (sx, sy) {
    var dx = (sx - this.cssW / 2) / this.cam.zoom, dy = (sy - this.cssH / 2) / this.cam.zoom;
    if (this.cam.rot) return { x: this.cam.x + dy, y: this.cam.y - dx };
    return { x: this.cam.x + dx, y: this.cam.y + dy };
  };

  G.pan = function (dx, dy) {
    if (!this.isPlay()) return;
    if (this.cam.rot) { this.cam.x -= dy / this.cam.zoom; this.cam.y += dx / this.cam.zoom; }
    else { this.cam.x -= dx / this.cam.zoom; this.cam.y -= dy / this.cam.zoom; }
    this.userCam = true;
    this.clampCam();
  };

  G.zoomAt = function (sx, sy, f) {
    if (!this.isPlay()) return;
    var before = this.screenToWorld(sx, sy);
    this.cam.zoom = TD.clamp(this.cam.zoom * f, this.minZoom, this.maxZoom);
    var after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x; this.cam.y += before.y - after.y;
    this.userCam = true;
    this.clampCam();
  };

  G.resetView = function () { this.userCam = false; this.fitCamera(); };

  // ------------------------------------------------------------ intents
  G.unlockAudio = function () { this.audio.unlock(); };
  G.sfx = function (n) { this.audio.play(n); };
  G.isPlacing = function () { return this.placing >= 0; };

  G.tileAt = function (sx, sy) {
    var w = this.screenToWorld(sx, sy);
    var col = Math.floor(w.x / TD.TILE), row = Math.floor(w.y / TD.TILE);
    if (col < 0 || row < 0 || col >= TD.COLS || row >= TD.ROWS) return null;
    return { col: col, row: row };
  };

  G.hover = function (sx, sy) {
    if (!this.isPlay() || sx < 0) { this.hoverCol = -1; this.hoverTower = 0; return; }
    var t = this.tileAt(sx, sy);
    if (!t) { this.hoverCol = -1; this.hoverTower = 0; return; }
    this.setHoverTile(t.col, t.row);
  };

  G.setHoverTile = function (col, row) {
    this.hoverCol = col; this.hoverRow = row;
    var id = this.sim.towerAt[row * TD.COLS + col];
    this.hoverTower = id > 0 ? id : 0;
    this.hoverValid = this.sim.canBuild(col, row) && (this.placing < 0 || this.sim.gold >= TD.TOWERS[this.placing].cost);
  };

  G.tap = function (sx, sy, ptype) {
    if (!this.isPlay()) return;
    var t = this.tileAt(sx, sy);
    if (this.placing >= 0) {
      if (!t) { this.selectTowerType(-1); return; }
      if (ptype !== 'mouse' && (!this.touchGhostSet || t.col !== this.hoverCol || t.row !== this.hoverRow)) {
        this.setHoverTile(t.col, t.row);
        this.touchGhostSet = true;
        return;
      }
      this.setHoverTile(t.col, t.row);
      this.tryBuild(t.col, t.row, ptype === 'mouse' && !!(this.input.keys.ShiftLeft || this.input.keys.ShiftRight));
      return;
    }
    if (!t) { this.selectTower(0); return; }
    var id = this.sim.towerAt[t.row * TD.COLS + t.col];
    if (id > 0) { this.selectTower(id === this.selected ? 0 : id); this.sfx('click'); }
    else {
      this.selectTower(0);
      if (ptype !== 'mouse') this.setHoverTile(t.col, t.row);
    }
  };

  G.tryBuild = function (col, row, keep) {
    var type = this.placing;
    var res = this.sim.placeTower(type, col, row);
    if (typeof res === 'object') {
      this.fx.ring(res.x, res.y, 6, 34, 0.35, TD.ad(120, 220, 255, 0.9), 1);
      this.touchGhostSet = false;
      if (!keep || this.sim.gold < TD.TOWERS[type].cost) this.selectTowerType(-1);
      this.setHoverTile(col, row);
      return true;
    }
    this.sfx('error');
    if (res === 'gold') this.ui.toast(`Not enough credits — need ${TD.TOWERS[type].cost}`, true);
    else if (res === 'blocked') this.ui.toast("Can't build there", true);
    return false;
  };

  G.selectTowerType = function (i) {
    if (!this.isPlay()) return;
    if (i >= 0 && this.sim.gold < TD.TOWERS[i].cost) { this.ui.toast(`Not enough credits — need ${TD.TOWERS[i].cost}`, true); this.sfx('error'); }
    this.placing = i;
    this.touchGhostSet = false;
    if (i >= 0) { this.selected = 0; this.sfx('click'); }
    this.canvas.classList.toggle('placing', i >= 0);
    if (this.hoverCol >= 0) this.setHoverTile(this.hoverCol, this.hoverRow);
  };

  G.selectTower = function (id) {
    this.selected = id || 0;
    if (id) { this.placing = -1; this.canvas.classList.remove('placing'); }
  };

  G.upgradeSelected = function () {
    if (!this.selected) return;
    var r = this.sim.upgradeTower(this.selected);
    if (r === 'gold') { this.ui.toast('Not enough credits', true); this.sfx('error'); }
    else if (r === 'max') { this.ui.toast('Already at max level'); }
    else if (typeof r === 'object') {
      this.fx.ring(r.x, r.y, 8, 40, 0.45, TD.ad(255, 215, 90, 1), 1);
      this.fx.burst(r.x, r.y, 14, 90, 0.6, 3, [255, 220, 120], 1, 2, 3);
    }
  };

  G.sellSelected = function () {
    if (!this.selected) return;
    var t = this.sim.towerById[this.selected];
    if (!t) return;
    var v = this.sim.sellTower(this.selected);
    this.fx.burst(t.x, t.y, 12, 80, 0.5, 3, [255, 214, 90], 1, 2, 3);
    this.fx.popup(t.x, t.y - 12, v);
    this.selected = 0;
  };

  G.setTargetMode = function (m) {
    if (!this.selected) return;
    this.sim.setTargetMode(this.selected, m);
    this.sfx('click');
  };

  G.cycleTarget = function () {
    var t = this.sim.towerById[this.selected];
    if (t && t.def.kind !== 'pulse') this.setTargetMode((t.mode + 1) % 4);
  };

  G.callWave = function () {
    if (!this.sim || !this.isPlay() || this.mode === 'stress') return;
    var b = this.sim.callWave();
    if (b > 0) this.ui.toast(`Early call bonus +${b} credits`);
  };

  G.setSpeed = function (s) { this.speed = s; this.ui.showSpeed(s); this.sfx('click'); };
  G.cycleSpeed = function () { this.setSpeed(this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1); };

  G.setPaused = function (p) {
    if (!this.isPlay()) return;
    this.paused = p;
    this.ui.showPause(p);
  };
  G.togglePause = function () { if (this.sim && (this.sim.state === 'victory' || this.sim.state === 'defeat')) return; this.setPaused(!this.paused); };

  G.toggleMute = function () {
    this.unlockAudio();
    var m = !this.audio.muted;
    this.audio.setMuted(m);
    this.ui.setMuted(m);
    try { localStorage.setItem('bastion.muted', m ? '1' : '0'); } catch (_e) { /* ignore */ }
  };

  G.setAutoStart = function (v) { this.autoStart = v; if (this.sim) this.sim.autoStart = v; };

  G.cancel = function () {
    if (this.placing >= 0) { this.selectTowerType(-1); return true; }
    if (this.selected) { this.selectTower(0); return true; }
    return false;
  };

  G.onKey = function (e) {
    var k = e.key;
    if (k === '`' || k === '~') { this.ui.setPerf(!this.ui.perfOn); return true; }
    if (!this.isPlay()) return false;
    if (k === 'Escape') {
      if (!document.getElementById('scrHelp').classList.contains('hidden')) { this.ui.hide('scrHelp'); return true; }
      if (!this.cancel()) this.togglePause();
      return true;
    }
    if (k === ' ' || k === 'p' || k === 'P') { this.togglePause(); return true; }
    if (k === '?') { this.ui.show('scrHelp'); return true; }
    if (k === 'm' || k === 'M') { this.toggleMute(); return true; }
    if (this.paused) return false;
    if (k >= '1' && k <= '5') { var i = +k - 1; this.selectTowerType(this.placing === i ? -1 : i); return true; }
    if (k === 'u' || k === 'U') { this.upgradeSelected(); return true; }
    if (k === 'x' || k === 'X' || k === 'Delete' || k === 'Backspace') { this.sellSelected(); return true; }
    if (k === 't' || k === 'T') { this.cycleTarget(); return true; }
    if (k === 'n' || k === 'N' || k === 'Enter') { this.callWave(); return true; }
    if (k === 'f' || k === 'F') { this.cycleSpeed(); return true; }
    if (k === '0' || k === 'Home') { this.resetView(); return true; }
    if (k === '+' || k === '=') { this.zoomAt(this.cssW / 2, this.cssH / 2, 1.2); return true; }
    if (k === '-' || k === '_') { this.zoomAt(this.cssW / 2, this.cssH / 2, 1 / 1.2); return true; }
    return /^(Arrow|w|a|s|d|W|A|S|D)/.test(k);
  };

  // ------------------------------------------------------------ scores
  G.bestScore = (map, diff) => {
    try { return JSON.parse(localStorage.getItem(`bastion.best.${map}.${diff}`) || 'null'); } catch (_e) { return null; }
  };
  G.saveScore = function (sim, won) {
    var best = this.bestScore(this.mapIndex, this.diffId);
    var isNew = !best || sim.score > best.score;
    if (isNew) {
      best = { score: sim.score, wave: sim.wave, won: won };
      try { localStorage.setItem(`bastion.best.${this.mapIndex}.${this.diffId}`, JSON.stringify(best)); } catch (_e) { /* ignore */ }
    }
    return { best: best, isNew: isNew };
  };

  // ------------------------------------------------------------ benchmark
  G.startBench = function () {
    this.bench = { warm: 3, dur: 20, t: 0, frames: [], cpu: [], sim: [], render: [], ticks: 0, heap0: heapMB() };
  };

  G.benchFrame = function (dtMs, cpuMs, simMs, renderMs, ticks) {
    var b = this.bench;
    if (!b || b.done) return;
    b.t += dtMs / 1000;
    if (b.t < b.warm) return;
    b.frames.push(dtMs); b.cpu.push(cpuMs); b.sim.push(simMs); b.render.push(renderMs); b.ticks += ticks;
    if (b.t < b.warm + b.dur) return;
    b.done = true;
    var f = b.frames.slice().sort((a, c) => a - c);
    var cpu = b.cpu.slice().sort((a, c) => a - c);
    var pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    var avg = (arr) => { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; };
    var at45 = 0, over33 = 0;
    for (var i = 0; i < f.length; i++) { if (f[i] <= 1000 / 45 + 0.5) at45++; if (f[i] > 33.4) over33++; }
    var res = {
      seconds: avg(b.frames) * b.frames.length / 1000, frames: f.length,
      enemies: this.sim.eCount, towers: this.sim.towers.length, projectiles: this.sim.pCount,
      avgFps: 1000 / avg(b.frames), pctAt45: at45 / f.length, pctOver33: over33 / f.length,
      p50: pct(f, 0.5), p95: pct(f, 0.95), p99: pct(f, 0.99),
      cpuAvg: avg(b.cpu), cpuP95: pct(cpu, 0.95), simAvg: avg(b.sim), renderAvg: avg(b.render),
      simPerTick: avg(b.sim) * b.frames.length / Math.max(1, b.ticks), ticksPerFrame: b.ticks / b.frames.length,
      renderScale: this.renderScale, lockstep: this.lockstep,
      backend: `${this.renderer.backend} · ${this.renderer.drawCalls} draw calls`,
      heap: b.heap0 ? `${b.heap0.toFixed(1)} → ${heapMB().toFixed(1)} MB` : 'n/a (browser does not expose)'
    };
    window.__benchResult = res;
    if (this.mode === 'stress') this.ui.showBench(res);
  };

  function heapMB() { return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0; }

  // ------------------------------------------------------------ main loop
  G.frame = function (ts) {
    requestAnimationFrame(this.frameFn);
    var t0 = performance.now();
    var dtMs = this.lastTs ? ts - this.lastTs : 16.67;
    this.lastTs = ts;
    var dt = Math.min(dtMs / 1000, 0.25);
    var sim = this.sim;

    this.input.update(dt);

    // ---- simulation (fixed step)
    var ticks = 0;
    var running = !this.paused && (this.mode !== 'menu');
    var tSim0 = performance.now();
    if (running) ticks = this.loop.advance(this.lockstep ? TD.DT : dt, this.speed, this.stepFn);
    var tSim1 = performance.now();
    this.fx.update(running ? dt * this.speed : 0, dt);

    // ---- game events
    if (this.mode === 'backdrop') {
      if (sim.state === 'victory' || sim.state === 'defeat') this.newGame(sim.map.def === TD.MAPS[0] ? 1 : 0, 'normal', 'backdrop');
    } else if (this.mode !== 'stress') this.checkEvents(sim, dt);

    // ---- render
    var cam = this.cam;
    var shake = this.fx.shake;
    var rc = this.rc;
    rc.x = cam.x + (shake ? (Math.random() - 0.5) * shake : 0);
    rc.y = cam.y + (shake ? (Math.random() - 0.5) * shake : 0);
    rc.zoom = cam.zoom; rc.rot = cam.rot;
    var hw = (cam.rot ? this.cssH : this.cssW) / 2 / cam.zoom, hh = (cam.rot ? this.cssW : this.cssH) / 2 / cam.zoom;
    var view = this.view;
    view.x0 = rc.x - hw; view.x1 = rc.x + hw; view.y0 = rc.y - hh; view.y1 = rc.y + hh;
    this.renderT += running ? dt : 0;
    this.scene.build(sim, this.fx, rc, view, this.loop.alpha, this, this.renderT);
    var map = sim.map, br = this.bgRect;
    br.w = map.width; br.h = map.height;
    this.renderer.flush(rc, 'bg', 'atlas', br, CLEAR);
    var tEnd = performance.now();

    // ---- UI + stats
    if (this.mode !== 'backdrop' && this.mode !== 'menu') this.ui.update(sim, this);
    var h = this.fHead;
    this.fDelta[h] = dtMs; this.fCpu[h] = tEnd - t0; this.fSim[h] = tSim1 - tSim0; this.fRender[h] = tEnd - tSim1; this.fTicks[h] = ticks;
    this.fHead = (h + 1) % this.statN; if (this.fCount < this.statN) this.fCount++;
    if (this.mode === 'stress') this.benchFrame(dtMs, tEnd - t0, tSim1 - tSim0, tEnd - tSim1, ticks);
    if (this.drs) this.updateDRS(dtMs, tEnd - t0);
    this.perfTimer += dt;
    if (this.ui.perfOn && this.perfTimer > 0.25) { this.perfTimer = 0; this.updatePerf(); }
  };

  /** Dynamic resolution: if frames run long while the CPU work is a small
   *  part of the frame (i.e. the GPU is the bottleneck), lower the backing
   *  resolution in 10% steps (min 50%); restore it when there is headroom. */
  G.updateDRS = function (dtMs, cpuMs) {
    this.drsAcc += dtMs; this.drsCpu += cpuMs; this.drsFrames++;
    if (this.drsAcc < 750) return;
    var avg = this.drsAcc / this.drsFrames, cpu = this.drsCpu / this.drsFrames;
    this.drsAcc = 0; this.drsCpu = 0; this.drsFrames = 0;
    if (this.drsLocked) return;
    var scale = this.renderScale;
    // A step down that did not speed frames up means we are not GPU-bound
    // (e.g. a browser capping rAF at 30 Hz in power-saving mode): undo and stop.
    if (this.drsPrevAvg && avg > this.drsPrevAvg * 0.92) {
      scale = this.drsPrevScale; this.drsLocked = true; this.drsPrevAvg = 0;
    } else if (avg > 21 && cpu < avg * 0.6 && scale > 0.5) {
      this.drsPrevAvg = avg; this.drsPrevScale = scale;
      scale = Math.max(0.5, scale - 0.1); this.drsGood = -3;
    } else {
      this.drsPrevAvg = 0;
      if (avg < 17.5 && scale < 1) { if (++this.drsGood >= 3) { scale = Math.min(1, scale + 0.1); this.drsGood = 0; } }
      else if (this.drsGood > 0) this.drsGood = 0;
    }
    if (scale !== this.renderScale) { this.renderScale = Math.round(scale * 10) / 10; this.renderer.resize(this.cssW, this.cssH, this.dpr * this.renderScale); }
  };

  G.checkEvents = function (sim, dt) {
    if (sim.wave !== this.lastWave) {
      var w = sim.wave;
      this.lastWave = w;
      var groups = TD.buildWave(w, sim.map.paths.length);
      var intro = '';
      [['runner', 3], ['swarm', 5], ['tank', 7], ['healer', 11], ['splitter', 14]].forEach((u) => { if (u[1] === w) intro = `New enemy: ${TD.ENEMIES[TD.ENEMY_INDEX[u[0]]].name}`; });
      var boss = w % 10 === 0;
      var total = groups.reduce((a, g) => a + g.count, 0);
      this.ui.banner(w === TD.TOTAL_WAVES ? 'FINAL WAVE' : boss ? `BOSS WAVE ${w}` : `WAVE ${w}`, intro || (boss ? 'A Behemoth approaches' : `${total} hostiles inbound`), boss);
    }
    if ((sim.state === 'victory' || sim.state === 'defeat') && !this.endShown) {
      this.endTimer += dt;
      if (this.endTimer > (sim.state === 'victory' ? 1.2 : 1.6)) {
        this.endShown = true;
        this.placing = -1; this.selected = 0;
        if (this.mode === 'play') {
          var r = this.saveScore(sim, sim.state === 'victory');
          this.ui.showEnd(sim, sim.state === 'victory', r.best, r.isNew);
        } else this.ui.showEnd(sim, sim.state === 'victory', null, false);
      }
    }
  };

  G.updatePerf = function () {
    var n = Math.min(this.fCount, 120), N = this.statN, s = this.sortBuf;
    var sum = 0, cpu = 0, simT = 0, rnd = 0, ticks = 0;
    for (var i = 0; i < n; i++) {
      var k = (this.fHead - 1 - i + N) % N;
      s[i] = this.fDelta[k]; sum += this.fDelta[k]; cpu += this.fCpu[k]; simT += this.fSim[k]; rnd += this.fRender[k]; ticks += this.fTicks[k];
    }
    var sub = s.subarray(0, n); sub.sort();
    var sim = this.sim;
    var lines = [
      `FPS        ${(1000 / (sum / n)).toFixed(1)}   p95 ${sub[Math.floor(n * 0.95)].toFixed(1)} ms`,
      `CPU/frame  ${(cpu / n).toFixed(2)} ms`,
      `  sim      ${(simT / n).toFixed(2)} ms  (${(ticks / n).toFixed(1)} ticks)`,
      `  render   ${(rnd / n).toFixed(2)} ms`,
      `enemies    ${sim.eCount}  (visible ${this.scene.stats.visibleEnemies})`,
      `towers     ${sim.towers.length}   proj ${sim.pCount}`,
      `particles  ${this.fx.count()}   sprites ${this.scene.stats.instances}`,
      `renderer   ${this.renderer.backend} · ${this.renderer.drawCalls} draws · ${Math.round(this.renderScale * 100)}% res`,
      `speed      ${this.speed}×${performance.memory ? `   heap ${heapMB().toFixed(1)} MB` : ''}`
    ];
    if (this.bench && !this.bench.done) {
      var b = this.bench;
      lines.push(b.t < b.warm ? 'bench      warming up…' : `bench      sampling ${Math.max(0, b.warm + b.dur - b.t).toFixed(0)}s`);
    }
    this.ui.setPerfText(lines.join('\n'));
  };

  // ------------------------------------------------------------ boot
  function boot() {
    try {
      var g = new Game();
      g.init();
    } catch (err) {
      document.getElementById('fatal').classList.remove('hidden');
      document.getElementById('fatalMsg').textContent = String(err?.stack || err);
      throw err;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
