/* Bastion — tiny synthesized sound effects (WebAudio, no assets).
 * Each sound has a minimum re-trigger interval and there is a global voice
 * cap, so a 5,000-enemy firefight can't flood the audio graph. */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
  'use strict';

  var DEFS = {
    blaster: { gap: 0.05, vol: 0.05 },
    cannon: { gap: 0.09, vol: 0.18 },
    boom: { gap: 0.07, vol: 0.16 },
    zap: { gap: 0.07, vol: 0.09 },
    rail: { gap: 0.08, vol: 0.12 },
    frost: { gap: 0.12, vol: 0.08 },
    pop: { gap: 0.035, vol: 0.06 },
    bossdie: { gap: 0.5, vol: 0.4 },
    leak: { gap: 0.25, vol: 0.25 },
    build: { gap: 0.05, vol: 0.2 },
    upgrade: { gap: 0.05, vol: 0.22 },
    sell: { gap: 0.05, vol: 0.2 },
    wave: { gap: 0.5, vol: 0.25 },
    boss: { gap: 0.5, vol: 0.32 },
    clear: { gap: 0.5, vol: 0.18 },
    victory: { gap: 1, vol: 0.3 },
    defeat: { gap: 1, vol: 0.3 },
    click: { gap: 0.03, vol: 0.12 },
    error: { gap: 0.15, vol: 0.15 }
  };

  function Audio() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.7;
    this.last = {};
    this.voices = 0;
    this.maxVoices = 18;
  }
  TD.Audio = Audio;
  var A = Audio.prototype;

  /** Must be called from a user gesture. */
  A.unlock = function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (_e) { return; }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    var comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 6;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    var len = this.ctx.sampleRate * 0.6;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  };

  A.setMuted = function (m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  };

  A.play = function (name) {
    var c = this.ctx;
    if (!c || this.muted || c.state !== 'running') return;
    var def = DEFS[name];
    if (!def) return;
    var now = c.currentTime;
    if (this.last[name] && now - this.last[name] < def.gap) return;
    if (this.voices >= this.maxVoices) return;
    this.last[name] = now;
    this[`s_${name}`](c, now, def.vol);
  };

  // --------------------------------------------------------------- voices
  A.env = function (node, t, vol, attack, decay) {
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g); g.connect(this.master);
    this.voices++;
    setTimeout(() => { this.voices--; try { g.disconnect(); } catch (_e) { /* noop */ } }, (attack + decay) * 1000 + 50);
    return g;
  };
  A.osc = function (type, f0, f1, t, dur) {
    var o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  };
  A.noiseSrc = function (t, dur, filterType, freq, q) {
    var s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    var f = this.ctx.createBiquadFilter();
    f.type = filterType; f.frequency.setValueAtTime(freq, t); f.Q.value = q || 1;
    s.connect(f);
    s.start(t); s.stop(t + dur + 0.05);
    return f;
  };

  A.s_blaster = function (_c, t, v) { this.env(this.osc('square', 1400 + Math.random() * 200, 500, t, 0.07), t, v, 0.003, 0.07); };
  A.s_cannon = function (_c, t, v) {
    this.env(this.osc('sine', 160, 50, t, 0.25), t, v, 0.005, 0.25);
    this.env(this.noiseSrc(t, 0.15, 'lowpass', 900), t, v * 0.6, 0.003, 0.12);
  };
  A.s_boom = function (_c, t, v) {
    this.env(this.noiseSrc(t, 0.4, 'lowpass', 600 + Math.random() * 200), t, v, 0.005, 0.35);
    this.env(this.osc('sine', 90, 40, t, 0.3), t, v * 0.8, 0.005, 0.3);
  };
  A.s_zap = function (_c, t, v) {
    this.env(this.osc('sawtooth', 900 + Math.random() * 400, 1800, t, 0.1), t, v * 0.6, 0.002, 0.1);
    this.env(this.noiseSrc(t, 0.12, 'bandpass', 3000, 4), t, v, 0.002, 0.12);
  };
  A.s_rail = function (_c, t, v) {
    this.env(this.osc('sawtooth', 2200, 120, t, 0.3), t, v * 0.7, 0.002, 0.3);
    this.env(this.noiseSrc(t, 0.25, 'highpass', 2500), t, v * 0.5, 0.002, 0.2);
  };
  A.s_frost = function (_c, t, v) { this.env(this.noiseSrc(t, 0.35, 'bandpass', 5200, 6), t, v, 0.02, 0.3); };
  A.s_pop = function (_c, t, v) { this.env(this.osc('triangle', 520 + Math.random() * 300, 120, t, 0.08), t, v, 0.002, 0.08); };
  A.s_bossdie = function (_c, t, v) {
    this.env(this.noiseSrc(t, 1.4, 'lowpass', 400), t, v, 0.01, 1.3);
    this.env(this.osc('sine', 120, 30, t, 1.2), t, v, 0.01, 1.2);
  };
  A.s_leak = function (_c, t, v) {
    this.env(this.osc('square', 220, 110, t, 0.3), t, v * 0.6, 0.005, 0.3);
    this.env(this.osc('square', 233, 116, t, 0.3), t, v * 0.6, 0.005, 0.3);
  };
  A.chord = function (t, notes, type, v, step, dur) {
    for (let i = 0; i < notes.length; i++) {
      this.env(this.osc(type, notes[i], notes[i], t + i * step, dur), t + i * step, v, 0.01, dur);
    }
  };
  A.s_build = function (_c, t, v) { this.chord(t, [523, 784], 'triangle', v, 0.05, 0.12); };
  A.s_upgrade = function (_c, t, v) { this.chord(t, [523, 659, 784, 1046], 'triangle', v, 0.05, 0.14); };
  A.s_sell = function (_c, t, v) { this.chord(t, [784, 523], 'triangle', v, 0.06, 0.12); };
  A.s_click = function (_c, t, v) { this.env(this.osc('sine', 900, 700, t, 0.04), t, v, 0.002, 0.04); };
  A.s_error = function (_c, t, v) { this.env(this.osc('square', 180, 160, t, 0.15), t, v * 0.5, 0.005, 0.15); };
  A.s_wave = function (_c, t, v) { this.chord(t, [196, 294, 392], 'sawtooth', v * 0.4, 0.12, 0.45); };
  A.s_boss = function (_c, t, v) { this.chord(t, [98, 104, 98, 92], 'sawtooth', v * 0.5, 0.22, 0.5); };
  A.s_clear = function (_c, t, v) { this.chord(t, [659, 880], 'sine', v, 0.08, 0.25); };
  A.s_victory = function (_c, t, v) { this.chord(t, [523, 659, 784, 1046, 1318], 'triangle', v, 0.13, 0.6); };
  A.s_defeat = function (_c, t, v) { this.chord(t, [392, 330, 262, 196], 'sawtooth', v * 0.5, 0.22, 0.6); };
})();
