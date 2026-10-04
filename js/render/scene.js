/* Bastion — scene builder: turns sim + fx state into renderer instances.
 * Enemies are culled through the simulation's spatial grid, so only grid cells
 * overlapping the camera view are visited: off-screen enemies cost nothing to
 * render. Everything else is bounds-checked before being queued. */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var pm = TD.pm, ad = TD.ad;
  var WHITE = 0xffffffff;
  var CELL = 40;
  var NODEBUG = {};

  function Scene(renderer, atlas) {
    this.r = renderer;
    this.F = atlas.frames;
    var F = this.F;
    this.eF = TD.ENEMIES.map((e) => F[`e_${e.id}`]);
    this.eBig = new Uint8Array(TD.ENEMIES.map((e) => (e.radius > 12 ? 1 : 0)));
    this.tB = TD.TOWERS.map((t) => [0, 1, 2, 3].map((l) => F[`tb_${t.id}${l}`]));
    this.tT = TD.TOWERS.map((t) => [0, 1, 2, 3].map((l) => F[`tt_${t.id}${l}`]));
    this.pF = TD.FX_FRAMES.map((n) => F[n]);
    this.chF = {};
    for (let d = 0; d <= 9; d++) this.chF[d] = F[`ch_${d}`];
    this.chPlus = F['ch_+'];
    this.vis = new Int32Array(8192);
    this.nVis = 0;
    this.stats = { visibleEnemies: 0, instances: 0 };
    this.towerCol = TD.TOWERS.map((t) => { var n = parseInt(t.color.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; });
    // pre-baked colours
    this.C = {
      shadow: pm(255, 255, 255, 150),
      slow: pm(165, 215, 255, 255),
      barBg: pm(6, 8, 14, 200),
      rangeFill: pm(79, 209, 255, 22), rangeLine: pm(120, 220, 255, 150),
      badFill: pm(255, 80, 90, 28), badLine: pm(255, 100, 110, 170),
      ghost: pm(255, 255, 255, 150),
      okTile: pm(90, 255, 170, 70), badTile: pm(255, 80, 90, 80),
      hover: pm(160, 210, 255, 60),
      shellGlow: ad(255, 160, 60, 0.6), bolt: ad(150, 235, 255, 1)
    };
  }
  TD.Scene = Scene;

  function barColor(f) {
    // green -> yellow -> red
    var r, g;
    if (f > 0.5) { r = (1 - f) * 2 * 255; g = 235; } else { r = 255; g = f * 2 * 235; }
    return TD.rgba(r, g, 70, 255);
  }

  /** Enemies from a worker snapshot (dense arrays, no grid): bounds check
   *  per enemy. Kept out of build() so it optimises as its own small loop. */
  Scene.prototype.enemiesDense = function (sim, alpha, t, x0, y0, x1, y1, skip) {
    var r = this.r, F = this.F, C = this.C, vis = this.vis, nv = 0;
    var ex = sim.eX, ey = sim.eY, epx = sim.ePX, epy = sim.ePY, rot = sim.eRot, type = sim.eType;
    var flash = sim.eFlash, slowT = sim.eSlowT, slot = sim.eSlot, eF = this.eF, big = this.eBig;
    var shadow = F.shadow, cShadow = C.shadow, cSlow = C.slow;
    for (let s = 0, n = sim.eCount; s < n; s++) {
      const X = epx[s] + (ex[s] - epx[s]) * alpha, Y = epy[s] + (ey[s] - epy[s]) * alpha;
      if (X < x0 - 30 || X > x1 + 30 || Y < y0 - 30 || Y > y1 + 30) continue;
      vis[nv++] = s;
      if (skip) continue;
      const ty = type[s], fr = eF[ty];
      if (big[ty]) r.push(shadow, X + 3, Y + 5, fr.w * 1.1, fr.h * 0.9, 0, cShadow);
      r.push(fr, X, Y, fr.w, fr.h, rot[s] + Math.sin(t * 9 + slot[s]) * 0.07, slowT[s] > 0 ? cSlow : WHITE, flash[s] > 0 ? flash[s] * 0.55 : 0);
    }
    return nv;
  };

  Scene.prototype.bars = function (sim, alpha, crot, nv) {
    var r = this.r, px = this.F.px, vis = this.vis, ENE = TD.ENEMIES, type = sim.eType;
    var hp = sim.eHp, mhp = sim.eMaxHp, ex = sim.eX, ey = sim.eY, epx = sim.ePX, epy = sim.ePY;
    for (let i = 0; i < nv; i++) {
      const s = vis[i];
      const hf = hp[s] / mhp[s];
      if (hf >= 0.999) continue;
      const er = ENE[type[s]].radius, big = er > 15;
      const bw = big ? 46 : Math.max(12, er * 2.2), bh = big ? 5 : 3;
      const lift2 = er + (big ? 10 : 6);
      let X = epx[s] + (ex[s] - epx[s]) * alpha, Y = epy[s] + (ey[s] - epy[s]) * alpha;
      if (crot) X -= lift2; else Y -= lift2;
      r.bar(px, X, Y, bw, bh + 1, crot, hf, barColor(hf));
    }
  };

  Scene.prototype.projectiles = function (sim, alpha, x0, y0, x1, y1) {
    var r = this.r, F = this.F, C = this.C, SHELL = TD.PROJ_SHELL;
    var pX = sim.pX, pY = sim.pY, pPX = sim.pPX, pPY = sim.pPY, pTX = sim.pTX, pTY = sim.pTY, kind = sim.pKind, age = sim.pAge;
    for (let i = 0, pc = sim.pCount; i < pc; i++) {
      const PX = pPX[i] + (pX[i] - pPX[i]) * alpha, PY = pPY[i] + (pY[i] - pPY[i]) * alpha;
      if (PX < x0 - 20 || PX > x1 + 20 || PY < y0 - 20 || PY > y1 + 20) continue;
      const pa = Math.atan2(pTY[i] - PY, pTX[i] - PX);
      if (kind[i] === SHELL) {
        const lift = Math.min(1, age[i] * 3);
        r.push(F.glow, PX, PY - 3 * lift, 18, 18, 0, C.shellGlow);
        r.push(F.shell, PX, PY - 3 * lift, 12 + lift * 2, 12 + lift * 2, pa, WHITE);
      } else {
        r.push(F.bolt, PX, PY, 18, 7, pa, C.bolt);
      }
    }
  };

  Scene.prototype.beams = function (fx) {
    var r = this.r, beam = this.F.beam, bp = fx.bPts, bLife = fx.bLife, bMax = fx.bMax, bCol = fx.bCol, bW = fx.bW, bKind = fx.bKind;
    for (let i = 0; i < bLife.length; i++) {
      if (bLife[i] <= 0) continue;
      const lf = bLife[i] / bMax[i], bc = bCol[i], o = i * 12;
      const bcol = TD.rgba((bc & 255) * lf, (bc >> 8 & 255) * lf, (bc >> 16 & 255) * lf, 0);
      const core = ad(255, 255, 255, lf);
      if (bKind[i] === 0) {
        const w = bW[i] * (0.4 + lf * 0.6);
        r.line(beam, bp[o], bp[o + 1], bp[o + 2], bp[o + 3], w * 2.2, bcol);
        r.line(beam, bp[o], bp[o + 1], bp[o + 2], bp[o + 3], w * 0.7, core);
      } else {
        for (let k = 0; k < 5; k++) {
          const q = o + k * 2;
          r.line(beam, bp[q], bp[q + 1], bp[q + 2], bp[q + 3], bW[i] * 1.8, bcol);
          r.line(beam, bp[q], bp[q + 1], bp[q + 2], bp[q + 3], bW[i] * 0.6, core);
        }
      }
    }
  };

  Scene.prototype.particles = function (fx, x0, y0, x1, y1) {
    var r = this.r, pF = this.pF, life = fx.life, mx = fx.max, px = fx.px, py = fx.py, s0 = fx.s0, s1 = fx.s1;
    var frame = fx.frame, add = fx.add, R = fx.r, G = fx.g, B = fx.b, rot = fx.rot, vx = fx.vx, vy = fx.vy;
    for (let i = 0; i < life.length; i++) {
      if (life[i] <= 0) continue;
      const X2 = px[i], Y2 = py[i];
      if (X2 < x0 - 40 || X2 > x1 + 40 || Y2 < y0 - 40 || Y2 > y1 + 40) continue;
      const lt = life[i] / mx[i];
      const sz = s1[i] + (s0[i] - s1[i]) * lt;
      const pfr = pF[frame[i]];
      const pcol = add[i] ? ad(R[i], G[i], B[i], lt) : pm(R[i], G[i], B[i], 255 * Math.min(1, lt * 1.5));
      if (frame[i] === 7) {   // streaks align with velocity
        r.push(pfr, X2, Y2, sz * 3, sz, Math.atan2(vy[i], vx[i]), pcol);
      } else r.push(pfr, X2, Y2, sz, sz, rot[i], pcol);
    }
  };

  Scene.prototype.build = function (sim, fx, cam, view, alpha, ui, t) {
    var r = this.r, F = this.F, C = this.C;
    var crot = cam.rot ? -Math.PI / 2 : 0;   // counter-rotation for screen-aligned elements
    r.begin();
    var x0 = view.x0, y0 = view.y0, x1 = view.x1, y1 = view.y1;
    var i, k, a, _f;

    // ---- scorch decals
    for (i = 0; i < fx.dLife.length; i++) {
      if (fx.dLife[i] <= 0) continue;
      a = Math.min(1, fx.dLife[i] / 2);
      r.push(F.scorch, fx.dX[i], fx.dY[i], fx.dS[i], fx.dS[i], fx.dRot[i], pm(255, 255, 255, 200 * a));
    }

    // ---- route preview while waiting between waves
    var paths = sim.map.paths;
    if (sim.state === 'prep' || sim.countdown > 0) {
      for (let pi = 0; pi < paths.length; pi++) {
        const p = paths[pi];
        for (let d = (t * 70) % 48; d < p.len; d += 48) {
          k = (d * p.inv) | 0;
          const fade = Math.min(1, d / 80, (p.len - d) / 80);
          r.push(F.dot, p.x[k], p.y[k], 5, 5, 0, ad(255, 110, 140, 0.55 * fade));
        }
      }
    }

    // ---- spawn portals
    for (let pi = 0; pi < paths.length; pi++) {
      const sx = 6, sy = paths[pi].waypoints[0][1];
      r.push(F.glow, sx, sy, 70, 70, 0, ad(255, 60, 110, 0.55 + 0.15 * Math.sin(t * 3)));
      r.push(F.portal, sx, sy, 44, 44, t * 2.2, ad(255, 120, 170, 0.9));
      r.push(F.portal, sx, sy, 30, 30, -t * 3.1, ad(255, 200, 220, 0.8));
    }

    // ---- base core
    var b = sim.map.base, lifeF = sim.lives / sim.maxLives;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
    r.push(F.glow, b.x, b.y, 150 + pulse * 20, 150 + pulse * 20, 0, ad(79 + (1 - lifeF) * 170, 209 - (1 - lifeF) * 120, 255 - (1 - lifeF) * 150, 0.45));
    r.push(F.core, b.x, b.y, 80, 80, t * 0.15, WHITE);
    if (fx.baseFlash > 0) r.push(F.glow, b.x, b.y, 190, 190, 0, ad(255, 50, 70, fx.baseFlash));

    // ---- selected / hovered tower range
    var showT = ui.selected ? sim.towerById[ui.selected] : null;
    if (!showT && ui.hoverTower) showT = sim.towerById[ui.hoverTower];
    if (showT) {
      const rg = showT.def.levels[showT.level].range;
      r.push(F.disc, showT.x, showT.y, rg * 2, rg * 2, 0, C.rangeFill);
      r.push(F.ring, showT.x, showT.y, rg * 2, rg * 2, 0, C.rangeLine);
      if (ui.selected === showT.id) r.push(F.tile, showT.x, showT.y, 40, 40, 0, pm(120, 220, 255, 220));
    }

    // ---- fx rings (under units)
    for (i = 0; i < fx.rLife.length; i++) {
      if (fx.rLife[i] <= 0) continue;
      const e = 1 - fx.rLife[i] / fx.rMax[i];
      const rad = fx.rR0[i] + (fx.rR1[i] - fx.rR0[i]) * (1 - (1 - e) * (1 - e));
      const rc = fx.rCol[i], fa = 1 - e;
      const col = TD.rgba((rc & 255) * fa, (rc >> 8 & 255) * fa, (rc >> 16 & 255) * fa, (rc >>> 24) * fa);
      r.push(fx.rFrame[i] === 1 ? F.shock : F.ring, fx.rX[i], fx.rY[i], rad * 2, rad * 2, 0, col);
    }

    var dbg = TD.debug || NODEBUG;
    // ---- enemies (grid-culled)
    var gc = sim.gCols, gr = sim.gRows;
    var c0 = Math.max(0, ((x0 - 30) / CELL) | 0), c1 = Math.min(gc - 1, ((x1 + 30) / CELL) | 0);
    var r0 = Math.max(0, ((y0 - 30) / CELL) | 0), r1 = Math.min(gr - 1, ((y1 + 30) / CELL) | 0);
    if (x0 < 0) c0 = 0;
    var start = sim.gStart, items = sim.gItems, alive = sim.eAlive;
    var ex = sim.eX, ey = sim.eY, epx = sim.ePX, epy = sim.ePY, rot = sim.eRot, type = sim.eType;
    var flash = sim.eFlash, slowT = sim.eSlowT, vis = this.vis, nv = 0;
    var eF = this.eF, ENE = TD.ENEMIES;
    if (sim.isView) {
      nv = this.enemiesDense(sim, alpha, t, x0, y0, x1, y1, dbg.noEnemies);
    } else for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = cy * gc + cx;
        for (let it = start[cell], end = start[cell + 1]; it < end; it++) {
          const s = items[it];
          if (!alive[s]) continue;
          const X = epx[s] + (ex[s] - epx[s]) * alpha, Y = epy[s] + (ey[s] - epy[s]) * alpha;
          if (X < x0 - 30 || X > x1 + 30 || Y < y0 - 30 || Y > y1 + 30) continue;
          vis[nv++] = s;
          if (dbg.noEnemies) continue;
          const ty = type[s], fr = eF[ty];
          const wob = Math.sin(t * 9 + s) * 0.07;
          if (ENE[ty].radius > 12) r.push(F.shadow, X + 3, Y + 5, fr.w * 1.1, fr.h * 0.9, 0, C.shadow);
          r.push(fr, X, Y, fr.w, fr.h, rot[s] + wob, slowT[s] > 0 ? C.slow : WHITE, flash[s] > 0 ? flash[s] * 0.55 : 0);
        }
      }
    }
    this.nVis = nv;

    // ---- towers
    var towers = sim.towers;
    for (i = 0; i < towers.length; i++) {
      const tw = towers[i];
      if (tw.x < x0 - 30 || tw.x > x1 + 30 || tw.y < y0 - 30 || tw.y > y1 + 30) continue;
      const tc = this.towerCol[tw.type];
      r.push(F.shadow, tw.x + 3, tw.y + 5, 44, 40, 0, C.shadow);
      r.push(this.tB[tw.type][tw.level], tw.x, tw.y, 36, 36, 0, WHITE);
      const kind = tw.def.kind, tt = this.tT[tw.type][tw.level];
      let ang = tw.angle, rec = tw.recoil > 0 ? tw.recoil : 0;
      if (kind === 'pulse') {
        ang = t * 0.8 + tw.id;
        r.push(F.glow, tw.x, tw.y, 30 + tw.level * 4, 30 + tw.level * 4, 0, ad(tc[0], tc[1], tc[2], 0.25 + rec * 0.5));
      } else if (kind === 'chain') {
        ang = t * 0.6 + tw.id;
        r.push(F.glow, tw.x, tw.y, 26, 26, 0, ad(tc[0], tc[1], tc[2], 0.35 + 0.2 * Math.sin(t * 7 + tw.id) + rec * 0.4));
      }
      const ca = Math.cos(tw.angle), sa = Math.sin(tw.angle);
      const kick = kind === 'pulse' || kind === 'chain' ? 0 : rec * 3;
      r.push(tt, tw.x - ca * kick, tw.y - sa * kick, 44, 44, ang, WHITE);
      if ((kind === 'bullet' || kind === 'beam') && rec > 0.6) {
        const mz = kind === 'beam' ? 22 : 17;
        r.push(F.glow, tw.x + ca * mz, tw.y + sa * mz, 16 * rec, 16 * rec, 0, ad(tc[0], tc[1], tc[2], rec));
      }
      // level pips
      for (k = 0; k <= tw.level; k++) {
        r.push(F.dot, tw.x - (tw.level * 3.5) + k * 7, tw.y + 15, 4.5, 4.5, 0, k === 3 ? pm(255, 215, 90, 255) : pm(tc[0], tc[1], tc[2], 255));
      }
    }

    // ---- enemy health bars (over towers for readability), projectiles,
    // beams & arcs, particles: each in its own method so every hot loop is
    // optimised as a small function (one huge build() optimised poorly)
    this.bars(sim, alpha, crot, nv);
    this.projectiles(sim, alpha, x0, y0, x1, y1);
    this.beams(fx);
    if (!dbg.noParticles) this.particles(fx, x0, y0, x1, y1);

    // ---- floating reward numbers (screen-aligned, drift upward on screen)
    for (i = 0; i < fx.tLife.length; i++) {
      if (fx.tLife[i] <= 0) continue;
      const tl = Math.min(1, fx.tLife[i] * 2.5), rise = (1.1 - fx.tLife[i]) * 26;
      const v = fx.tV[i], digits = v >= 100 ? 3 : v >= 10 ? 2 : 1;
      const half = (digits + 1) * 4;
      // advance direction along screen-x, expressed in world space
      const ax = crot ? 0 : 1, ay = crot ? -1 : 0;
      let tx = fx.tX[i] - ax * half - (crot ? rise : 0), tyy = fx.tY[i] - ay * half - (crot ? 0 : rise);
      const tcl = TD.rgba(255 * tl, 214 * tl, 90 * tl, 255 * tl);
      r.push(this.chPlus, tx, tyy, 9, 14, crot, tcl);
      for (k = digits - 1; k >= 0; k--) {
        const dg = Math.floor(v / 10 ** k) % 10;
        tx += ax * 8; tyy += ay * 8;
        r.push(this.chF[dg], tx, tyy, 9, 14, crot, tcl);
      }
    }

    // ---- build ghost / hover
    if (ui.placing >= 0 && ui.hoverCol >= 0) {
      const gx = (ui.hoverCol + 0.5) * TD.TILE, gy = (ui.hoverRow + 0.5) * TD.TILE;
      const ok = ui.hoverValid;
      const def = TD.TOWERS[ui.placing], rr = def.levels[0].range;
      r.push(F.tilefill, gx, gy, 40, 40, 0, ok ? C.okTile : C.badTile);
      r.push(F.disc, gx, gy, rr * 2, rr * 2, 0, ok ? C.rangeFill : C.badFill);
      r.push(F.ring, gx, gy, rr * 2, rr * 2, 0, ok ? C.rangeLine : C.badLine);
      r.push(this.tB[ui.placing][0], gx, gy, 36, 36, 0, C.ghost);
      r.push(this.tT[ui.placing][0], gx, gy, 44, 44, -Math.PI / 2, C.ghost);
    } else if (ui.hoverCol >= 0 && ui.hoverTower) {
      r.push(F.tile, (ui.hoverCol + 0.5) * TD.TILE, (ui.hoverRow + 0.5) * TD.TILE, 40, 40, 0, C.hover);
    }

    this.stats.visibleEnemies = nv;
    this.stats.instances = r.n;
  };
})();
