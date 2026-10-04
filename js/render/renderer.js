/* Bastion — batched sprite renderer.
 *
 * The whole dynamic scene is written each frame into ONE interleaved instance
 * buffer (x, y, w, h, rot, u0, v0, u1, v1, rgba) and drawn with ONE instanced
 * draw call from ONE texture atlas. Colours are premultiplied, so a sprite with
 * tint alpha = 0 is blended additively in the same pass (glows, beams, sparks)
 * while preserving painter's order — no blend-state switches, no sorting.
 *
 * Backends: WebGL2 -> WebGL1 + ANGLE_instanced_arrays -> Canvas2D fallback.
 */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var FLOATS = 11;          // per instance: x y w h rot u0 v0 u1 v1 rgba flash
  var BYTES = FLOATS * 4;

  var VS = [
    'attribute vec2 aCorner;',
    'attribute vec4 aRect;',
    'attribute float aRot;',
    'attribute vec4 aUV;',
    'attribute vec4 aColor;',
    'attribute float aFlash;',
    'uniform vec4 uM;',   // world->clip 2x2 matrix (columns) — allows a 90deg portrait camera
    'uniform vec2 uT;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'varying float vFlash;',
    'varying vec2 vLocal;',
    'void main() {',
    '  vec2 p = aCorner * aRect.zw;',
    '  float c = cos(aRot), s = sin(aRot);',
    '  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + aRect.xy;',
    '  gl_Position = vec4(uM.xy * p.x + uM.zw * p.y + uT, 0.0, 1.0);',
    '  vUV = mix(aUV.xy, aUV.zw, aCorner + 0.5);',
    '  vColor = aColor;',
    '  vFlash = aFlash;',
    '  vLocal = aCorner + 0.5;',
    '}'
  ].join('\n');
  var FS = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'varying float vFlash;',
    'varying vec2 vLocal;',
    'void main() {',
    // flash < -0.5 => progress bar: fill fraction = -flash - 1 (one quad per health bar)
    '  if (vFlash < -0.5) {',
    '    float edge = step(0.22, vLocal.y) * step(vLocal.y, 0.78);',
    '    vec4 bg = vec4(0.02, 0.03, 0.05, 0.85);',
    '    gl_FragColor = (vLocal.x <= -vFlash - 1.0) ? mix(vColor * 0.55, vColor, edge) : bg;',
    '    return;',
    '  }',
    // hit flash: mix toward white inside the sprite silhouette (no extra quad)
    '  vec4 t = texture2D(uTex, vUV);',
    '  gl_FragColor = mix(t * vColor, vec4(t.a * vColor.a), vFlash);',
    '}'
  ].join('\n');

  function Renderer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.cap = 1 << 16;
    this.buf = new ArrayBuffer(this.cap * BYTES);
    this.f32 = new Float32Array(this.buf);
    this.u32 = new Uint32Array(this.buf);
    this.n = 0;
    this.drawCalls = 0;
    this.backend = 'none';
    if (!opts.force2d && this.initGL()) return;
    this.init2D();
  }
  TD.Renderer = Renderer;
  var R = Renderer.prototype;

  // ------------------------------------------------------------------ setup
  R.initGL = function () {
    var attrs = { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
      powerPreference: 'high-performance' };
    var gl = this.canvas.getContext('webgl2', attrs);
    var inst = null;
    if (gl) { this.backend = 'webgl2'; }
    else {
      gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
      if (!gl) return false;
      const ext = gl.getExtension('ANGLE_instanced_arrays');
      if (!ext) return false;
      inst = {
        divisor: (i, d) => { ext.vertexAttribDivisorANGLE(i, d); },
        draw: (m, f, c, n) => { ext.drawArraysInstancedANGLE(m, f, c, n); }
      };
      this.backend = 'webgl1';
    }
    if (!inst) inst = {
      divisor: (i, d) => { gl.vertexAttribDivisor(i, d); },
      draw: (m, f, c, n) => { gl.drawArraysInstanced(m, f, c, n); }
    };
    this.gl = gl; this.inst = inst;

    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    this.prog = p;
    this.uM = gl.getUniformLocation(p, 'uM');
    this.uT = gl.getUniformLocation(p, 'uT');
    gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);

    var loc = {
      corner: gl.getAttribLocation(p, 'aCorner'), rect: gl.getAttribLocation(p, 'aRect'),
      rot: gl.getAttribLocation(p, 'aRot'), uv: gl.getAttribLocation(p, 'aUV'), color: gl.getAttribLocation(p, 'aColor'),
      flash: gl.getAttribLocation(p, 'aFlash')
    };
    // static unit quad (triangle strip)
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.corner);
    gl.vertexAttribPointer(loc.corner, 2, gl.FLOAT, false, 0, 0);
    inst.divisor(loc.corner, 0);

    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
    this.iboSize = this.buf.byteLength;
    this.loc = loc;
    [loc.rect, loc.rot, loc.uv, loc.color, loc.flash].forEach((l) => { gl.enableVertexAttribArray(l); inst.divisor(l, 1); });
    this.bindInstances(this.ibo);
    // tiny separate buffer for the single background instance
    this.bgbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgbo);
    gl.bufferData(gl.ARRAY_BUFFER, BYTES, gl.DYNAMIC_DRAW);
    this.bgData = new Float32Array(FLOATS);
    this.bgU32 = new Uint32Array(this.bgData.buffer);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.textures = {};
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; if (this.onRestore) this.onRestore(); });
    return true;
  };

  /** Point the per-instance attributes at a buffer (instance layout is fixed). */
  R.bindInstances = function (buffer) {
    var gl = this.gl, loc = this.loc;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(loc.rect, 4, gl.FLOAT, false, BYTES, 0);
    gl.vertexAttribPointer(loc.rot, 1, gl.FLOAT, false, BYTES, 16);
    gl.vertexAttribPointer(loc.uv, 4, gl.FLOAT, false, BYTES, 20);
    gl.vertexAttribPointer(loc.color, 4, gl.UNSIGNED_BYTE, true, BYTES, 36);
    gl.vertexAttribPointer(loc.flash, 1, gl.FLOAT, false, BYTES, 40);
  };

  R.init2D = function () {
    this.backend = 'canvas2d';
    this.ctx = this.canvas.getContext('2d');
    this.textures = {};
  };

  /** Upload (or re-upload) a canvas as a named texture. */
  R.setTexture = function (name, source, smooth) {
    if (this.backend === 'canvas2d') { this.textures[name] = { src: source, w: source.width, h: source.height }; return; }
    var gl = this.gl;
    var t = this.textures[name] ? this.textures[name].tex : gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    var f = smooth === false ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures[name] = { tex: t, src: source, w: source.width, h: source.height };
  };

  R.resize = function (cssW, cssH, dpr) {
    var w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
  };

  // --------------------------------------------------------------- batching
  R.begin = function () { this.n = 0; };

  R.grow = function () {
    var nb = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(nb).set(new Uint8Array(this.buf));
    this.buf = nb; this.f32 = new Float32Array(nb); this.u32 = new Uint32Array(nb);
    this.cap *= 2;
  };

  /** Queue one sprite. f = atlas frame, colour = premultiplied rgba uint32,
   *  flash = 0..1 blend toward white (hit flash). */
  R.push = function (f, x, y, w, h, rot, color, flash) {
    if (this.n >= this.cap) this.grow();
    var i = this.n++ * FLOATS, d = this.f32;
    d[i] = x; d[i + 1] = y; d[i + 2] = w; d[i + 3] = h; d[i + 4] = rot;
    d[i + 5] = f.u0; d[i + 6] = f.v0; d[i + 7] = f.u1; d[i + 8] = f.v1;
    this.u32[i + 9] = color;
    d[i + 10] = flash || 0;
  };

  /** Health/progress bar in a single quad (shader draws fill + background). */
  R.bar = function (f, x, y, w, h, rot, frac, color) {
    this.push(f, x, y, w, h, rot, color, -1 - (frac < 0 ? 0 : frac > 1 ? 1 : frac));
  };

  /** Stretched sprite between two points (beams, arcs, bars). */
  R.line = function (f, x0, y0, x1, y1, thick, color) {
    var dx = x1 - x0, dy = y1 - y0;
    this.push(f, (x0 + x1) * 0.5, (y0 + y1) * 0.5, Math.sqrt(dx * dx + dy * dy), thick, Math.atan2(dy, dx), color);
  };

  /** Draw: background texture quad + the queued atlas batch. */
  R.flush = function (cam, bgName, atlasName, bgRect, clear) {
    if (this.backend === 'canvas2d') return this.flush2D(cam, bgName, atlasName, bgRect, clear);
    if (this.lost) return;
    var gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var kx = 2 * cam.zoom / this.cssW, ky = 2 * cam.zoom / this.cssH;
    if (cam.rot) {   // portrait: world +x points down the screen
      gl.uniform4f(this.uM, 0, -ky, -kx, 0);
      gl.uniform2f(this.uT, kx * cam.y, ky * cam.x);
    } else {
      gl.uniform4f(this.uM, kx, 0, 0, -ky);
      gl.uniform2f(this.uT, -cam.x * kx, cam.y * ky);
    }
    this.drawCalls = 0;
    if (bgName && this.textures[bgName]) {
      const b = this.bgData;
      b[0] = bgRect.x + bgRect.w / 2; b[1] = bgRect.y + bgRect.h / 2; b[2] = bgRect.w; b[3] = bgRect.h; b[4] = 0;
      b[5] = 0; b[6] = 0; b[7] = 1; b[8] = 1; b[10] = 0;
      this.bgU32[9] = 0xffffffff;
      this.bindInstances(this.bgbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[bgName].tex);
      this.inst.draw(gl.TRIANGLE_STRIP, 0, 4, 1);
      this.drawCalls++;
    }
    if (this.n > 0) {
      this.bindInstances(this.ibo);
      if (this.buf.byteLength > this.iboSize) { gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW); this.iboSize = this.buf.byteLength; }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32.subarray(0, this.n * FLOATS));
      gl.bindTexture(gl.TEXTURE_2D, this.textures[atlasName].tex);
      this.inst.draw(gl.TRIANGLE_STRIP, 0, 4, this.n);
      this.drawCalls++;
    }
  };

  // Canvas2D fallback: same instance stream, drawn with drawImage. Tints are
  // approximated by alpha; additive sprites (alpha 0) use 'lighter'.
  R.flush2D = function (cam, bgName, atlasName, bgRect, clear) {
    var c = this.ctx, dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = `rgb(${clear[0] * 255 | 0},${clear[1] * 255 | 0},${clear[2] * 255 | 0})`;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    var z = cam.zoom * dpr, W2 = this.cssW * dpr / 2, H2 = this.cssH * dpr / 2;
    // camera matrix [A C E; B D F] (device px)
    var A, B, C, D, E, F;
    if (cam.rot) { A = 0; B = z; C = -z; D = 0; E = W2 + cam.y * z; F = H2 - cam.x * z; }
    else { A = z; B = 0; C = 0; D = z; E = W2 - cam.x * z; F = H2 - cam.y * z; }
    var bg = this.textures[bgName];
    if (bg) { c.setTransform(A, B, C, D, E, F); c.drawImage(bg.src, bgRect.x, bgRect.y, bgRect.w, bgRect.h); }
    var at = this.textures[atlasName], img = at.src, AW = at.w, AH = at.h;
    var d = this.f32, u = this.u32, mode = 0;
    for (let k = 0; k < this.n; k++) {
      const i = k * FLOATS, col = u[i + 9];
      const a = col >>> 24, add = a === 0;
      const lum = add ? Math.max(col & 255, col >> 8 & 255, col >> 16 & 255) / 255 : a / 255;
      if (lum < 0.02) continue;
      if (add !== (mode === 1)) { mode = add ? 1 : 0; c.globalCompositeOperation = add ? 'lighter' : 'source-over'; }
      c.globalAlpha = lum;
      const x = d[i], y = d[i + 1], w = d[i + 2], h = d[i + 3], rot = d[i + 4];
      const cs = Math.cos(rot), sn = Math.sin(rot);
      c.setTransform(A * cs + C * sn, B * cs + D * sn, C * cs - A * sn, D * cs - B * sn, A * x + C * y + E, B * x + D * y + F);
      const su = d[i + 5] * AW, sv = d[i + 6] * AH, sw = d[i + 7] * AW - su, sh = d[i + 8] * AH - sv;
      if (d[i + 10] < -0.5) {   // health bar
        c.globalAlpha = 1;
        c.fillStyle = 'rgba(5,8,13,0.85)'; c.fillRect(-w / 2, -h / 2, w, h);
        c.fillStyle = `rgb(${col & 255},${col >> 8 & 255},${col >> 16 & 255})`;
        c.fillRect(-w / 2, -h / 2, w * (-d[i + 10] - 1), h);
        continue;
      }
      if (sw < 8 && sh < 8) {   // solid quads (bars, rects): honour the tint colour
        const ia = add ? 1 : 255 / a;
        c.fillStyle = `rgb(${(col & 255) * ia | 0},${(col >> 8 & 255) * ia | 0},${(col >> 16 & 255) * ia | 0})`;
        c.fillRect(-w / 2, -h / 2, w, h);
      } else c.drawImage(img, su, sv, sw, sh, -w / 2, -h / 2, w, h);
    }
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    this.drawCalls = this.n + 1;
  };
})();
