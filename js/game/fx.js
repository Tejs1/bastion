/* Bastion — visual effects: particles, beams, arcs, rings, decals, popups.
 * Pure presentation; never affects gameplay. All pools are fixed-size ring
 * buffers (oldest effect is overwritten), so effect storms under stress can
 * never grow memory or stall the frame. A per-frame emission budget further
 * thins particle bursts when thousands of events happen at once. */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  /** Premultiplied normal-blend colour. */
  function pm(r, g, b, a) { var f = a / 255; return TD.rgba(r * f, g * f, b * f, a); }
  /** Additive colour (alpha 0 => adds in a premultiplied pipeline). */
  function ad(r, g, b, i) { return TD.rgba(r * i, g * i, b * i, 0); }
  TD.pm = pm; TD.ad = ad;

  function hexRGB(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

  var PCAP = 6144, BCAP = 640, RCAP = 320, DCAP = 96, TCAP = 96;
  var FRAMES = ['glow', 'soft', 'dot', 'shard', 'flake', 'smoke', 'plus', 'streak'];
  var F_GLOW = 0, _F_SOFT = 1, F_DOT = 2, F_SHARD = 3, F_FLAKE = 4, F_SMOKE = 5, F_PLUS = 6, _F_STREAK = 7;

  function Fx(audio) {
    this.audio = audio || null;
    this.rnd = new TD.RNG(4242);          // visual-only randomness
    // particles
    this.px = new Float32Array(PCAP); this.py = new Float32Array(PCAP);
    this.vx = new Float32Array(PCAP); this.vy = new Float32Array(PCAP);
    this.life = new Float32Array(PCAP); this.max = new Float32Array(PCAP);
    this.s0 = new Float32Array(PCAP); this.s1 = new Float32Array(PCAP);
    this.rot = new Float32Array(PCAP); this.vr = new Float32Array(PCAP);
    this.drag = new Float32Array(PCAP); this.grav = new Float32Array(PCAP);
    this.r = new Uint8Array(PCAP); this.g = new Uint8Array(PCAP); this.b = new Uint8Array(PCAP);
    this.add = new Uint8Array(PCAP); this.frame = new Uint8Array(PCAP);
    this.pHead = 0;
    // beams & arcs (arc = 6 jittered points)
    this.bKind = new Uint8Array(BCAP); this.bLife = new Float32Array(BCAP); this.bMax = new Float32Array(BCAP);
    this.bPts = new Float32Array(BCAP * 12); this.bCol = new Uint32Array(BCAP); this.bW = new Float32Array(BCAP);
    this.bHead = 0;
    // rings
    this.rX = new Float32Array(RCAP); this.rY = new Float32Array(RCAP); this.rR0 = new Float32Array(RCAP);
    this.rR1 = new Float32Array(RCAP); this.rLife = new Float32Array(RCAP); this.rMax = new Float32Array(RCAP);
    this.rCol = new Uint32Array(RCAP); this.rFrame = new Uint8Array(RCAP); this.rHead = 0;
    // decals
    this.dX = new Float32Array(DCAP); this.dY = new Float32Array(DCAP); this.dS = new Float32Array(DCAP);
    this.dLife = new Float32Array(DCAP); this.dRot = new Float32Array(DCAP); this.dHead = 0;
    // popups
    this.tX = new Float32Array(TCAP); this.tY = new Float32Array(TCAP); this.tV = new Int32Array(TCAP);
    this.tLife = new Float32Array(TCAP); this.tCol = new Uint32Array(TCAP); this.tHead = 0;

    this.budget = 0;
    this.shake = 0;
    this.baseFlash = 0;
    this.time = 0;
    this.enabled = true;
    this.enemyRGB = TD.ENEMIES.map((e) => hexRGB(e.color));
    this.towerRGB = TD.TOWERS.map((t) => hexRGB(t.color));
    this.FRAMES = FRAMES;
  }
  TD.Fx = Fx;
  TD.FX_FRAMES = FRAMES;
  var P = Fx.prototype;

  P.reset = function () {
    this.life.fill(0); this.bLife.fill(0); this.rLife.fill(0); this.dLife.fill(0); this.tLife.fill(0);
    this.shake = 0; this.baseFlash = 0;
  };

  P.particle = function (x, y, vx, vy, life, s0, s1, r, g, b, add, frame, drag, grav) {
    if (this.budget <= 0) return;
    this.budget--;
    var i = this.pHead; this.pHead = (i + 1) % PCAP;
    this.px[i] = x; this.py[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.add[i] = add; this.frame[i] = frame;
    this.drag[i] = drag; this.grav[i] = grav || 0;
    this.rot[i] = this.rnd.next() * 6.28; this.vr[i] = (this.rnd.next() - 0.5) * 8;
  };

  P.burst = function (x, y, n, speed, life, size, rgb, add, frame, drag) {
    var R = this.rnd;
    for (let k = 0; k < n; k++) {
      const a = R.next() * 6.283, s = speed * (0.35 + R.next() * 0.65);
      this.particle(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + R.next() * 0.5),
        size * (0.7 + R.next() * 0.6), size * 0.2, rgb[0], rgb[1], rgb[2], add, frame, drag);
    }
  };

  P.ring = function (x, y, r0, r1, life, col, frame) {
    var i = this.rHead; this.rHead = (i + 1) % RCAP;
    this.rX[i] = x; this.rY[i] = y; this.rR0[i] = r0; this.rR1[i] = r1;
    this.rLife[i] = life; this.rMax[i] = life; this.rCol[i] = col; this.rFrame[i] = frame || 0;
  };

  // ------------------------------------------------------------ sim hooks
  P.shoot = function (type, x, y, ang) {
    var c = this.towerRGB[type];
    var ca = Math.cos(ang), sa = Math.sin(ang);
    this.particle(x, y, ca * 30, sa * 30, 0.08, 14, 6, c[0], c[1], c[2], 1, F_GLOW, 0);
    if (type === 1) {
      for (let k = 0; k < 2; k++) this.particle(x, y, ca * 25 + (this.rnd.next() - 0.5) * 20, sa * 25 + (this.rnd.next() - 0.5) * 20,
        0.6, 8, 18, 140, 130, 120, 0, F_SMOKE, 2.5);
      this.sound('cannon');
    } else this.sound('blaster');
  };

  P.hit = function (x, y) {
    this.particle(x, y, 0, 0, 0.12, 12, 4, 120, 230, 255, 1, F_GLOW, 0);
    var R = this.rnd;
    for (let k = 0; k < 2; k++) {
      const a = R.next() * 6.283;
      this.particle(x, y, Math.cos(a) * 120, Math.sin(a) * 120, 0.18, 2.5, 0.5, 170, 240, 255, 1, F_DOT, 6);
    }
  };

  P.explosion = function (x, y, r) {
    this.particle(x, y, 0, 0, 0.25, r * 2.2, r * 1.2, 255, 170, 70, 1, F_GLOW, 0);
    this.particle(x, y, 0, 0, 0.12, r * 1.2, r * 0.6, 255, 245, 200, 1, F_GLOW, 0);
    this.ring(x, y, r * 0.3, r * 1.15, 0.3, ad(255, 190, 110, 0.9), 1);
    this.burst(x, y, 7, 220, 0.35, 3, [255, 200, 120], 1, F_DOT, 5);
    this.burst(x, y, 3, 40, 0.9, 12, [90, 80, 75], 0, F_SMOKE, 2);
    var i = this.dHead; this.dHead = (i + 1) % DCAP;
    this.dX[i] = x; this.dY[i] = y; this.dS[i] = r * 1.3; this.dLife[i] = 6; this.dRot[i] = this.rnd.next() * 6.28;
    this.sound('boom');
  };

  P.death = function (type, x, y, radius) {
    var c = this.enemyRGB[type];
    var big = radius > 15;
    this.particle(x, y, 0, 0, big ? 0.5 : 0.22, radius * (big ? 6 : 3.2), radius, c[0], c[1], c[2], 1, F_GLOW, 0);
    this.burst(x, y, big ? 40 : (radius > 8 ? 7 : 4), big ? 260 : 150, big ? 0.9 : 0.45, big ? 5 : 3.2, c, 0, F_SHARD, 3);
    if (big) {
      this.ring(x, y, 10, 140, 0.6, ad(255, 120, 150, 1), 1);
      this.burst(x, y, 20, 120, 1.4, 16, [120, 60, 70], 0, F_SMOKE, 1.5);
      this.shake = Math.max(this.shake, 9);
      this.sound('bossdie');
    } else this.sound('pop');
  };

  P.arc = function (x0, y0, x1, y1, idx) {
    var i = this.bHead; this.bHead = (i + 1) % BCAP;
    this.bKind[i] = 1; this.bLife[i] = 0.16; this.bMax[i] = 0.16; this.bW[i] = idx === 0 ? 5 : 4;
    this.bCol[i] = ad(205, 160, 255, 1);
    var o = i * 12, R = this.rnd;
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len, j = Math.min(14, len * 0.22);
    for (let k = 0; k < 6; k++) {
      const t = k / 5, off = (k === 0 || k === 5) ? 0 : (R.next() - 0.5) * 2 * j;
      this.bPts[o + k * 2] = x0 + dx * t + nx * off;
      this.bPts[o + k * 2 + 1] = y0 + dy * t + ny * off;
    }
    this.particle(x1, y1, 0, 0, 0.15, 16, 6, 200, 160, 255, 1, F_GLOW, 0);
  };

  P.beam = function (x0, y0, x1, y1, level) {
    var i = this.bHead; this.bHead = (i + 1) % BCAP;
    this.bKind[i] = 0; this.bLife[i] = 0.32; this.bMax[i] = 0.32; this.bW[i] = 7 + level * 2;
    this.bCol[i] = ad(125, 255, 155, 1);
    var o = i * 12;
    this.bPts[o] = x0; this.bPts[o + 1] = y0; this.bPts[o + 2] = x1; this.bPts[o + 3] = y1;
    this.particle(x0, y0, 0, 0, 0.18, 26, 8, 140, 255, 170, 1, F_GLOW, 0);
    var R = this.rnd;
    for (let k = 0; k < 6; k++) {
      const t = R.next();
      this.particle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, (R.next() - 0.5) * 60, (R.next() - 0.5) * 60,
        0.4, 3, 0.5, 160, 255, 190, 1, F_DOT, 3);
    }
    this.sound('rail');
  };

  P.pulse = function (x, y, r) {
    this.ring(x, y, 12, r, 0.45, ad(150, 235, 255, 0.85), 1);
    this.ring(x, y, r * 0.98, r, 0.25, ad(150, 235, 255, 0.35), 0);
    var R = this.rnd;
    for (let k = 0; k < 6; k++) {
      const a = R.next() * 6.283, d = R.next() * r * 0.8;
      this.particle(x + Math.cos(a) * d, y + Math.sin(a) * d, 0, -14, 0.7, 7, 3, 200, 245, 255, 1, F_FLAKE, 1);
    }
    this.sound('frost');
  };

  P.heal = function (x, y, r) {
    this.ring(x, y, 6, r, 0.5, ad(90, 255, 150, 0.6), 1);
    var R = this.rnd;
    for (let k = 0; k < 4; k++) {
      this.particle(x + (R.next() - 0.5) * r, y + (R.next() - 0.5) * r, 0, -30, 0.7, 7, 4, 110, 255, 160, 1, F_PLUS, 1);
    }
  };

  P.summon = function (x, y) {
    this.ring(x, y, 8, 60, 0.5, ad(255, 120, 220, 0.8), 1);
  };

  P.leak = function (x, y, n) {
    this.baseFlash = 1;
    this.shake = Math.max(this.shake, 3 + n * 1.2);
    this.particle(x, y, 0, 0, 0.4, 70, 30, 255, 60, 80, 1, F_GLOW, 0);
    this.sound('leak');
  };

  P.popup = function (x, y, v) {
    var i = this.tHead; this.tHead = (i + 1) % TCAP;
    this.tX[i] = x; this.tY[i] = y; this.tV[i] = v; this.tLife[i] = 1.1; this.tCol[i] = pm(255, 214, 90, 255);
  };

  P.sound = function (name) { if (this.audio) this.audio.play(name); };

  // ---------------------------------------------------------------- update
  P.update = function (dt, realDt) {
    this.time += dt;
    this.budget = 900;
    this.shake *= 0.0015 ** realDt;
    if (this.shake < 0.05) this.shake = 0;
    this.baseFlash = Math.max(0, this.baseFlash - realDt * 2.5);
    if (dt <= 0) return;
    var life = this.life, px = this.px, py = this.py, vx = this.vx, vy = this.vy, drag = this.drag, grav = this.grav;
    var rot = this.rot, vr = this.vr;
    for (let i = 0; i < PCAP; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      let d = 1 - drag[i] * dt; if (d < 0) d = 0;
      vx[i] *= d; vy[i] = vy[i] * d + grav[i] * dt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      rot[i] += vr[i] * dt;
    }
    for (let i = 0; i < BCAP; i++) if (this.bLife[i] > 0) this.bLife[i] -= dt;
    for (let i = 0; i < RCAP; i++) if (this.rLife[i] > 0) this.rLife[i] -= dt;
    for (let i = 0; i < DCAP; i++) if (this.dLife[i] > 0) this.dLife[i] -= dt;
    for (let i = 0; i < TCAP; i++) if (this.tLife[i] > 0) this.tLife[i] -= dt;
  };

  P.count = function () {
    var n = 0;
    for (let i = 0; i < PCAP; i++) if (this.life[i] > 0) n++;
    return n;
  };
})();
