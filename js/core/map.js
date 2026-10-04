/* Bastion — map construction: tile grid, rounded paths sampled into lookup tables. */
var TD = globalThis.TD || (globalThis.TD = {});
(function () {
  'use strict';

  var STEP = 2;            // path sample spacing in world px
  var CORNER = 18;         // corner rounding radius in world px

  TD.TILE_FREE = 0;
  TD.TILE_PATH = 1;
  TD.TILE_ROCK = 2;
  TD.TILE_BASE = 3;

  /** Turn a list of tile waypoints into a smooth, uniformly sampled path.
   *  Result holds Float32Array tables so that position lookup is O(1):
   *  index = dist / STEP. */
  function samplePath(wps, tile) {
    var pts = wps.map(function (p) { return [(p[0] + 0.5) * tile, (p[1] + 0.5) * tile]; });
    // 1. dense polyline with rounded corners (quadratic bezier per corner)
    var poly = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var A = pts[i - 1], P = pts[i], B = pts[i + 1];
      var l1 = Math.hypot(P[0] - A[0], P[1] - A[1]);
      var l2 = Math.hypot(B[0] - P[0], B[1] - P[1]);
      var r = Math.min(CORNER, l1 / 2, l2 / 2);
      var d1x = (P[0] - A[0]) / l1, d1y = (P[1] - A[1]) / l1;
      var d2x = (B[0] - P[0]) / l2, d2y = (B[1] - P[1]) / l2;
      var p0 = [P[0] - d1x * r, P[1] - d1y * r];
      var p1 = [P[0] + d2x * r, P[1] + d2y * r];
      poly.push(p0);
      for (var s = 1; s <= 10; s++) {
        var t = s / 10, u = 1 - t;
        poly.push([u * u * p0[0] + 2 * u * t * P[0] + t * t * p1[0],
                   u * u * p0[1] + 2 * u * t * P[1] + t * t * p1[1]]);
      }
    }
    poly.push(pts[pts.length - 1]);

    // 2. cumulative lengths
    var cum = [0];
    for (i = 1; i < poly.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    }
    var len = cum[cum.length - 1];
    var n = Math.ceil(len / STEP) + 2;
    var x = new Float32Array(n), y = new Float32Array(n);
    var tx = new Float32Array(n), ty = new Float32Array(n), ang = new Float32Array(n);
    var seg = 0;
    for (var k = 0; k < n; k++) {
      var d = Math.min(k * STEP, len);
      while (seg < poly.length - 2 && cum[seg + 1] < d) seg++;
      var sl = cum[seg + 1] - cum[seg] || 1;
      var f = (d - cum[seg]) / sl;
      var ax = poly[seg][0], ay = poly[seg][1], bx = poly[seg + 1][0], by = poly[seg + 1][1];
      x[k] = ax + (bx - ax) * f;
      y[k] = ay + (by - ay) * f;
      var dl = Math.hypot(bx - ax, by - ay) || 1;
      tx[k] = (bx - ax) / dl; ty[k] = (by - ay) / dl;
    }
    // smooth tangents a bit so lateral offsets flow around corners
    for (k = 0; k < n; k++) {
      var a0 = Math.max(0, k - 4), a1 = Math.min(n - 1, k + 4);
      var sx = 0, sy = 0;
      for (var j = a0; j <= a1; j++) { sx += tx[j]; sy += ty[j]; }
      var sl2 = Math.hypot(sx, sy) || 1;
      tx[k] = sx / sl2; ty[k] = sy / sl2;
      ang[k] = Math.atan2(ty[k], tx[k]);
    }
    return { x: x, y: y, tx: tx, ty: ty, ang: ang, len: len, n: n, step: STEP, inv: 1 / STEP, poly: poly, waypoints: pts };
  }

  /** Build a runtime map from a definition in TD.MAPS. */
  TD.buildMap = function (def) {
    var cols = TD.COLS, rows = TD.ROWS, tile = TD.TILE;
    var grid = new Uint8Array(cols * rows);
    var paths = def.paths.map(function (wps) { return samplePath(wps, tile); });

    // rasterise axis-aligned path segments into the tile grid
    def.paths.forEach(function (wps) {
      for (var i = 0; i < wps.length - 1; i++) {
        var a = wps[i], b = wps[i + 1];
        var dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
        var cx = a[0], cy = a[1];
        for (;;) {
          if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) grid[cy * cols + cx] = TD.TILE_PATH;
          if (cx === b[0] && cy === b[1]) break;
          cx += dx; cy += dy;
        }
      }
    });
    // base: last waypoint of first path plus surrounding ring
    var end = def.paths[0][def.paths[0].length - 1];
    for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
      var bx = end[0] + ox, by = end[1] + oy;
      if (bx >= 0 && bx < cols && by >= 0 && by < rows) grid[by * cols + bx] = TD.TILE_BASE;
    }
    // decorative rocks: deterministic per map, never on/adjacent to spawn columns
    var rng = new TD.RNG(def.seed * 977);
    for (var r = 0; r < rows; r++) for (var c = 1; c < cols; c++) {
      var idx = r * cols + c;
      if (grid[idx] !== TD.TILE_FREE) continue;
      if (rng.next() < 0.045) grid[idx] = TD.TILE_ROCK;
    }
    return {
      def: def, cols: cols, rows: rows, tile: tile,
      width: cols * tile, height: rows * tile,
      grid: grid, paths: paths,
      base: { x: (end[0] + 0.5) * tile, y: (end[1] + 0.5) * tile, col: end[0], row: end[1] }
    };
  };
})();
