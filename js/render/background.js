/* Bastion — static map background, rasterised once per map into a texture. */
var TD = globalThis.TD || (globalThis.TD = {});
(function () {
  'use strict';

  function strokePath(c, poly) {
    c.beginPath();
    c.moveTo(poly[0][0], poly[0][1]);
    for (var i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1]);
  }

  /** Draw the map at `scale` px per world unit. Returns a canvas. */
  TD.renderBackground = function (map, scale) {
    var W = map.width, H = map.height, T = map.tile;
    var cv = document.createElement('canvas');
    cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
    var c = cv.getContext('2d');
    c.scale(scale, scale);
    var rng = new TD.RNG(map.def.seed * 31 + 7);

    // ground
    var g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#111a26'); g.addColorStop(1, '#0c131d');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // mottled terrain patches
    for (var i = 0; i < 260; i++) {
      var x = rng.next() * W, y = rng.next() * H, r = 20 + rng.next() * 70;
      var rg = c.createRadialGradient(x, y, 0, x, y, r);
      var tone = rng.next() < 0.5 ? '40,70,80' : '30,45,70';
      rg.addColorStop(0, 'rgba(' + tone + ',0.10)'); rg.addColorStop(1, 'rgba(' + tone + ',0)');
      c.fillStyle = rg; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // speckle
    for (i = 0; i < 2600; i++) {
      c.fillStyle = rng.next() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.12)';
      c.fillRect(rng.next() * W, rng.next() * H, 1 + rng.next() * 1.5, 1 + rng.next() * 1.5);
    }
    // buildable tile grid
    for (var r = 0; r < map.rows; r++) for (var col = 0; col < map.cols; col++) {
      var t = map.grid[r * map.cols + col];
      if (t !== TD.TILE_FREE) continue;
      c.fillStyle = (r + col) & 1 ? 'rgba(120,170,220,0.035)' : 'rgba(120,170,220,0.018)';
      c.fillRect(col * T + 1, r * T + 1, T - 2, T - 2);
      c.strokeStyle = 'rgba(140,190,240,0.06)'; c.lineWidth = 1;
      c.strokeRect(col * T + 1.5, r * T + 1.5, T - 3, T - 3);
    }

    // paths: outer glow, bed, inner lane, centre dashes
    c.lineJoin = 'round'; c.lineCap = 'round';
    map.paths.forEach(function (p) {
      strokePath(c, p.poly); c.lineWidth = 46; c.strokeStyle = 'rgba(79,209,255,0.05)'; c.stroke();
    });
    map.paths.forEach(function (p) {
      strokePath(c, p.poly); c.lineWidth = 38; c.strokeStyle = '#0a0f17'; c.stroke();
    });
    map.paths.forEach(function (p) {
      strokePath(c, p.poly); c.lineWidth = 34; c.strokeStyle = '#1a2433'; c.stroke();
    });
    map.paths.forEach(function (p) {
      strokePath(c, p.poly); c.lineWidth = 30; c.strokeStyle = '#1f2b3d'; c.stroke();
      strokePath(c, p.poly); c.lineWidth = 1; c.setLineDash([6, 10]); c.strokeStyle = 'rgba(160,200,255,0.12)'; c.stroke();
      c.setLineDash([]);
    });
    // direction chevrons
    map.paths.forEach(function (p) {
      for (var d = 60; d < p.len - 40; d += 120) {
        var k = (d * p.inv) | 0;
        c.save(); c.translate(p.x[k], p.y[k]); c.rotate(p.ang[k]);
        c.beginPath(); c.moveTo(-3, -6); c.lineTo(3, 0); c.lineTo(-3, 6);
        c.lineWidth = 2; c.strokeStyle = 'rgba(160,210,255,0.13)'; c.stroke();
        c.restore();
      }
    });
    // path edge highlights
    map.paths.forEach(function (p) {
      strokePath(c, p.poly); c.lineWidth = 34; c.strokeStyle = 'rgba(0,0,0,0)'; c.stroke();
    });

    // rocks / crystals on blocked tiles
    for (r = 0; r < map.rows; r++) for (col = 0; col < map.cols; col++) {
      if (map.grid[r * map.cols + col] !== TD.TILE_ROCK) continue;
      var cx = (col + 0.5) * T, cy = (r + 0.5) * T;
      if (rng.next() < 0.7) drawRock(c, cx, cy, rng); else drawCrystal(c, cx, cy, rng);
    }

    // base platform
    var b = map.base;
    c.save(); c.translate(b.x, b.y);
    c.fillStyle = 'rgba(79,209,255,0.06)';
    c.beginPath(); c.arc(0, 0, 58, 0, 7); c.fill();
    c.strokeStyle = 'rgba(79,209,255,0.18)'; c.lineWidth = 1.5;
    c.setLineDash([4, 6]); c.beginPath(); c.arc(0, 0, 54, 0, 7); c.stroke(); c.setLineDash([]);
    c.restore();

    // vignette
    var vg = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    return cv;
  };

  function drawRock(c, x, y, rng) {
    var n = 6 + (rng.next() * 3 | 0), r = 11 + rng.next() * 5;
    c.save(); c.translate(x + rng.range(-3, 3), y + rng.range(-3, 3));
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.ellipse(2, 4, r, r * 0.7, 0, 0, 7); c.fill();
    c.beginPath();
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2, rr = r * (0.75 + rng.next() * 0.3);
      if (i) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.85); else c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.85);
    }
    c.closePath();
    var g = c.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#3b4658'); g.addColorStop(1, '#1c2330');
    c.fillStyle = g; c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.moveTo(-r * 0.4, -r * 0.3); c.lineTo(r * 0.1, -r * 0.5);
    c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1.5; c.stroke();
    c.restore();
  }

  function drawCrystal(c, x, y, rng) {
    c.save(); c.translate(x, y);
    var hue = rng.next() < 0.5 ? '120,220,255' : '190,140,255';
    var glow = c.createRadialGradient(0, 0, 0, 0, 0, 20);
    glow.addColorStop(0, 'rgba(' + hue + ',0.25)'); glow.addColorStop(1, 'rgba(' + hue + ',0)');
    c.fillStyle = glow; c.fillRect(-20, -20, 40, 40);
    for (var i = 0; i < 3; i++) {
      c.save(); c.rotate(-0.5 + i * 0.5 + rng.range(-0.15, 0.15));
      var h = 9 + rng.next() * 7;
      c.beginPath(); c.moveTo(0, 3); c.lineTo(-3, -h * 0.5); c.lineTo(0, -h); c.lineTo(3, -h * 0.5); c.closePath();
      c.fillStyle = 'rgba(' + hue + ',0.75)'; c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 0.8; c.stroke();
      c.restore();
    }
    c.restore();
  }
})();
