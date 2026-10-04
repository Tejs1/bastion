/* Bastion — pointer/touch/keyboard input. Converts raw events into game
 * intents (tap, hover, pan, zoom). Handlers run immediately on the event, so
 * the UI stays responsive regardless of simulation load. */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var DRAG_PX = 7;

  function Input(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.pointers = new Map();
    this.dragging = false;
    this.pinch = null;
    this.keys = {};

    canvas.addEventListener('pointerdown', (e) => { this.down(e); });
    canvas.addEventListener('pointermove', (e) => { this.move(e); });
    canvas.addEventListener('pointerup', (e) => { this.up(e); });
    canvas.addEventListener('pointercancel', (e) => { this.cancelPtr(e); });
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') game.hover(-1, -1); });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      game.zoomAt(e.offsetX, e.offsetY, Math.exp(-dy * 0.0015));
    }, { passive: false });
    window.addEventListener('keydown', (e) => { this.keydown(e); });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { this.keys = {}; });
  }
  TD.Input = Input;
  var I = Input.prototype;

  function pos(e, canvas) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  I.down = function (e) {
    this.game.unlockAudio();
    var p = pos(e, this.canvas);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType, button: e.button, t: performance.now() });
    if (this.pointers.size === 2) {
      const pts = Array.from(this.pointers.values());
      this.pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
      this.dragging = true;
    }
    if (e.pointerType === 'mouse' && e.button === 2) { this.game.cancel(); }
  };

  I.move = function (e) {
    var p = pos(e, this.canvas);
    var ptr = this.pointers.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType === 'mouse') this.game.hover(p.x, p.y);
      return;
    }
    var dx = p.x - ptr.x, dy = p.y - ptr.y;
    ptr.x = p.x; ptr.y = p.y;
    if (this.pinch && this.pointers.size >= 2) {
      const pts = Array.from(this.pointers.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      this.game.pan(cx - this.pinch.cx, cy - this.pinch.cy);
      if (this.pinch.d > 10) this.game.zoomAt(cx, cy, d / this.pinch.d);
      this.pinch.d = d; this.pinch.cx = cx; this.pinch.cy = cy;
      return;
    }
    if (!this.dragging && Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > DRAG_PX && ptr.button !== 2) {
      // touch-placing uses drag to move the ghost instead of panning
      if (ptr.type !== 'mouse' && this.game.isPlacing()) { this.game.hover(p.x, p.y); return; }
      this.dragging = true;
      this.canvas.classList.add('panning');
    }
    if (this.dragging) this.game.pan(dx, dy);
    else if (e.pointerType === 'mouse') this.game.hover(p.x, p.y);
    else if (this.game.isPlacing()) this.game.hover(p.x, p.y);
  };

  I.up = function (e) {
    var ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!ptr) return;
    var wasDrag = this.dragging;
    if (this.pointers.size === 0) { this.dragging = false; this.canvas.classList.remove('panning'); }
    if (wasDrag || ptr.button === 2) return;
    var p = pos(e, this.canvas);
    this.game.tap(p.x, p.y, ptr.type);
  };

  I.cancelPtr = function (e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) { this.dragging = false; this.canvas.classList.remove('panning'); }
  };

  I.keydown = function (e) {
    var g = this.game;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    this.keys[e.code] = true;
    if (e.repeat && !/^(Arrow|Key[WASD])/.test(e.code)) return;
    if (g.onKey(e)) e.preventDefault();
  };

  /** Continuous keyboard panning; called once per frame with real dt. */
  I.update = function (dt) {
    var k = this.keys, dx = 0, dy = 0, sp = 600 * dt;
    if (k.KeyA || k.ArrowLeft) dx += sp;
    if (k.KeyD || k.ArrowRight) dx -= sp;
    if (k.KeyW || k.ArrowUp) dy += sp;
    if (k.KeyS || k.ArrowDown) dy -= sp;
    if (dx || dy) this.game.pan(dx, dy);
  };
})();
