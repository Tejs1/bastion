/* Bastion — static game data: towers, enemies, maps, difficulty, wave generator. */
var TD = globalThis.TD || (globalThis.TD = {});
(() => {
  'use strict';

  TD.TILE = 40;
  TD.COLS = 32;
  TD.ROWS = 18;
  TD.DT = 1 / 60;              // fixed simulation step (seconds)
  TD.TOTAL_WAVES = 50;

  // ---------------------------------------------------------------- towers
  // Each level lists absolute stats; `up` is the cost to reach that level.
  TD.TOWERS = [
    {
      id: 'blaster', name: 'Blaster', key: '1', cost: 50, color: '#4fd1ff',
      blurb: 'Rapid-fire bolts. Cheap, accurate, weak against armour.',
      kind: 'bullet', projSpeed: 760,
      levels: [
        { dmg: 8, rate: 3.2, range: 115 },
        { dmg: 13, rate: 3.7, range: 124, up: 45 },
        { dmg: 22, rate: 4.3, range: 134, up: 85 },
        { dmg: 36, rate: 5.4, range: 148, up: 160 }
      ]
    },
    {
      id: 'cannon', name: 'Mortar', key: '2', cost: 100, color: '#ffb14f',
      blurb: 'Lobs explosive shells. Splash damage shreds packed crowds.',
      kind: 'shell', projSpeed: 380,
      levels: [
        { dmg: 26, rate: 0.75, range: 130, splash: 44 },
        { dmg: 42, rate: 0.8, range: 136, splash: 48, up: 85 },
        { dmg: 68, rate: 0.86, range: 145, splash: 54, up: 150 },
        { dmg: 110, rate: 0.95, range: 156, splash: 62, up: 260 }
      ]
    },
    {
      id: 'frost', name: 'Cryo', key: '3', cost: 80, color: '#9ff3ff',
      blurb: 'Pulses freezing waves that slow everything nearby.',
      kind: 'pulse',
      levels: [
        { dmg: 2, rate: 0.9, range: 82, slow: 0.32, dur: 1.4 },
        { dmg: 5, rate: 0.95, range: 92, slow: 0.4, dur: 1.6, up: 65 },
        { dmg: 9, rate: 1.0, range: 102, slow: 0.47, dur: 1.8, up: 115 },
        { dmg: 16, rate: 1.1, range: 116, slow: 0.56, dur: 2.0, up: 200 }
      ]
    },
    {
      id: 'tesla', name: 'Tesla', key: '4', cost: 140, color: '#c38bff',
      blurb: 'Chain lightning arcs between enemies. Half-ignores armour.',
      kind: 'chain', pierce: 0.5, jump: 78,
      levels: [
        { dmg: 16, rate: 1.0, range: 108, chains: 3 },
        { dmg: 27, rate: 1.1, range: 114, chains: 4, up: 115 },
        { dmg: 45, rate: 1.2, range: 122, chains: 5, up: 200 },
        { dmg: 76, rate: 1.35, range: 132, chains: 7, up: 320 }
      ]
    },
    {
      id: 'rail', name: 'Railgun', key: '5', cost: 180, color: '#7dff9b',
      blurb: 'Long-range piercing beam. Ignores armour; hits every enemy in line.',
      kind: 'beam', pierce: 1,
      levels: [
        { dmg: 100, rate: 0.38, range: 220 },
        { dmg: 165, rate: 0.42, range: 238, up: 150 },
        { dmg: 275, rate: 0.47, range: 260, up: 260 },
        { dmg: 460, rate: 0.55, range: 290, up: 420 }
      ]
    }
  ];
  TD.TOWER_INDEX = {};
  TD.TOWERS.forEach((t, i) => { TD.TOWER_INDEX[t.id] = i; t.index = i; });

  TD.TARGET_MODES = ['first', 'last', 'strong', 'close'];
  TD.TARGET_LABEL = { first: 'First', last: 'Last', strong: 'Strong', close: 'Close' };

  // --------------------------------------------------------------- enemies
  // threat = budget cost used by the wave generator.
  TD.ENEMIES = [
    { id: 'grunt', name: 'Grunt', hp: 38, speed: 46, armor: 0, reward: 4, leak: 1, radius: 9, threat: 1,
      color: '#ff6b6b', blurb: 'Standard infantry. Nothing special — there are just a lot of them.' },
    { id: 'runner', name: 'Runner', hp: 22, speed: 92, armor: 0, reward: 4, leak: 1, radius: 7.5, threat: 0.9,
      color: '#ffe14f', blurb: 'Fast and fragile. Slip past slow-firing towers.' },
    { id: 'swarm', name: 'Swarmling', hp: 9, speed: 64, armor: 0, reward: 1, leak: 1, radius: 5, threat: 0.28,
      color: '#ff7ad9', blurb: 'Arrives in huge clouds. Splash and chain damage excel.' },
    { id: 'tank', name: 'Juggernaut', hp: 150, speed: 28, armor: 5, reward: 11, leak: 2, radius: 13, threat: 3.4,
      armorGrowth: 0.22, color: '#9aa7b8', blurb: 'Heavy armour blunts every hit. Use Tesla or Railgun.' },
    { id: 'healer', name: 'Mender', hp: 70, speed: 40, armor: 1, reward: 9, leak: 1, radius: 10, threat: 2.2,
      color: '#5cff9d', blurb: 'Periodically restores health to nearby enemies. Kill it first.' },
    { id: 'splitter', name: 'Splitter', hp: 85, speed: 42, armor: 2, reward: 7, leak: 2, radius: 11.5, threat: 2.7,
      color: '#ff9a3d', blurb: 'Bursts into three fast spawnlings when destroyed.' },
    { id: 'spawnling', name: 'Spawnling', hp: 20, speed: 78, armor: 0, reward: 1, leak: 1, radius: 6, threat: 0.5,
      color: '#ffc27a', blurb: 'Released by Splitters.', hidden: true },
    { id: 'boss', name: 'Behemoth', hp: 2400, speed: 22, armor: 6, reward: 140, leak: 6, radius: 22, threat: 60,
      armorGrowth: 0.2, slowResist: 0.5, color: '#ff3d6e', blurb: 'Colossal armoured boss. Summons swarmlings and shrugs off slows.' }
  ];
  TD.ENEMY_INDEX = {};
  TD.ENEMIES.forEach((e, i) => { TD.ENEMY_INDEX[e.id] = i; e.index = i; });
  var E = TD.ENEMY_INDEX;

  // ------------------------------------------------------------ difficulty
  TD.DIFFICULTY = {
    easy:   { name: 'Recruit', lives: 30, gold: 300, hp: 0.82, reward: 1.1 },
    normal: { name: 'Veteran', lives: 20, gold: 250, hp: 1.0, reward: 1.0 },
    hard:   { name: 'Warlord', lives: 12, gold: 230, hp: 1.15, reward: 0.92 }
  };

  // ------------------------------------------------------------------ maps
  // Waypoints are tile coordinates (cell centres). x = -1 means off-screen entry.
  TD.MAPS = [
    {
      id: 'crossroads', name: 'Crossroads', tag: 'Two fronts, one gate',
      seed: 11,
      paths: [
        [[-1, 2], [5, 2], [5, 7], [11, 7], [11, 3], [17, 3], [17, 9], [22, 9], [22, 14], [27, 14], [27, 5], [30, 5]],
        [[-1, 15], [6, 15], [6, 11], [14, 11], [14, 9], [17, 9], [22, 9], [22, 14], [27, 14], [27, 5], [30, 5]]
      ]
    },
    {
      id: 'serpent', name: 'Serpent Valley', tag: 'One long winding road',
      seed: 23,
      paths: [
        [[-1, 2], [27, 2], [27, 6], [4, 6], [4, 10], [27, 10], [27, 14], [8, 14], [8, 16], [30, 16]]
      ]
    }
  ];

  // ----------------------------------------------------------- wave curves
  /** Enemy hit-point multiplier for wave w (1-based). Grows ~quadratically. */
  TD.hpMult = (w) => {
    var x = w - 1;
    return 1 + 0.1 * x + 0.0115 * x * x;
  };
  TD.rewardMult = (w) => 1 + 0.012 * (w - 1);
  TD.waveClearBonus = (w) => 20 + 3 * w;
  TD.earlyCallBonus = (w) => 8 + Math.floor(w * 1.6);
  TD.WAVE_COUNTDOWN = 15; // seconds between waves before auto-start

  var UNLOCK = [
    [E.grunt, 1], [E.runner, 3], [E.swarm, 5], [E.tank, 7], [E.healer, 11], [E.splitter, 14]
  ];
  var GAP = []; // base spawn interval (s) per enemy type
  GAP[E.grunt] = 0.75; GAP[E.runner] = 0.5; GAP[E.swarm] = 0.13; GAP[E.tank] = 1.6;
  GAP[E.healer] = 1.4; GAP[E.splitter] = 1.3; GAP[E.boss] = 6; GAP[E.spawnling] = 0.3;

  /**
   * Build the definition of wave w: a list of spawn groups
   * { type, count, gap, delay, path (-1 = alternate), hp (extra multiplier) }.
   * Deterministic for a given (w, nPaths).
   */
  TD.buildWave = (w, _nPaths) => {
    var rng = new TD.RNG(9001 + w * 7919);
    var groups = [];
    var budget = 9 + 3.1 * w + 0.07 * w * w;
    var gapScale = Math.max(0.4, 1 - w * 0.011);
    var unlocked = [];
    for (var i = 0; i < UNLOCK.length; i++) if (UNLOCK[i][1] <= w) unlocked.push(UNLOCK[i][0]);
    var t = 0;

    function add(type, share, delay, hp) {
      var def = TD.ENEMIES[type];
      var count = Math.max(1, Math.round(budget * share / def.threat));
      groups.push({ type: type, count: count, gap: GAP[type] * gapScale, delay: delay, path: -1, hp: hp || 1 });
      return count * GAP[type] * gapScale;
    }

    if (w % 10 === 0) {
      // Boss wave: behemoth(s) + escorts.
      var bosses = w === 50 ? 1 : Math.max(1, w / 20 | 0);
      var bossHp = w === 50 ? 3.2 : w === 10 ? 0.6 : 1;
      groups.push({ type: E.boss, count: bosses, gap: 7, delay: 4, path: -1, hp: bossHp });
      budget *= 0.55;
      t = add(E.grunt, 0.4, 0);
      if (w >= 20) add(E.tank, 0.3, 6);
      if (w >= 30) add(E.healer, 0.15, 10);
      if (w >= 40) add(E.splitter, 0.2, 14);
      return groups;
    }

    // Introduction waves show off the new type on its own.
    for (i = 0; i < UNLOCK.length; i++) {
      if (UNLOCK[i][1] === w && w > 1) {
        add(UNLOCK[i][0], 0.65, 0);
        add(E.grunt, 0.35, 4);
        return groups;
      }
    }

    if (w === 25 || w === 37 || w === 48) {        // swarm floods
      add(E.swarm, 0.8, 0);
      add(E.runner, 0.2, 6);
      return groups;
    }
    if (w === 33 || w === 45) {                     // armoured column
      add(E.tank, 0.7, 0);
      add(E.healer, 0.3, 3);
      return groups;
    }
    if (w === 17 || w === 29 || w === 42) {         // runner rush
      add(E.runner, 0.75, 0);
      add(E.splitter, 0.25, 5);
      return groups;
    }

    // Regular wave: 2-3 mixed groups chosen by the seeded RNG.
    var nGroups = w < 4 ? 1 : (w < 15 ? 2 : 3);
    var picked = [];
    var shares = nGroups === 1 ? [1] : nGroups === 2 ? [0.6, 0.4] : [0.45, 0.33, 0.22];
    for (var g = 0; g < nGroups; g++) {
      var type;
      var guard = 0;
      do { type = unlocked[rng.int(0, unlocked.length - 1)]; } while (picked.indexOf(type) >= 0 && ++guard < 10);
      picked.push(type);
      var len = add(type, shares[g], t);
      t += Math.min(len * 0.6, 8) + rng.range(0.5, 2.5);
    }
    return groups;
  };

  /** Human-readable summary of a wave: [{type, count}] merged by type. */
  TD.waveSummary = (w, nPaths) => {
    var groups = TD.buildWave(w, nPaths);
    var map = {};
    var out = [];
    groups.forEach((g) => {
      if (map[g.type] == null) { map[g.type] = out.length; out.push({ type: g.type, count: 0 }); }
      out[map[g.type]].count += g.count;
    });
    return out;
  };
})();
