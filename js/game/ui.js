/* Bastion — DOM user interface (HUD, dock, panels, screens).
 * The HUD is plain DOM layered over the canvas. Values are diffed against a
 * cache and only written when they change, so the UI adds ~0 layout cost per
 * frame even while the game renders thousands of sprites. */
globalThis.TD = globalThis.TD || {};
var TD = globalThis.TD;
(() => {
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
    var g = this.game;
    TD.TOWERS.forEach((t, i) => {
      this.icons.tower[i] = atlas.icon([`tb_${t.id}`, `tt_${t.id}0`], 96, -Math.PI / 2);
      this.icons.tower[`${i}_3`] = atlas.icon([`tb_${t.id}`, `tt_${t.id}3`], 96, -Math.PI / 2);
    });
    TD.ENEMIES.forEach((e, i) => { this.icons.enemy[i] = atlas.icon([`e_${e.id}`], 64, -Math.PI / 2); });

    // ---- palette
    var pal = $('palette');
    this.cards = TD.TOWERS.map((t, i) => {
      var b = el('button', 'tcard');
      b.style.setProperty('--c', t.color);
      b.innerHTML = `<img alt="" src="${this.icons.tower[i]}"><span class="nm">${t.name}</span><span class="cost">${t.cost}</span><kbd>${t.key}</kbd>`;
      b.setAttribute('aria-label', `${t.name}, costs ${t.cost}`);
      b.addEventListener('click', () => { g.unlockAudio(); g.selectTowerType(g.placing === i ? -1 : i); });
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') this.showTip(i, b); });
      b.addEventListener('pointerleave', () => { this.hideTip(); });
      pal.appendChild(b);
      return b;
    });
    this.tip = el('div', 'panel hidden'); this.tip.id = 'tip';
    $('hud').appendChild(this.tip);

    // ---- top bar
    $('speedSeg').addEventListener('click', (e) => {
      var s = e.target.closest('button'); if (!s) return;
      g.setSpeed(+s.dataset.speed);
    });
    $('bPause').addEventListener('click', () => { g.togglePause(); });
    $('bSound').addEventListener('click', () => { g.toggleMute(); });
    $('bNext').addEventListener('click', () => { g.unlockAudio(); g.callWave(); });

    // ---- menu
    var ml = $('mapList');
    this.mapCards = TD.MAPS.map((m, i) => {
      var b = el('button', 'map-card');
      var thumb = TD.renderBackground(TD.buildMap(m), 0.3).toDataURL('image/jpeg', 0.8);
      b.innerHTML = `<img alt="" src="${thumb}"><div class="mc-b"><div class="mc-n">${m.name}</div><div class="mc-t">${m.tag}</div><div class="mc-s"></div></div>`;
      b.addEventListener('click', () => { this.mapIndex = i; this.refreshMenu(); g.sfx('click'); });
      ml.appendChild(b);
      return b;
    });
    var ds = $('diffSeg');
    Object.keys(TD.DIFFICULTY).forEach((k) => {
      var b = el('button', '', TD.DIFFICULTY[k].name);
      b.dataset.diff = k;
      b.addEventListener('click', () => { this.diff = k; this.refreshMenu(); g.sfx('click'); });
      ds.appendChild(b);
    });
    $('bPlay').addEventListener('click', () => { g.unlockAudio(); g.newGame(this.mapIndex, this.diff, 'play'); });
    $('bDemo').addEventListener('click', () => { g.unlockAudio(); g.newGame(this.mapIndex, this.diff, 'demo'); });
    $('bStress').addEventListener('click', () => { this.showStressSetup(); });
    ['stressSpeed', 'stressDur', 'stressSlow'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        var b = e.target.closest('button');
        if (!b) return;
        Array.prototype.forEach.call($(id).children, (c) => { c.classList.toggle('on', c === b); });
        g.sfx('click');
      });
    });
    $('bStressGo').addEventListener('click', () => {
      var pick = (id) => +$(id).querySelector('.on').dataset.v;
      g.unlockAudio();
      g.startStress({ speed: pick('stressSpeed'), dur: pick('stressDur'), slow: g.worker ? pick('stressSlow') : 1 });
    });
    $('bStressBack').addEventListener('click', () => { this.hide('scrStress'); this.show('scrMenu'); });
    $('bStopBench').addEventListener('click', () => { g.stopBench(); });
    $('bHelp').addEventListener('click', () => { this.show('scrHelp'); });
    $('bHelp2').addEventListener('click', () => { this.show('scrHelp'); });
    $('bHelpClose').addEventListener('click', () => { this.hide('scrHelp'); });
    $('bResume').addEventListener('click', () => { g.setPaused(false); });
    $('bRestart').addEventListener('click', () => { g.restart(); });
    $('bQuit').addEventListener('click', () => { g.quit(); });
    $('bAgain').addEventListener('click', () => { g.restart(); });
    $('bEndMenu').addEventListener('click', () => { g.quit(); });
    $('bBenchAgain').addEventListener('click', () => { this.hide('scrBench'); g.setPaused(false); g.startBench(); });
    $('bBenchClose').addEventListener('click', () => { this.hide('scrBench'); g.setPaused(false); });
    $('bBenchMenu').addEventListener('click', () => { g.quit(); });
    $('optPerf').addEventListener('change', (e) => { this.setPerf(e.target.checked); });
    $('optAuto').addEventListener('change', (e) => { g.setAutoStart(e.target.checked); });

    // ---- help codex
    var ht = $('helpTowers');
    TD.TOWERS.forEach((t, i) => {
      ht.appendChild(el('div', 'ci', `<img alt="" src="${this.icons.tower[`${i}_3`]}"><div><b>${t.name}</b> · ${t.cost} cr<br>${t.blurb}</div>`));
    });
    var he = $('helpEnemies');
    TD.ENEMIES.forEach((e, i) => {
      if (e.hidden) return;
      he.appendChild(el('div', 'ci', `<img alt="" src="${this.icons.enemy[i]}"><div><b>${e.name}</b><br>${e.blurb}</div>`));
    });

    this.refreshMenu();
  };

  // ------------------------------------------------------------ screens
  U.show = (id) => { $(id).classList.remove('hidden'); };
  U.hide = (id) => { $(id).classList.add('hidden'); };
  U.hideAll = function () { ['scrMenu', 'scrPause', 'scrEnd', 'scrHelp', 'scrBench', 'scrStress'].forEach(this.hide); };

  U.refreshMenu = function () {
    this.mapCards.forEach((c, i) => {
      c.classList.toggle('on', i === this.mapIndex);
      var best = this.game.bestScore(i, this.diff);
      c.querySelector('.mc-s').textContent = best ? `Best: ${best.score.toLocaleString()}${best.won ? ' ★' : ` · wave ${best.wave}`}` : '';
    });
    Array.prototype.forEach.call($('diffSeg').children, (b) => { b.classList.toggle('on', b.dataset.diff === this.diff); });
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
    this.setBenchRunning(false);
    this.hidePanel();
  };

  U.showStressSetup = function () {
    // the slow-CPU emulation lives in the sim worker; without one it has no effect
    $('stressSlowRow').classList.toggle('hidden', !this.game.worker);
    this.hide('scrMenu');
    this.show('scrStress');
  };

  U.setBenchRunning = (on) => { $('bStopBench').classList.toggle('hidden', !on); };

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

  U.showSpeed = (s) => {
    Array.prototype.forEach.call($('speedSeg').children, (b) => { b.classList.toggle('on', +b.dataset.speed === s); });
  };
  U.setMuted = (m) => { $('bSound').classList.toggle('muted', m); };

  U.showPause = function (on) { if (on) this.show('scrPause'); else this.hide('scrPause'); };

  U.showEnd = function (sim, won, best, isNewBest) {
    var t = $('endTitle');
    t.textContent = won ? 'Victory' : 'Base destroyed';
    t.className = `small ${won ? 'win' : 'lose'}`;
    $('endSub').textContent = won ? `All fifty waves repelled on ${sim.mapDef.name} (${sim.diff.name}).`
      : `The line broke on wave ${sim.wave} of ${TD.TOTAL_WAVES}.`;
    var rows = [
      ['Score', `<span class="hl">${sim.score.toLocaleString()}</span>`],
      ['Best', (best ? best.score.toLocaleString() : '—') + (isNewBest ? ' <span class="ok">new!</span>' : '')],
      ['Waves cleared', `${sim.wavesCleared} / ${TD.TOTAL_WAVES}`],
      ['Enemies destroyed', sim.kills.toLocaleString()],
      ['Lives remaining', `<span class="${sim.lives > 0 ? 'ok' : 'bad'}">${sim.lives} / ${sim.maxLives}</span>`],
      ['Towers standing', sim.towers.length],
      ['Time', formatTime(sim.time)]
    ];
    $('endStats').innerHTML = rows.map((r) => `<span>${r[0]}</span><span>${r[1]}</span>`).join('');
    this.hidePanel();
    this.show('scrEnd');
  };

  U.showBench = function (res) {
    if (!res.frames) {
      $('benchStats').innerHTML = '<span>Stopped during warm-up</span><span>no samples yet</span>';
      this.show('scrBench');
      return;
    }
    var pass = (ok) => ok ? ' <span class="ok">✓</span>' : ' <span class="bad">✗</span>';
    var early = res.stopped && res.planned !== Infinity ? ` · <span class="bad">stopped early</span> (of ${res.planned} s)` : '';
    var rows = [
      ['Duration', `${res.seconds.toFixed(1)} s · ${res.frames} frames${early}`],
      ['Enemies / towers / shots', `${res.enemies} / ${res.towers} / ${res.projectiles}`],
      ['Average FPS', res.avgFps.toFixed(1)],
      ['Game speed achieved', `${(res.simRate * res.speed).toFixed(2)}× of ${res.speed}×${pass(res.simRate >= 0.98)}`],
      ['Frames at ≥ 45 FPS', `${(res.pctAt45 * 100).toFixed(1)}%${pass(res.pctAt45 >= 0.95)}`],
      ['Frames at ≥ 55 FPS', `${(res.pctAt55 * 100).toFixed(1)}%`],
      ['Frames at 60 FPS', `${(res.pctAt60 * 100).toFixed(1)}%`],
      ['Frames > 33 ms', `${(res.pctOver33 * 100).toFixed(2)}%${pass(res.pctOver33 < 0.05)}`],
      ['Frame time p50 / p95 / p99', `${res.p50.toFixed(1)} / ${res.p95.toFixed(1)} / ${res.p99.toFixed(1)} ms`],
      ['CPU per frame avg / p95', `${res.cpuAvg.toFixed(2)} / ${res.cpuP95.toFixed(2)} ms`],
      ['<span class="sub">Simulation</span>', `${res.simAvg.toFixed(2)} ms (${res.simPerTick.toFixed(2)} ms/tick × ${res.ticksPerFrame.toFixed(2)})`],
      ['<span class="sub">Scene + draw</span>', `${res.renderAvg.toFixed(2)} ms`],
      ['Renderer', `${res.backend} · ${Math.round(res.renderScale * 100)}% res`],
      ['JS heap', res.heap]
    ];
    $('benchStats').innerHTML = rows.map((r) => `<span>${r[0]}</span><span>${r[1]}</span>`).join('');
    this.show('scrBench');
  };

  // ------------------------------------------------------------ toast/banner
  U.toast = function (msg, err) {
    var t = $('toast');
    t.textContent = msg;
    t.className = `show${err ? ' err' : ''}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.className = ''; }, 1600);
  };

  U.banner = (a, b, boss) => {
    var e = $('banner');
    e.querySelector('.b1').textContent = a;
    e.querySelector('.b2').textContent = b || '';
    e.className = '';
    void e.offsetWidth;   // restart animation
    e.className = `show${boss ? ' boss' : ''}`;
  };

  U.flashStat = (id, cls) => {
    var e = $(id);
    e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls);
  };

  // ------------------------------------------------------------ tooltip
  U.showTip = function (i, anchor) {
    var t = TD.TOWERS[i], L = t.levels[0];
    var rows = [['Damage', L.dmg], ['Rate', `${L.rate}/s`], ['Range', L.range]];
    if (L.splash) rows.push(['Splash', L.splash]);
    if (L.slow) rows.push(['Slow', `${Math.round(L.slow * 100)}%`]);
    if (L.chains) rows.push(['Chains', L.chains]);
    this.tip.innerHTML = '<h4 style="color:' + t.color + '">' + t.name + ' <span style="color:var(--gold);font-size:12px">' + t.cost + ' cr</span></h4><p>' + t.blurb + '</p>' +
      rows.map((r) => `<div class="row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
    this.tip.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    this.tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 258, r.left + r.width / 2 - 125))}px`;
    this.tip.style.top = `${r.top - this.tip.offsetHeight - 10}px`;
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
    var key = `${t.id}:${t.level}:${t.mode}:${sim.gold >= cost}:${t.kills}:${Math.floor(t.dmgDone / 100)}:${sim.sellValue(t)}`;
    if (key === this.tpKey) return;
    var fresh = this.tpKey.split(':')[0] !== String(t.id);
    this.tpKey = key;
    var p = $('towerPanel');
    p.style.setProperty('--c', t.def.color);
    function row(k, a, b, fmtf) {
      fmtf = fmtf || ((v) => v);
      var nx = b != null && b !== a ? `→ ${fmtf(b)}` : '';
      return `<span class="k">${k}</span><span class="v">${fmtf(a)}</span><span class="n">${nx}</span>`;
    }
    var s = '';
    var kind = t.def.kind;
    s += row(kind === 'pulse' ? 'Damage / pulse' : 'Damage', L.dmg, N?.dmg);
    s += row('Rate', L.rate, N?.rate, (v) => `${v}/s`);
    s += row('Range', L.range, N?.range);
    if (L.splash) s += row('Splash radius', L.splash, N?.splash);
    if (L.slow) s += row('Slow', L.slow, N?.slow, (v) => `${Math.round(v * 100)}%`);
    if (L.chains) s += row('Chain targets', L.chains, N?.chains);
    if (kind === 'beam') s += row('Armour pierce', '100%');
    if (kind === 'chain') s += row('Armour pierce', '50%');
    var dps = kind === 'pulse' ? L.dmg * L.rate : L.dmg * L.rate;
    s += row('DPS (single)', Math.round(dps), N ? Math.round(N.dmg * N.rate) : null);

    var target = '';
    if (kind !== 'pulse') {
      target = `<div class="seg tp-target">${TD.TARGET_MODES.map((m, i) => `<button data-mode="${i}" class="${t.mode === i ? 'on' : ''}">${TD.TARGET_LABEL[m]}</button>`).join('')}</div>`;
    }
    var up = N ? `<button class="primary up"${sim.gold >= cost ? '' : ' disabled'}>Upgrade <b>${cost}</b></button>`
      : '<button class="primary up max" disabled>Max level</button>';
    p.innerHTML =
      '<div class="tp-head"><img alt="" src="' + this.icons.tower[t.type + (t.level === 3 ? '_3' : '')] + '"><div><div class="tp-name">' + t.def.name +
      ' <span class="lvl">Lv ' + (t.level + 1) + '</span></div><div class="tp-sub">' + t.kills + ' kills · ' + fmt(t.dmgDone) + ' damage</div></div>' +
      '<button class="x" aria-label="Close">×</button></div>' +
      '<div class="tp-stats">' + s + '</div>' + target +
      '<div class="tp-actions">' + up + '<button class="danger sell">Sell ' + sim.sellValue(t) + '</button></div>';
    p.querySelector('.x').onclick = () => { g.selectTower(0); };
    var ub = p.querySelector('.up'); if (ub) ub.onclick = () => { g.upgradeSelected(); };
    p.querySelector('.sell').onclick = () => { g.sellSelected(); };
    var seg = p.querySelector('.tp-target');
    if (seg) seg.onclick = (e) => { var b = e.target.closest('button'); if (b) g.setTargetMode(+b.dataset.mode); };
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
    for (let i = 0; i < this.cards.length; i++) {
      const poor = gold < TD.TOWERS[i].cost, sel = game.placing === i;
      const k = (poor ? 1 : 0) + (sel ? 2 : 0);
      if (c[`card${i}`] !== k) {
        c[`card${i}`] = k;
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
      const frac = cd > 0 ? cd / TD.WAVE_COUNTDOWN : 1;
      bonus = Math.round(TD.earlyCallBonus(next) * frac);
    }
    var key = `${next}:${can}:${final}:${bonus}:${Math.ceil(cd)}`;
    if (key !== this.wbKey) {
      const nk = this.wbKey.split(':')[0];
      this.wbKey = key;
      if (nk !== String(next)) {
        if (final) {
          $('wbTitle').textContent = 'Final wave';
          $('wbSub').textContent = '';
          $('wbList').innerHTML = '';
        } else {
          $('wbTitle').textContent = `Wave ${next}`;
          const boss = next % 10 === 0;
          const sub = $('wbSub');
          sub.textContent = boss ? 'BOSS' : next === TD.TOTAL_WAVES ? 'FINAL' : '';
          sub.className = boss ? 'boss' : '';
          $('wbList').innerHTML = TD.waveSummary(next, sim.map.paths.length).map((g) => `<span class="wb-item" title="${TD.ENEMIES[g.type].name}"><img alt="" src="${this.icons.enemy[g.type]}">${g.count}</span>`).join('');
        }
      }
      const label = final ? (sim.state === 'running' ? 'Hold the line!' : '—')
        : sim.wave === 0 ? 'Start wave 1'
        : !can ? 'Incoming…'
        : cd > 0 ? `Next wave · ${Math.ceil(cd)}s`
        : 'Call early';
      $('bNextLabel').textContent = label;
      $('bNextBonus').textContent = bonus > 0 ? `+${bonus}` : '';
      $('bNext').disabled = !can;
    }
    var bar = cd > 0 ? `${(cd / TD.WAVE_COUNTDOWN * 100).toFixed(1)}%` : '0%';
    if (this.cache.bar !== bar) { this.cache.bar = bar; $('bNextBar').style.width = bar; }
  };

  U.setPerfText = (txt) => {
    if ($('perf').firstChild) $('perf').firstChild.nodeValue = txt;
    else $('perf').appendChild(document.createTextNode(txt));
  };

  function formatTime(s) {
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${m}:${ss < 10 ? '0' : ''}${ss}`;
  }
})();
