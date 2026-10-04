/* Bastion — shared namespace and small utilities (no DOM). */
var TD = globalThis.TD || (globalThis.TD = {});
(() => {
  'use strict';

  /** Deterministic PRNG (mulberry32). Gameplay randomness must come from here
   *  so that runs are reproducible regardless of frame rate. */
  function RNG(seed) { this.s = seed >>> 0; }
  RNG.prototype.next = function () {
    var t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (a, b) { return a + Math.floor((b - a + 1) * this.next()); };

  TD.RNG = RNG;

  TD.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  TD.lerp = (a, b, t) => a + (b - a) * t;

  /** Pack an RGBA colour (0-255 each) into a little-endian uint32 as used by
   *  the renderer's instance buffer (byte order r,g,b,a). */
  TD.rgba = (r, g, b, a) => ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
  TD.hexColor = (hex, a) => {
    var n = parseInt(hex.slice(1), 16);
    return TD.rgba(n >> 16 & 255, n >> 8 & 255, n & 255, a == null ? 255 : a);
  };
  TD.withAlpha = (c, a) => ((c & 0x00ffffff) | ((a & 255) << 24)) >>> 0;

  TD.formatNum = (n) => {
    n = Math.floor(n);
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
    if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  };
})();
