/* Bastion — DOM user interface (HUD, dock, panels, screens).
 * The HUD is plain DOM layered over the canvas. Values are diffed against a
 * cache and only written when they change, so the UI adds ~0 layout cost per
 * frame even while the game renders thousands of sprites. */
var TD = globalThis.TD || (globalThis.TD = {});
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  var fmt = TD.formatNum;

  function UI(game) {
    this.game = game;
    this.cache = {};
    this.icons = { tower: [], enemy: [] };
    this.toastTimer = 0;
    this.tpKey = '';
    this.wbKey = '';
    this.mapIndex = 0;
    this.diff = 'normal';
    this.perfOn = false;
  }
  TD.UI = UI;
  var U = UI.prototype;

  U.init = function (atlas) {
    var self = this, g = this.game;
    TD.TOWERS.forEach(function (t, i) {
      self.icons.tower[i] = atlas.icon(['tb_' + t.id, 'tt_' + t.id + '0'], 96, -Math.PI / 2);
      self.icons.tower[i + '_3'] = atlas.icon(['tb_' + t.id, 'tt_' + t.id + '3'], 96, -Math.PI / 2);
    });
    TD.ENEMIES.forEach(function (e, i) { self.icons.enemy[i] = atlas.icon(['e_' + e.id], 64, -Math.PI / 2); });

    // ---- palette
    var pal = $('palette');
    this.cards = TD.TOWERS.map(function (t, i) {
      var b = el('button', 'tcard');
      b.style.setProperty('--c', t.color);
      b.innerHTML = '<img alt="" src="' + self.icons.tower[i] + '"><span class="nm">' + t.name + '</span><span class="cost">' + t.cost + '</span><kbd>' + t.key + '</kbd>';
      b.setAttribute('aria-label', t.name + ', costs ' + t.cost);
      b.addEventListener('click', function () { g.unlockAudio(); g.selectTowerType(g.placing === i ? -1 : i); });
      b.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') self.showTip(i, b); });
      b.addEventListener('pointerleave', function () { self.hideTip(); });
      pal.appendChild(b);
      return b;
    });
    this.tip = el('div', 'panel hidden'); this.tip.id = 'tip';
    $('hud').appendChild(this.tip);

    // ---- top bar
    $('speedSeg').addEventListener('click', function (e) {
      var s = e.target.closest('button'); if (!s) return;
      g.setSpeed(+s.dataset.speed);
    });
    $('bPause').addEventListener('click', function () { g.togglePause(); });
    $('bSound').addEventListener('click', function () { g.toggleMute(); });
    $('bNext').addEventListener('click', function () { g.unlockAudio(); g.callWave(); });

    // ---- menu
    var ml = $('mapList');
    this.mapCards = TD.MAPS.map(function (m, i) {
      var b = el('button', 'map-card');
      var thumb = TD.renderBackground(TD.buildMap(m), 0.3).toDataURL('image/jpeg', 0.8);
      b.innerHTML = '<img alt="" src="' + thumb + '"><div class="mc-b"><div class="mc-n">' + m.name + '</div><div class="mc-t">' + m.tag + '</div><div class="mc-s"></div></div>';
      b.addEventListener('click', function () { self.mapIndex = i; self.refreshMenu(); g.sfx('click'); });
      ml.appendChild(b);
      return b;
    });
    var ds = $('diffSeg');
    Object.keys(TD.DIFFICULTY).forEach(function (k) {
      var b = el('button', '', TD.DIFFICULTY[k].name);
      b.dataset.diff = k;
      b.addEventListener('click', function () { self.diff = k; self.refreshMenu(); g.sfx('click'); });
      ds.appendChild(b);
    });
    $('bPlay').addEventListener('click', function () { g.unlockAudio(); g.newGame(self.mapIndex, self.diff, 'play'); });
    $('bDemo').addEventListener('click', function () { g.unlockAudio(); g.newGame(self.mapIndex, self.diff, 'demo'); });
    $('bStress').addEventListener('click', function () { g.unlockAudio(); g.newGame(0, 'normal', 'stress'); });
    $('bHelp').addEventListener('click', function () { self.show('scrHelp'); });
    $('bHelp2').addEventListener('click', function () { self.show('scrHelp'); });
    $('bHelpClose').addEventListener('click', function () { self.hide('scrHelp'); });
    $('bResume').addEventListener('click', function () { g.setPaused(false); });
    $('bRestart').addEventListener('click', function () { g.restart(); });
    $('bQuit').addEventListener('click', function () { g.quit(); });
    $('bAgain').addEventListener('click', function () { g.restart(); });
    $('bEndMenu').addEventListener('click', function () { g.quit(); });
    $('bBenchAgain').addEventListener('click', function () { self.hide('scrBench'); g.startBench(); });
    $('bBenchClose').addEventListener('click', function () { self.hide('scrBench'); });
    $('bBenchMenu').addEventListener('click', function () { g.quit(); });
    $('optPerf').addEventListener('change', function (e) { self.setPerf(e.target.checked); });
    $('optAuto').addEventListener('change', function (e) { g.setAutoStart(e.target.checked); });

    // ---- help codex
    var ht = $('helpTowers');
    TD.TOWERS.forEach(function (t, i) {
      ht.appendChild(el('div', 'ci', '<img alt="" src="' + self.icons.tower[i + '_3'] + '"><div><b>' + t.name + '</b> · ' + t.cost + ' cr<br>' + t.blurb + '</div>'));
    });
    var he = $('helpEnemies');
    TD.ENEMIES.forEach(function (e, i) {
      if (e.hidden) return;
      he.appendChild(el('div', 'ci', '<img alt="" src="' + self.icons.enemy[i] + '"><div><b>' + e.name + '</b><br>' + e.blurb + '</div>'));
    });

    this.refreshMenu();
  };

  // ------------------------------------------------------------ screens
  U.show = function (id) { $(id).classList.remove('hidden'); };
  U.hide = function (id) { $(id).classList.add('hidden'); };
  U.hideAll = function () { ['scrMenu', 'scrPause', 'scrEnd', 'scrHelp', 'scrBench'].forEach(this.hide); };

  U.refreshMenu = function () {
    var self = this;
    this.mapCards.forEach(function (c, i) {
      c.classList.toggle('on', i === self.mapIndex);
      var best = self.game.bestScore(i, self.diff);
      c.querySelector('.mc-s').textContent = best ? 'Best: ' + best.score.toLocaleString() + (best.won ? ' ★' : ' · wave ' + best.wave) : '';
    });
    Array.prototype.forEach.call($('diffSeg').children, function (b) { b.classList.toggle('on', b.dataset.diff === self.diff); });
  };

  U.enterGame = function (mode) {
    this.hideAll();
    $('hud').classList.remove('hidden');
    this.cache = {}; this.tpKey = ''; this.wbKey = '';
    var tag = $('mode-tag');
    tag.classList.toggle('hidden', mode === 'play');
    tag.textContent = mode === 'demo' ? 'AI demo — feel free to help' : mode === 'stress' ? 'Stress test' : '';
    $('palette').classList.toggle('hidden', mode === 'stress');
    $('waveBox').classList.toggle('hidden', mode === 'stress');
    this.setPerf(mode === 'stress' || this.perfOn);
    this.showSpeed(this.game.speed);
    this.hidePanel();
  };

  U.enterMenu = function () {
    this.hideAll();
    $('hud').classList.add('hidden');
    this.refreshMenu();
    this.show('scrMenu');
  };

  U.setPerf = function (on) {
    this.perfOn = on;
    $('optPerf').checked = on;
    $('perf').classList.toggle('hidden', !on);
  };

  U.showSpeed = function (s) {
    Array.prototype.forEach.call($('speedSeg').children, function (b) { b.classList.toggle('on', +b.dataset.speed === s); });
  };
  U.setMuted = function (m) { $('bSound').classList.toggle('muted', m); };

  U.showPause = function (on) { if (on) this.show('scrPause'); else this.hide('scrPause'); };

  U.showEnd = function (sim, won, best, isNewBest) {
    var t = $('endTitle');
    t.textContent = won ? 'Victory' : 'Base destroyed';
    t.className = 'small ' + (won ? 'win' : 'lose');
    $('endSub').textContent = won ? 'All fifty waves repelled on ' + sim.mapDef.name + ' (' + sim.diff.name + ').'
      : 'The line broke on wave ' + sim.wave + ' of ' + TD.TOTAL_WAVES + '.';
    var rows = [
      ['Score', '<span class="hl">' + sim.score.toLocaleString() + '</span>'],
      ['Best', (best ? best.score.toLocaleString() : '—') + (isNewBest ? ' <span class="ok">new!</span>' : '')],
      ['Waves cleared', sim.wavesCleared + ' / ' + TD.TOTAL_WAVES],
      ['Enemies destroyed', sim.kills.toLocaleString()],
      ['Lives remaining', '<span class="' + (sim.lives > 0 ? 'ok' : 'bad') + '">' + sim.lives + ' / ' + sim.maxLives + '</span>'],
      ['Towers standing', sim.towers.length],
      ['Time', formatTime(sim.time)]
    ];
    $('endStats').innerHTML = rows.map(function (r) { return '<span>' + r[0] + '</span><span>' + r[1] + '</span>'; }).join('');
    this.hidePanel();
    this.show('scrEnd');
  };

  U.showBench = function (res) {
    var pass = function (ok) { return ok ? ' <span class="ok">✓</span>' : ' <span class="bad">✗</span>'; };
    var rows = [
      ['Duration', res.seconds.toFixed(1) + ' s · ' + res.frames + ' frames'],
      ['Enemies / towers / projectiles', res.enemies + ' / ' + res.towers + ' / ' + res.projectiles],
      ['Average FPS', res.avgFps.toFixed(1)],
      ['Frames at ≥ 45 FPS', (res.pctAt45 * 100).toFixed(1) + '%' + pass(res.pctAt45 >= 0.95)],
      ['Frames > 33 ms', (res.pctOver33 * 100).toFixed(2) + '%' + pass(res.pctOver33 < 0.05)],
      ['Frame time p50 / p95 / p99', res.p50.toFixed(1) + ' / ' + res.p95.toFixed(1) + ' / ' + res.p99.toFixed(1) + ' ms'],
      ['CPU per frame avg / p95', res.cpuAvg.toFixed(2) + ' / ' + res.cpuP95.toFixed(2) + ' ms'],
      ['  · simulation', res.simAvg.toFixed(2) + ' ms (' + res.simPerTick.toFixed(2) + ' ms/tick × ' + res.ticksPerFrame.toFixed(2) + ')'],
      ['  · scene + draw', res.renderAvg.toFixed(2) + ' ms'],
      ['Renderer', res.backend + ' · ' + Math.round(res.renderScale * 100) + '% res'],
      ['JS heap', res.heap]
    ];
    $('benchStats').innerHTML = rows.map(function (r) { return '<span>' + r[0] + '</span><span>' + r[1] + '</span>'; }).join('');
    this.show('scrBench');
  };

  // ------------------------------------------------------------ toast/banner
  U.toast = function (msg, err) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () { t.className = ''; }, 1600);
  };

  U.banner = function (a, b, boss) {
    var e = $('banner');
    e.querySelector('.b1').textContent = a;
    e.querySelector('.b2').textContent = b || '';
    e.className = '';
    void e.offsetWidth;   // restart animation
    e.className = 'show' + (boss ? ' boss' : '');
  };

  U.flashStat = function (id, cls) {
    var e = $(id);
    e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls);
  };

  // ------------------------------------------------------------ tooltip
  U.showTip = function (i, anchor) {
    var t = TD.TOWERS[i], L = t.levels[0];
    var rows = [['Damage', L.dmg], ['Rate', L.rate + '/s'], ['Range', L.range]];
    if (L.splash) rows.push(['Splash', L.splash]);
    if (L.slow) rows.push(['Slow', Math.round(L.slow * 100) + '%']);
    if (L.chains) rows.push(['Chains', L.chains]);
    this.tip.innerHTML = '<h4 style="color:' + t.color + '">' + t.name + ' <span style="color:var(--gold);font-size:12px">' + t.cost + ' cr</span></h4><p>' + t.blurb + '</p>' +
      rows.map(function (r) { return '<div class="row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('');
    this.tip.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    this.tip.style.left = Math.max(8, Math.min(window.innerWidth - 258, r.left + r.width / 2 - 125)) + 'px';
    this.tip.style.top = (r.top - this.tip.offsetHeight - 10) + 'px';
  };
  U.hideTip = function () { this.tip.classList.add('hidden'); };

  // ------------------------------------------------------------ tower panel
  U.hidePanel = function () {
    $('towerPanel').classList.add('hidden');
    document.querySelector('.dock').classList.remove('has-sel');
    this.tpKey = '';
  };

  U.renderPanel = function (sim, t) {
    var g = this.game;
    var L = t.def.levels[t.level], N = t.def.levels[t.level + 1];
    var cost = N ? N.up : 0;
    var key = t.id + ':' + t.level + ':' + t.mode + ':' + (sim.gold >= cost) + ':' + t.kills + ':' + Math.floor(t.dmgDone / 100) + ':' + sim.sellValue(t);
    if (key === this.tpKey) return;
    var fresh = this.tpKey.split(':')[0] !== String(t.id);
    this.tpKey = key;
    var p = $('towerPanel');
    p.style.setProperty('--c', t.def.color);
    function row(k, a, b, fmtf) {
      fmtf = fmtf || function (v) { return v; };
      var nx = b != null && b !== a ? '→ ' + fmtf(b) : '';
      return '<span class="k">' + k + '</span><span class="v">' + fmtf(a) + '</span><span class="n">' + nx + '</span>';
    }
    var s = '';
    var kind = t.def.kind;
    s += row(kind === 'pulse' ? 'Damage / pulse' : 'Damage', L.dmg, N && N.dmg);
    s += row('Rate', L.rate, N && N.rate, function (v) { return v + '/s'; });
    s += row('Range', L.range, N && N.range);
    if (L.splash) s += row('Splash radius', L.splash, N && N.splash);
    if (L.slow) s += row('Slow', L.slow, N && N.slow, function (v) { return Math.round(v * 100) + '%'; });
    if (L.chains) s += row('Chain targets', L.chains, N && N.chains);
    if (kind === 'beam') s += row('Armour pierce', '100%');
    if (kind === 'chain') s += row('Armour pierce', '50%');
    var dps = kind === 'pulse' ? L.dmg * L.rate : L.dmg * L.rate;
    s += row('DPS (single)', Math.round(dps), N ? Math.round(N.dmg * N.rate) : null);

    var target = '';
    if (kind !== 'pulse') {
      target = '<div class="seg tp-target">' + TD.TARGET_MODES.map(function (m, i) {
        return '<button data-mode="' + i + '" class="' + (t.mode === i ? 'on' : '') + '">' + TD.TARGET_LABEL[m] + '</button>';
      }).join('') + '</div>';
    }
    var up = N ? '<button class="primary up"' + (sim.gold >= cost ? '' : ' disabled') + '>Upgrade <b>' + cost + '</b></button>'
      : '<button class="primary up max" disabled>Max level</button>';
    p.innerHTML =
      '<div class="tp-head"><img alt="" src="' + this.icons.tower[t.type + (t.level === 3 ? '_3' : '')] + '"><div><div class="tp-name">' + t.def.name +
      ' <span class="lvl">Lv ' + (t.level + 1) + '</span></div><div class="tp-sub">' + t.kills + ' kills · ' + fmt(t.dmgDone) + ' damage</div></div>' +
      '<button class="x" aria-label="Close">×</button></div>' +
      '<div class="tp-stats">' + s + '</div>' + target +
      '<div class="tp-actions">' + up + '<button class="danger sell">Sell ' + sim.sellValue(t) + '</button></div>';
    p.querySelector('.x').onclick = function () { g.selectTower(0); };
    var ub = p.querySelector('.up'); if (ub) ub.onclick = function () { g.upgradeSelected(); };
    p.querySelector('.sell').onclick = function () { g.sellSelected(); };
    var seg = p.querySelector('.tp-target');
    if (seg) seg.onclick = function (e) { var b = e.target.closest('button'); if (b) g.setTargetMode(+b.dataset.mode); };
    if (fresh) {
      p.classList.remove('hidden');
      document.querySelector('.dock').classList.add('has-sel');
    }
  };

  // ------------------------------------------------------------ per frame
  U.set = function (id, v) {
    if (this.cache[id] === v) return false;
    this.cache[id] = v;
    $(id).textContent = v;
    return true;
  };

  U.update = function (sim, game) {
    var c = this.cache;
    var gold = Math.floor(sim.gold);
    var prevGold = c.hGoldN;
    this.set('hGold', fmt(gold));
    if (prevGold != null && gold > prevGold + 20) this.flashStat('stGold', 'bump');
    c.hGoldN = gold;
    var lv = String(sim.lives);
    if (c.hLives != null && +lv < +c.hLives) this.flashStat('stLives', 'hurt');
    this.set('hLives', lv);
    this.set('hWave', String(sim.wave));
    this.set('hScore', sim.score.toLocaleString());

    // palette affordability / selection
    for (var i = 0; i < this.cards.length; i++) {
      var poor = gold < TD.TOWERS[i].cost, sel = game.placing === i;
      var k = (poor ? 1 : 0) + (sel ? 2 : 0);
      if (c['card' + i] !== k) {
        c['card' + i] = k;
        this.cards[i].classList.toggle('poor', poor);
        this.cards[i].classList.toggle('sel', sel);
      }
    }

    // tower panel
    var t = game.selected ? sim.towerById[game.selected] : null;
    if (t) this.renderPanel(sim, t);
    else if (this.tpKey) this.hidePanel();

    this.updateWaveBox(sim);
  };

  U.updateWaveBox = function (sim) {
    var next = sim.wave + 1;
    var can = sim.canCallWave();
    var final = sim.wave >= TD.TOTAL_WAVES;
    var cd = sim.countdown > 0 ? sim.countdown : 0;
    var bonus = 0;
    if (can && sim.wave > 0) {
      var frac = cd > 0 ? cd / TD.WAVE_COUNTDOWN : 1;
      bonus = Math.round(TD.earlyCallBonus(next) * frac);
    }
    var key = next + ':' + can + ':' + final + ':' + bonus + ':' + Math.ceil(cd);
    if (key !== this.wbKey) {
      var nk = this.wbKey.split(':')[0];
      this.wbKey = key;
      if (nk !== String(next)) {
        if (final) {
          $('wbTitle').textContent = 'Final wave';
          $('wbSub').textContent = '';
          $('wbList').innerHTML = '';
        } else {
          $('wbTitle').textContent = 'Wave ' + next;
          var boss = next % 10 === 0;
          var sub = $('wbSub');
          sub.textContent = boss ? 'BOSS' : next === TD.TOTAL_WAVES ? 'FINAL' : '';
          sub.className = boss ? 'boss' : '';
          var self = this;
          $('wbList').innerHTML = TD.waveSummary(next, sim.map.paths.length).map(function (g) {
            return '<span class="wb-item" title="' + TD.ENEMIES[g.type].name + '"><img alt="" src="' + self.icons.enemy[g.type] + '">' + g.count + '</span>';
          }).join('');
        }
      }
      var label = final ? (sim.state === 'running' ? 'Hold the line!' : '—')
        : sim.wave === 0 ? 'Start wave 1'
        : !can ? 'Incoming…'
        : cd > 0 ? 'Next wave · ' + Math.ceil(cd) + 's'
        : 'Call early';
      $('bNextLabel').textContent = label;
      $('bNextBonus').textContent = bonus > 0 ? '+' + bonus : '';
      $('bNext').disabled = !can;
    }
    var bar = cd > 0 ? (cd / TD.WAVE_COUNTDOWN * 100).toFixed(1) + '%' : '0%';
    if (this.cache.bar !== bar) { this.cache.bar = bar; $('bNextBar').style.width = bar; }
  };

  U.setPerfText = function (txt) { $('perf').firstChild ? ($('perf').firstChild.nodeValue = txt) : $('perf').appendChild(document.createTextNode(txt)); };

  function formatTime(s) {
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }
})();
