/* Bastion — procedural sprite atlas.
 * Every sprite in the game is drawn once at start-up with Canvas2D into a
 * single 2048x2048 texture, so the whole scene renders from one texture with
 * one draw call. Sprites are authored in world units and rasterised at SS
 * pixels per world unit, which keeps them crisp up to ~2x zoom on hi-dpi. */
var TD = globalThis.TD || (globalThis.TD = {});
(() => {
  'use strict';

  var SS = 2.5;           // atlas pixels per world unit
  var SIZE = 2048;
  var PAD = 3;

  function Atlas() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d');
    this.frames = {};
    this.sx = PAD; this.sy = PAD; this.rowH = 0;
    this.version = 0;
    buildAll(this);
  }

  /** Reserve a region and draw a sprite of world size w x h centred at 0,0. */
  Atlas.prototype.add = function (name, w, h, draw, _opts) {
    var pw = Math.ceil(w * SS), ph = Math.ceil(h * SS);
    if (this.sx + pw + PAD > SIZE) { this.sx = PAD; this.sy += this.rowH + PAD; this.rowH = 0; }
    var x = this.sx, y = this.sy;
    this.sx += pw + PAD;
    if (ph > this.rowH) this.rowH = ph;
    var c = this.ctx;
    c.save();
    c.beginPath(); c.rect(x, y, pw, ph); c.clip();
    c.translate(x + pw / 2, y + ph / 2);
    c.scale(SS, SS);
    draw(c, w, h);
    c.restore();
    var f = { name: name, x: x, y: y, pw: pw, ph: ph, w: w, h: h,
      u0: (x + 0.5) / SIZE, v0: (y + 0.5) / SIZE, u1: (x + pw - 0.5) / SIZE, v1: (y + ph - 0.5) / SIZE };
    this.frames[name] = f;
    return f;
  };

  /** Render one or more frames into a standalone data URL (UI icons). */
  Atlas.prototype.icon = function (names, px, rot) {
    var cv = document.createElement('canvas');
    cv.width = px; cv.height = px;
    var c = cv.getContext('2d');
    var maxW = 0;
    names.forEach((n) => { var f = this.frames[n]; maxW = Math.max(maxW, f.w, f.h); });
    var k = px / maxW;
    names.forEach((n) => {
      var f = this.frames[n];
      c.save();
      c.translate(px / 2, px / 2);
      if (rot) c.rotate(rot);
      c.drawImage(this.canvas, f.x, f.y, f.pw, f.ph, -f.w * k / 2, -f.h * k / 2, f.w * k, f.h * k);
      c.restore();
    });
    return cv.toDataURL();
  };

  // ------------------------------------------------------------ helpers
  function poly(c, pts) {
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.closePath();
  }
  function ngon(c, n, r, rot) {
    c.beginPath();
    for (var i = 0; i < n; i++) {
      var a = rot + i * Math.PI * 2 / n;
      if (i) c.lineTo(Math.cos(a) * r, Math.sin(a) * r); else c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function radial(c, r, stops) {
    var g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    for (var i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
    return g;
  }
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
    else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }
  function bodyFill(c, col, r) {
    var g = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.1);
    g.addColorStop(0, shade(col, 0.35));
    g.addColorStop(0.6, col);
    g.addColorStop(1, shade(col, -0.45));
    return g;
  }
  function outline(c, w) { c.lineWidth = w || 1; c.strokeStyle = 'rgba(8,10,18,0.85)'; c.stroke(); }

  // ------------------------------------------------------------ sprites
  function buildAll(A) {
    // utility sprites
    A.add('px', 2, 2, (c) => { c.fillStyle = '#fff'; c.fillRect(-2, -2, 4, 4); });
    A.add('glow', 32, 32, (c) => { c.fillStyle = radial(c, 16, [0, 'rgba(255,255,255,1)', 0.25, 'rgba(255,255,255,0.55)', 1, 'rgba(255,255,255,0)']); c.fillRect(-16, -16, 32, 32); });
    A.add('soft', 32, 32, (c) => { c.fillStyle = radial(c, 16, [0, 'rgba(255,255,255,0.9)', 0.55, 'rgba(255,255,255,0.35)', 1, 'rgba(255,255,255,0)']); c.fillRect(-16, -16, 32, 32); });
    A.add('dot', 8, 8, (c) => { c.beginPath(); c.arc(0, 0, 3.4, 0, 7); c.fillStyle = '#fff'; c.fill(); });
    A.add('shadow', 32, 32, (c) => { c.fillStyle = radial(c, 16, [0, 'rgba(0,0,0,0.75)', 0.6, 'rgba(0,0,0,0.35)', 1, 'rgba(0,0,0,0)']); c.fillRect(-16, -16, 32, 32); });
    A.add('ring', 128, 128, (c) => { c.beginPath(); c.arc(0, 0, 62, 0, 7); c.lineWidth = 1.6; c.strokeStyle = '#fff'; c.stroke(); });
    A.add('disc', 128, 128, (c) => { c.beginPath(); c.arc(0, 0, 63, 0, 7); c.fillStyle = '#fff'; c.fill(); });
    A.add('shock', 64, 64, (c) => {
      c.fillStyle = radial(c, 32, [0, 'rgba(255,255,255,0)', 0.7, 'rgba(255,255,255,0.05)', 0.9, 'rgba(255,255,255,0.9)', 1, 'rgba(255,255,255,0)']);
      c.fillRect(-32, -32, 64, 64);
    });
    A.add('tile', 40, 40, (c) => { rrect(c, -18.5, -18.5, 37, 37, 6); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke(); });
    A.add('tilefill', 40, 40, (c) => { rrect(c, -19, -19, 38, 38, 6); c.fillStyle = 'rgba(255,255,255,0.5)'; c.fill(); });
    A.add('streak', 24, 6, (c) => {
      var g = c.createLinearGradient(-12, 0, 12, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.75, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,1)');
      c.fillStyle = g; rrect(c, -12, -2.2, 24, 4.4, 2.2); c.fill();
    });
    A.add('beam', 32, 12, (c) => {
      var g = c.createLinearGradient(0, -6, 0, 6);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.42, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(0.58, 'rgba(255,255,255,0.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(-16, -6, 32, 12);
    });
    A.add('shard', 8, 8, (c) => { poly(c, [0, -3.6, 2.4, 0, 0, 3.6, -2.4, 0]); c.fillStyle = '#fff'; c.fill(); });
    A.add('flake', 12, 12, (c) => {
      c.strokeStyle = '#fff'; c.lineWidth = 1.1; c.lineCap = 'round';
      for (var i = 0; i < 3; i++) { c.save(); c.rotate(i * Math.PI / 3); c.beginPath(); c.moveTo(-5, 0); c.lineTo(5, 0); c.stroke(); c.restore(); }
    });
    A.add('plus', 12, 12, (c) => { c.fillStyle = '#fff'; rrect(c, -1.6, -5, 3.2, 10, 1); c.fill(); rrect(c, -5, -1.6, 10, 3.2, 1); c.fill(); });
    A.add('scorch', 48, 48, (c) => {
      c.fillStyle = radial(c, 24, [0, 'rgba(0,0,0,0.65)', 0.5, 'rgba(10,6,4,0.4)', 1, 'rgba(0,0,0,0)']);
      c.fillRect(-24, -24, 48, 48);
    });
    A.add('smoke', 32, 32, (c) => {
      for (var i = 0; i < 5; i++) {
        var a = i * 1.3, r = 6 + (i % 3) * 2;
        c.beginPath(); c.arc(Math.cos(a) * 5, Math.sin(a) * 5, r, 0, 7);
        c.fillStyle = 'rgba(255,255,255,0.22)'; c.fill();
      }
    });

    // projectiles
    A.add('bolt', 16, 8, (c) => {
      c.fillStyle = radial(c, 8, [0, 'rgba(255,255,255,1)', 0.4, 'rgba(160,240,255,0.8)', 1, 'rgba(60,200,255,0)']);
      c.save(); c.scale(1, 0.45); c.beginPath(); c.arc(0, 0, 8, 0, 7); c.fill(); c.restore();
    });
    A.add('shell', 12, 12, (c) => {
      c.beginPath(); c.arc(0, 0, 4.2, 0, 7); c.fillStyle = bodyFill(c, '#5a3a22', 4.2); c.fill(); outline(c, 0.8);
      c.beginPath(); c.arc(1.2, -1.2, 1.4, 0, 7); c.fillStyle = '#ffd08a'; c.fill();
    });

    // enemies (face +x)
    var EN = TD.ENEMIES;
    function enemy(id, size, fn) { A.add(`e_${id}`, size, size, fn); }
    enemy('grunt', 22, (c) => {
      var col = EN[0].color;
      ngon(c, 6, 9.5, Math.PI / 6); c.fillStyle = bodyFill(c, col, 9.5); c.fill(); outline(c, 1.2);
      ngon(c, 6, 5.2, Math.PI / 6); c.fillStyle = shade(col, -0.55); c.fill();
      rrect(c, 2.5, -2.2, 5, 4.4, 1.5); c.fillStyle = '#fff3d6'; c.fill();
    });
    enemy('runner', 22, (c) => {
      var col = EN[1].color;
      poly(c, [10, 0, -7, -7, -3.5, 0, -7, 7]); c.fillStyle = bodyFill(c, col, 9); c.fill(); outline(c, 1.1);
      poly(c, [6, 0, -1, -2.5, -1, 2.5]); c.fillStyle = '#fffbe0'; c.fill();
    });
    enemy('swarm', 14, (c) => {
      var col = EN[2].color;
      c.globalAlpha = 0.65; c.fillStyle = '#ffd6f4';
      c.beginPath(); c.ellipse(-1.5, -3.6, 3.2, 1.8, -0.5, 0, 7); c.fill();
      c.beginPath(); c.ellipse(-1.5, 3.6, 3.2, 1.8, 0.5, 0, 7); c.fill();
      c.globalAlpha = 1;
      poly(c, [6, 0, -4, -3.6, -2.5, 0, -4, 3.6]); c.fillStyle = bodyFill(c, col, 5); c.fill(); outline(c, 0.8);
    });
    enemy('tank', 30, (c) => {
      var col = EN[3].color;
      rrect(c, -12, -13.5, 24, 5, 2); c.fillStyle = '#2b3240'; c.fill(); outline(c, 0.8);
      rrect(c, -12, 8.5, 24, 5, 2); c.fillStyle = '#2b3240'; c.fill(); outline(c, 0.8);
      c.fillStyle = '#4a5466';
      for (var i = -10; i < 12; i += 4) { c.fillRect(i, -13, 1.4, 4); c.fillRect(i, 9, 1.4, 4); }
      rrect(c, -11, -9.5, 22, 19, 4); c.fillStyle = bodyFill(c, col, 12); c.fill(); outline(c, 1.3);
      rrect(c, -6.5, -6, 13, 12, 3); c.fillStyle = shade(col, -0.35); c.fill(); outline(c, 0.8);
      c.beginPath(); c.arc(1, 0, 3.2, 0, 7); c.fillStyle = '#ff5a5a'; c.fill();
      c.beginPath(); c.arc(1.6, -0.8, 1.1, 0, 7); c.fillStyle = '#ffd0d0'; c.fill();
    });
    enemy('healer', 23, (c) => {
      var col = EN[4].color;
      c.beginPath(); c.arc(0, 0, 10, 0, 7); c.fillStyle = bodyFill(c, col, 10); c.fill(); outline(c, 1.2);
      c.beginPath(); c.arc(0, 0, 7, 0, 7); c.fillStyle = shade(col, -0.5); c.fill();
      c.fillStyle = '#eafff2'; rrect(c, -1.6, -5, 3.2, 10, 1); c.fill(); rrect(c, -5, -1.6, 10, 3.2, 1); c.fill();
    });
    enemy('splitter', 26, (c) => {
      var col = EN[5].color;
      var pts = [[-3, -4.5], [-3, 4.5], [4.5, 0]];
      pts.forEach((p) => { c.beginPath(); c.arc(p[0], p[1], 6.6, 0, 7); c.fillStyle = bodyFill(c, col, 7); c.fill(); outline(c, 1.1); });
      pts.forEach((p) => { c.beginPath(); c.arc(p[0] + 0.8, p[1], 2.3, 0, 7); c.fillStyle = shade(col, -0.6); c.fill(); });
      c.beginPath(); c.arc(6, 0, 1.3, 0, 7); c.fillStyle = '#fff'; c.fill();
    });
    enemy('spawnling', 13, (c) => {
      var col = EN[6].color;
      c.beginPath(); c.arc(0, 0, 5.5, 0, 7); c.fillStyle = bodyFill(c, col, 5.5); c.fill(); outline(c, 0.9);
      c.beginPath(); c.arc(2.2, 0, 1.6, 0, 7); c.fillStyle = '#3a1a00'; c.fill();
    });
    enemy('boss', 58, (c) => {
      var col = EN[7].color;
      c.fillStyle = shade(col, -0.5);
      for (var i = 0; i < 8; i++) {
        c.save(); c.rotate(i * Math.PI / 4 + Math.PI / 8);
        poly(c, [20, -4, 27, 0, 20, 4]); c.fill(); outline(c, 1);
        c.restore();
      }
      ngon(c, 8, 22, Math.PI / 8); c.fillStyle = bodyFill(c, col, 22); c.fill(); outline(c, 1.8);
      ngon(c, 8, 15, Math.PI / 8); c.fillStyle = shade(col, -0.62); c.fill();
      c.lineWidth = 1.2; c.strokeStyle = shade(col, 0.1); c.stroke();
      c.beginPath(); c.arc(4, 0, 6, 0, 7); c.fillStyle = radial(c, 6, [0, '#fff', 0.4, '#ffd0dc', 1, '#ff3d6e']); c.fill();
      for (i = 0; i < 4; i++) { c.beginPath(); c.arc(-7, (i - 1.5) * 4.5, 1.4, 0, 7); c.fillStyle = '#ffb3c6'; c.fill(); }
    });

    // towers: shared base plate tinted per type + turret per level
    TD.TOWERS.forEach((def) => {
      var col = def.color;
      A.add(`tb_${def.id}`, 36, 36, (c) => {
        rrect(c, -16, -16, 32, 32, 7);
        var g = c.createLinearGradient(0, -16, 0, 16);
        g.addColorStop(0, '#36435a'); g.addColorStop(1, '#1b2232');
        c.fillStyle = g; c.fill(); outline(c, 1.4);
        rrect(c, -13.5, -13.5, 27, 27, 5); c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.08)'; c.stroke();
        c.fillStyle = col;
        [[-11, -11], [11, -11], [-11, 11], [11, 11]].forEach((p) => {
          c.globalAlpha = 0.9; c.beginPath(); c.arc(p[0], p[1], 1.6, 0, 7); c.fill();
        });
        c.globalAlpha = 1;
        c.beginPath(); c.arc(0, 0, 10, 0, 7); c.fillStyle = '#121822'; c.fill();
        c.lineWidth = 1.2; c.strokeStyle = shade(col, -0.35); c.stroke();
      });
      for (var lv = 0; lv < 4; lv++) {
        A.add(`tt_${def.id}${lv}`, 44, 44, turretDrawer(def.id, col, lv));
      }
    });

    // base / portal
    A.add('core', 80, 80, (c) => {
      ngon(c, 6, 30, 0); c.fillStyle = '#1a2233'; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#3a4a66'; c.stroke();
      ngon(c, 6, 24, 0); c.lineWidth = 1.2; c.strokeStyle = 'rgba(79,209,255,0.6)'; c.stroke();
      for (var i = 0; i < 6; i++) {
        c.save(); c.rotate(i * Math.PI / 3);
        rrect(c, 24, -3, 9, 6, 2); c.fillStyle = '#2a3650'; c.fill(); outline(c, 0.8);
        c.restore();
      }
      ngon(c, 6, 13, Math.PI / 6); c.fillStyle = radial(c, 14, [0, '#ffffff', 0.35, '#bff3ff', 1, '#2aa9e0']); c.fill();
    });
    A.add('portal', 48, 48, (c) => {
      for (var i = 0; i < 3; i++) {
        c.beginPath(); c.arc(0, 0, 20 - i * 5, i, i + 4.2);
        c.lineWidth = 2.4 - i * 0.5; c.strokeStyle = `rgba(255,255,255,${0.9 - i * 0.2})`; c.stroke();
      }
    });

    // glyphs for floating numbers
    var g = A.ctx;
    '0123456789+-$'.split('').forEach((ch) => {
      A.add(`ch_${ch}`, 9, 14, (c) => {
        c.font = '800 13px system-ui, -apple-system, Segoe UI, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 2.6; c.strokeStyle = 'rgba(0,0,0,0.85)'; c.strokeText(ch, 0, 0.8);
        c.fillStyle = '#fff'; c.fillText(ch, 0, 0.8);
      });
    });
    void g;
  }

  function turretDrawer(id, col, lv) {
    return (c) => {
      var dark = shade(col, -0.55), mid = shade(col, -0.2);
      if (id === 'blaster') {
        var n = lv >= 2 ? 2 : 1, len = 13 + lv * 1.5;
        for (var i = 0; i < n; i++) {
          var y = n === 1 ? 0 : (i ? 3.6 : -3.6);
          rrect(c, 2, y - 1.8, len, 3.6, 1.2); c.fillStyle = '#2b3446'; c.fill(); outline(c, 0.8);
          c.fillStyle = col; c.fillRect(len - 1, y - 1.2, 2.4, 2.4);
        }
        if (lv === 3) { poly(c, [-4, -9, 4, -6, 4, 6, -4, 9]); c.fillStyle = dark; c.fill(); outline(c, 0.8); }
        c.beginPath(); c.arc(0, 0, 7.5 + lv * 0.4, 0, 7); c.fillStyle = bodyFill(c, col, 8); c.fill(); outline(c, 1.1);
        c.beginPath(); c.arc(0, 0, 3, 0, 7); c.fillStyle = '#e8fbff'; c.fill();
      } else if (id === 'cannon') {
        var bw = 6 + lv * 0.8;
        rrect(c, 0, -bw / 2, 13 + lv, bw, 2); c.fillStyle = '#3a2c22'; c.fill(); outline(c, 1);
        c.fillStyle = col; c.fillRect(10 + lv, -bw / 2 - 0.6, 2.2, bw + 1.2);
        if (lv >= 2) { c.fillStyle = mid; c.fillRect(5, -bw / 2 - 0.4, 1.6, bw + 0.8); }
        ngon(c, 8, 9 + lv * 0.5, Math.PI / 8); c.fillStyle = bodyFill(c, '#8a6038', 9); c.fill(); outline(c, 1.1);
        ngon(c, 8, 5, Math.PI / 8); c.fillStyle = dark; c.fill();
        c.beginPath(); c.arc(0, 0, 2.2, 0, 7); c.fillStyle = col; c.fill();
        if (lv === 3) { for (var k = 0; k < 4; k++) { c.save(); c.rotate(k * Math.PI / 2 + Math.PI / 4); c.fillStyle = col; c.fillRect(7.5, -1, 3, 2); c.restore(); } }
      } else if (id === 'frost') {
        var r = 8 + lv * 1.2;
        for (k = 0; k < 6; k++) {
          c.save(); c.rotate(k * Math.PI / 3);
          poly(c, [r * 0.55, -2.2, r + 3, 0, r * 0.55, 2.2]); c.fillStyle = k % 2 ? '#d8fbff' : col; c.fill(); outline(c, 0.7);
          c.restore();
        }
        ngon(c, 6, r * 0.62, Math.PI / 6); c.fillStyle = bodyFill(c, col, r); c.fill(); outline(c, 1);
        ngon(c, 6, r * 0.3, 0); c.fillStyle = '#ffffff'; c.fill();
      } else if (id === 'tesla') {
        var prongs = 2 + lv;
        for (k = 0; k < prongs; k++) {
          c.save(); c.rotate(k * Math.PI * 2 / prongs);
          rrect(c, 5, -1.3, 7 + lv * 0.6, 2.6, 1); c.fillStyle = '#3b2a55'; c.fill(); outline(c, 0.7);
          c.beginPath(); c.arc(12 + lv * 0.6, 0, 1.8, 0, 7); c.fillStyle = col; c.fill();
          c.restore();
        }
        c.beginPath(); c.arc(0, 0, 8, 0, 7); c.fillStyle = '#2a2140'; c.fill(); outline(c, 1);
        c.beginPath(); c.arc(0, 0, 6.5, 0, 7); c.lineWidth = 1.4; c.strokeStyle = mid; c.stroke();
        c.beginPath(); c.arc(0, 0, 4.6, 0, 7); c.fillStyle = radial(c, 4.6, [0, '#ffffff', 0.5, '#e6d2ff', 1, col]); c.fill();
      } else if (id === 'rail') {
        var L = 17 + lv * 1.6;
        rrect(c, 0, -3.4, L, 2, 0.8); c.fillStyle = '#2b3a33'; c.fill(); outline(c, 0.6);
        rrect(c, 0, 1.4, L, 2, 0.8); c.fillStyle = '#2b3a33'; c.fill(); outline(c, 0.6);
        c.fillStyle = col; c.globalAlpha = 0.85; c.fillRect(2, -0.7, L - 3, 1.4); c.globalAlpha = 1;
        if (lv >= 2) { c.fillStyle = mid; c.fillRect(L * 0.45, -4.2, 2, 8.4); }
        poly(c, [-7, -7, 5, -5, 7, 0, 5, 5, -7, 7, -9, 0]); c.fillStyle = bodyFill(c, '#3f5a4a', 8); c.fill(); outline(c, 1);
        c.beginPath(); c.arc(-1, 0, 2.6, 0, 7); c.fillStyle = col; c.fill();
        if (lv === 3) { c.fillStyle = col; c.fillRect(-8.5, -1, 2, 2); }
      }
    };
  }

  TD.Atlas = Atlas;
  TD.ATLAS_SS = SS;
})();
