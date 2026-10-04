// Bastion perf telemetry dashboard. Plain browser JS, no dependencies.
// Reads perf/results.jsonl (one stress-matrix cell per line) and renders run cards,
// a pass/fail matrix, trend charts, a run-vs-run diff and the breaking point per throttle.
(() => {
  const DATA_URL = 'perf/results.jsonl';
  const DOC_URL = 'perf/OPTIMIZATIONS.md';
  const NOISE = 0.02; // relative changes below this are shown as neutral
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Hand-written one-liners for known steps. Unknown labels fall back to the
  // matching "## N · Title" heading in perf/OPTIMIZATIONS.md, then to a generic line.
  const DESCRIPTIONS = {
    '00-baseline': 'Starting point: linear target scans, unbounded sim catch-up per frame.',
    '01-target-cell-bounds': 'Targeting fuses query and scoring, culls out-of-range cells and bounds each cell by its cached best target.',
    '02-chain-nearest': 'Tesla chain jumps use a nearest-first cell walk with distance pruning.',
    '03-frame-budget': 'A per-frame time budget caps sim catch-up so frames fit a 60 Hz slot.',
    '04-sim-worker': 'The simulation runs in a Web Worker; the main thread only renders snapshots.',
    '04-noworker-http': 'Control run: the step 04 build with ?noworker, so the sim stays on the main thread.'
  };
  const SERIES_COLORS = { 1: 'var(--t1)', 4: 'var(--t4)', 6: 'var(--t6)', 20: 'var(--t20)' };
  const EXTRA_COLORS = ['#2fae7a', '#c99412']; // only used if new throttle levels appear

  const state = {
    rows: [],
    runs: [],
    throttles: [],
    speeds: [],
    docTitles: {},
    source: '',
    skipped: 0,
    sel: -1,
    colorBy: 'pass',
    diffA: -1,
    diffB: -1
  };

  const $ = (id) => document.getElementById(id);

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) setAttrs(el, attrs);
    append(el, kids);
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) setAttrs(el, attrs);
    append(el, kids);
    return el;
  }
  function setAttrs(el, attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  function append(el, kids) {
    for (const k of kids.flat()) {
      if (k === null || k === undefined || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const clear = (el) => {
    el.replaceChildren();
    return el;
  };

  // ---------- number helpers ----------
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const MINUS = '−';
  function fmt(v, d = 2) {
    if (!isNum(v)) return '—';
    return v.toFixed(d).replace('-', MINUS);
  }
  function fmtPct(r, d = 1) {
    if (!isNum(r)) return '—';
    const p = r * 100;
    if (Math.abs(p) < 0.05) return '±0%';
    return `${(p > 0 ? '+' : MINUS) + Math.abs(p).toFixed(d)}%`;
  }
  function fmtMs(v) {
    if (!isNum(v)) return '—';
    return v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
  }
  function geomean(vals) {
    const ok = vals.filter((v) => isNum(v) && v > 0);
    if (!ok.length) return null;
    return Math.exp(ok.reduce((a, v) => a + Math.log(v), 0) / ok.length);
  }
  // Tone for a relative change. lowerBetter: negative change is good.
  function tone(r, lowerBetter = true) {
    if (!isNum(r) || Math.abs(r) < NOISE) return 'flat';
    return r < 0 === lowerBetter ? 'good' : 'bad';
  }
  function toneAbs(diff, higherBetter = true) {
    if (!isNum(diff) || diff === 0) return 'flat';
    return diff > 0 === higherBetter ? 'good' : 'bad';
  }

  // ---------- data model ----------
  const key = (t, sp) => `${t}x${sp}`;

  function parseJsonl(text) {
    const rows = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (r && typeof r.label === 'string' && isNum(r.throttle) && isNum(r.speed)) rows.push(r);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { rows, skipped };
  }

  function passOf(r) {
    if (!r) return null;
    if (r.error) return false;
    if (typeof r.pass === 'boolean') return r.pass;
    return r.pctAt45 >= 0.95 && r.pctOver33 < 0.05 && r.simRate >= 0.98;
  }
  function failReasons(r) {
    if (!r || r.error) return [];
    const out = [];
    if (isNum(r.pctAt45) && r.pctAt45 < 0.95) out.push('fps');
    if (isNum(r.pctOver33) && r.pctOver33 >= 0.05) out.push('jank');
    if (isNum(r.simRate) && r.simRate < 0.98) out.push('speed');
    return out;
  }

  function buildRuns(rows) {
    const byLabel = new Map();
    rows.forEach((r, i) => {
      let run = byLabel.get(r.label);
      if (!run) {
        const m = /^(\d+)/.exec(r.label);
        run = { label: r.label, first: i, prefix: m ? Number(m[1]) : Number.POSITIVE_INFINITY, cells: new Map(), rows: [] };
        byLabel.set(r.label, run);
      }
      run.rows.push(r);
      run.cells.set(key(r.throttle, r.speed), r); // a re-run of the same cell replaces the old one
    });
    const runs = [...byLabel.values()].sort((a, b) => a.prefix - b.prefix || a.first - b.first);
    const seen = new Map();
    for (const run of runs) {
      const m = /^(\d+)/.exec(run.label);
      const base = m ? m[1] : run.label.slice(0, 3).toUpperCase();
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      run.code = n ? base + String.fromCharCode(97 + n) : base;
      const last = run.rows[run.rows.length - 1];
      run.sha = last.sha || '';
      run.ts = last.ts || '';
      run.gpu = last.gpu || '';
      run.dirty = run.rows.some((r) => r.dirty);
      run.worker = run.rows.some((r) => r.worker === true);
      run.errors = run.rows.filter((r) => r.error).length;
    }
    return runs;
  }

  function describe(run) {
    if (DESCRIPTIONS[run.label]) return DESCRIPTIONS[run.label];
    if (Number.isFinite(run.prefix) && state.docTitles[run.prefix]) return state.docTitles[run.prefix];
    return 'No description yet. Add a "## N · Title" section to perf/OPTIMIZATIONS.md.';
  }

  function parseDocTitles(md) {
    const out = {};
    for (const m of md.matchAll(/^##\s+(\d+)\s*[·.:-]\s*(.+)$/gm)) {
      out[Number(m[1])] = m[2].replace(/`/g, '').trim();
    }
    return out;
  }

  const cellVals = (run, field, keys) =>
    (keys || [...run.cells.keys()]).map((k) => run.cells.get(k)).filter((r) => r && !r.error).map((r) => r[field]);

  function runGeo(run, field) {
    return geomean(cellVals(run, field));
  }
  // Relative change from run a to run b, over the cells both runs measured.
  function geoChange(a, b, field) {
    if (!a || !b) return null;
    const keys = [...b.cells.keys()].filter((k) => {
      const ra = a.cells.get(k);
      const rb = b.cells.get(k);
      return ra && rb && !ra.error && !rb.error && ra[field] > 0 && rb[field] > 0;
    });
    if (!keys.length) return null;
    return geomean(cellVals(b, field, keys)) / geomean(cellVals(a, field, keys)) - 1;
  }
  const passCount = (run) => [...run.cells.values()].filter((r) => passOf(r)).length;
  function throttleGeo(run, t, field) {
    return geomean(state.speeds.map((sp) => run.cells.get(key(t, sp))).filter((r) => r && !r.error).map((r) => r[field]));
  }
  // True when the ladder stops at an unmeasured cell rather than a failure.
  function breakPending(run, t) {
    for (const sp of state.speeds) {
      const r = run.cells.get(key(t, sp));
      if (!r) return true;
      if (!passOf(r)) return false;
    }
    return false;
  }
  function breakSpeed(run, t) {
    let best = null;
    for (const sp of state.speeds) {
      const r = run.cells.get(key(t, sp));
      if (r && passOf(r)) best = sp;
      else break;
    }
    return best;
  }
  const throttleColor = (t, i) => SERIES_COLORS[t] || EXTRA_COLORS[i % EXTRA_COLORS.length];
  const totalCells = () => state.throttles.length * state.speeds.length;

  // ---------- icons ----------
  function statusIcon(kind) {
    if (kind === 'pass') {
      return s('svg', { class: 'st', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        s('path', { d: 'M3 8.5 6.5 12 13 4.5', fill: 'none', stroke: 'var(--good)', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    if (kind === 'err') {
      return s('svg', { class: 'st', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        s('path', { d: 'M8 2 15 14H1z', fill: 'none', stroke: 'var(--warn)', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }),
        s('path', { d: 'M8 6.5v3.5M8 12v.2', stroke: 'var(--warn)', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
    }
    return s('svg', { class: 'st', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      s('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'var(--bad)', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
  }

  // ---------- tooltip ----------
  const tip = {
    el: null,
    show(content, x, y) {
      const el = this.el;
      clear(el);
      append(el, [content]);
      el.hidden = false;
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x + 14;
      let top = y + 14;
      if (left + w > vw - 8) left = Math.max(8, x - w - 14);
      if (top + ht > vh - 8) top = Math.max(8, y - ht - 14);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    },
    showAt(content, target) {
      const r = target.getBoundingClientRect();
      this.show(content, r.left + r.width / 2, r.top + r.height / 2);
    },
    hide() {
      this.el.hidden = true;
    }
  };
  function bindTip(el, build) {
    el.addEventListener('pointermove', (e) => tip.show(build(), e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => tip.hide());
    el.addEventListener('focus', () => tip.showAt(build(), el));
    el.addEventListener('blur', () => tip.hide());
  }
  const kv = (k, v) => h('div', { class: 'row kv' }, h('span', { text: k }), h('b', { text: v }));

  // ---------- loading ----------
  async function loadFromUrl() {
    showNotice('loading', 'Loading telemetry', [h('p', {}, 'Fetching ', h('code', { text: DATA_URL }), '…')]);
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      ingest(text, DATA_URL);
    } catch (err) {
      showFetchError(err);
    }
  }
  async function loadDoc() {
    try {
      const res = await fetch(DOC_URL, { cache: 'no-store' });
      if (res.ok) state.docTitles = parseDocTitles(await res.text());
    } catch {
      // Descriptions are optional; the hardcoded map still applies.
    }
  }
  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => ingest(String(reader.result), file.name);
    reader.onerror = () => showNotice('error', 'Could not read file', [h('p', { text: `The browser could not read ${file.name}.` })]);
    reader.readAsText(file);
  }

  function ingest(text, source) {
    const { rows, skipped } = parseJsonl(text);
    state.rows = rows;
    state.skipped = skipped;
    state.source = source;
    if (!rows.length) {
      $('content').hidden = true;
      setSourceLine(false);
      showNotice('error', 'No benchmark rows yet', [
        h('p', {}, h('code', { text: source }), skipped ? ` has ${skipped} line(s) that are not valid result rows.` : ' is empty.'),
        h('p', {}, 'Run ', h('code', { text: 'node tools/stressmatrix.mjs --label=00-baseline' }), ' to append a matrix, then reload.'),
        fileButton()
      ]);
      return;
    }
    const prevLabels = state.runs.map((r) => r.label);
    state.runs = buildRuns(rows);
    state.throttles = [...new Set(rows.map((r) => r.throttle))].sort((a, b) => a - b);
    state.speeds = [...new Set(rows.map((r) => r.speed))].sort((a, b) => a - b);
    const n = state.runs.length;
    for (const run of state.runs) run.partial = run.cells.size < totalCells();
    // Default to the newest complete run; a matrix still being benchmarked is mostly empty.
    let latest = n - 1;
    while (latest > 0 && state.runs[latest].partial) latest--;
    if (state.runs[latest].partial) latest = n - 1;
    const prevSel = prevLabels[state.sel];
    const keepSel = prevSel ? state.runs.findIndex((r) => r.label === prevSel) : -1;
    state.sel = keepSel >= 0 ? keepSel : latest;
    state.diffA = 0;
    state.diffB = latest;
    hideNotice();
    $('content').hidden = false;
    setSourceLine(true);
    renderAll();
  }

  function setSourceLine(ok) {
    const el = clear($('sourceLine'));
    if (!ok) {
      append(el, [h('span', { class: 'dot off' }), 'No data loaded']);
      return;
    }
    const last = state.rows.reduce((m, r) => (r.ts && r.ts > m ? r.ts : m), '');
    const when = last ? new Date(last) : null;
    const stamp = when && !Number.isNaN(when.getTime()) ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    append(el, [
      h('span', { class: 'dot' }),
      h('b', { text: String(state.rows.length) }), ' rows · ',
      h('b', { text: String(state.runs.length) }), ' runs · last ', h('b', { text: stamp }),
      ' · ', h('code', { text: state.source }),
      state.skipped ? ` · ${state.skipped} skipped` : ''
    ]);
  }

  function fileButton() {
    return h('label', { class: 'btn', for: 'fileInput' }, 'Choose results.jsonl');
  }
  function showNotice(kind, title, body) {
    const el = clear($('notice'));
    el.className = `notice ${kind}`;
    append(el, [h('h3', { text: title }), body]);
    el.hidden = false;
  }
  function hideNotice() {
    $('notice').hidden = true;
  }
  function showFetchError(err) {
    const isFile = location.protocol === 'file:';
    $('content').hidden = true;
    setSourceLine(false);
    showNotice('error', isFile ? 'Opened from disk: fetch is blocked' : 'Could not load results', [
      isFile
        ? h('p', {}, 'Browsers block ', h('code', { text: 'fetch()' }), ' on file:// pages, so the dashboard cannot read ', h('code', { text: DATA_URL }), ' by itself.')
        : h('p', {}, h('code', { text: DATA_URL }), ` failed to load (${err?.message ? err.message : 'network error'}).`),
      h('p', {}, 'Drop ', h('code', { text: 'results.jsonl' }), ' anywhere on this page, or pick it below. To load it automatically, serve the repo, for example ', h('code', { text: 'python3 -m http.server' }), '.'),
      fileButton()
    ]);
  }

  // ---------- render ----------
  function renderAll() {
    renderCards();
    fillSelects();
    renderMatrix();
    renderCharts();
    renderTrendTable();
    renderDiff();
    renderBreaks();
  }

  function deltaSpan(r, lowerBetter, suffix) {
    return h('span', {}, h('span', { class: `d ${tone(r, lowerBetter)}`, text: fmtPct(r) }), ` ${suffix}`);
  }
  function countDelta(d, suffix) {
    const txt = !isNum(d) ? '—' : d === 0 ? '±0' : (d > 0 ? '+' : MINUS) + Math.abs(d);
    return h('span', {}, h('span', { class: `d ${toneAbs(d)}`, text: txt }), ` ${suffix}`);
  }

  function renderCards() {
    const wrap = clear($('cards'));
    const base = state.runs[0];
    state.runs.forEach((run, i) => {
      const prev = state.runs[i - 1];
      const pc = passCount(run);
      const sim = runGeo(run, 'simPerTick');
      const cpu = runGeo(run, 'cpuAvg');
      const pips = h('div', { class: 'pips', style: { gridTemplateColumns: `repeat(${state.speeds.length}, 9px)` }, 'aria-hidden': 'true' });
      for (const t of state.throttles) {
        for (const sp of state.speeds) {
          const r = run.cells.get(key(t, sp));
          pips.append(h('i', { class: `pip ${!r ? 'm' : r.error ? 'e' : passOf(r) ? 'p' : ''}` }));
        }
      }
      const badges = [];
      if (run.worker) badges.push(h('span', { class: 'badge acc', text: 'Sim worker' }));
      if (run.partial) badges.push(h('span', { class: 'badge warn', text: `Partial · ${run.cells.size}/${totalCells()} cells` }));
      if (run.errors) badges.push(h('span', { class: 'badge warn', text: `${run.errors} error${run.errors > 1 ? 's' : ''}` }));
      if (run.sha) badges.push(h('span', { class: 'badge', text: run.sha + (run.dirty ? '+' : '') }));

      const metric = (label, value, unit, field) =>
        h('div', { class: 'metric' },
          h('span', { class: 'k', text: label }),
          h('span', { class: 'v' }, value, h('small', { text: ` ${unit}` })),
          i > 0
            ? h('div', { class: 'deltas' }, deltaSpan(geoChange(base, run, field), true, 'base'), i > 1 ? deltaSpan(geoChange(prev, run, field), true, 'prev') : null)
            : h('div', { class: 'deltas' }, h('span', { text: 'reference run' })));

      const card = h('button', {
        type: 'button',
        class: `card panel${i === state.sel ? ' sel' : ''}`,
        'aria-pressed': String(i === state.sel),
        title: `Show ${run.label} in the matrix`,
        onclick: () => selectRun(i)
      },
        h('div', { class: 'card-head' },
          h('span', { class: 'code', text: run.code }),
          h('div', { class: 'card-title' }, h('b', { text: run.label }), h('p', { text: describe(run) }), badges.length ? h('div', { class: 'badges' }, badges) : null)),
        h('div', { class: 'card-body' },
          pips,
          h('div', {},
            h('div', { class: 'pass-big' }, String(pc), h('small', { text: ` / ${totalCells()}` })),
            h('div', { class: 'pass-lbl', text: run.partial ? `passing · ${run.cells.size} measured` : 'cells passing' }),
            i > 0 && !run.partial ? h('div', { class: 'deltas', style: { marginTop: '4px' } }, countDelta(pc - passCount(base), 'base'), i > 1 ? countDelta(pc - passCount(prev), 'prev') : null) : null)),
        h('div', { class: 'metrics' },
          metric('Sim / tick', fmtMs(sim), 'ms', 'simPerTick'),
          metric('Frame CPU', fmtMs(cpu), 'ms', 'cpuAvg')));
      wrap.append(card);
    });
  }

  function selectRun(i) {
    state.sel = i;
    $('runSelect').value = String(i);
    for (const [j, c] of [...$('cards').children].entries()) {
      c.classList.toggle('sel', j === i);
      c.setAttribute('aria-pressed', String(j === i));
    }
    renderMatrix();
    renderCharts();
  }

  function fillSelects() {
    for (const id of ['runSelect', 'diffA', 'diffB']) {
      const sel = clear($(id));
      state.runs.forEach((run, i) => {
        sel.append(h('option', { value: String(i), text: `${run.code} · ${run.label}` }));
      });
    }
    $('runSelect').value = String(state.sel);
    $('diffA').value = String(state.diffA);
    $('diffB').value = String(state.diffB);
  }

  // ----- matrix -----
  const FPS_RAMP = ['#0d1e2c', '#0f3550', '#125577', '#1a7fa8', '#4fd1ff'];
  const MS_RAMP = ['#1d1510', '#3d2215', '#6b3418', '#a74e20', '#ff8f5a'];
  function hexToRgb(hx) {
    const n = Number.parseInt(hx.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rampColor(ramp, t) {
    const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(x));
    const f = x - i;
    const a = hexToRgb(ramp[i]);
    const b = hexToRgb(ramp[i + 1]);
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
  }
  function msDomain() {
    const vals = state.rows.filter((r) => !r.error && r.simPerTick > 0).map((r) => r.simPerTick);
    if (!vals.length) return [0.1, 10];
    return [Math.min(...vals), Math.max(...vals)];
  }

  function cellTip(run, r, t, sp) {
    const head = h('h4', {}, `${t}× CPU · ${sp}× speed`, h('small', { text: `${run.code} · ${run.label}` }));
    if (!r) return h('div', {}, head, h('div', { class: 'row kv' }, h('span', { text: 'Not measured in this run' })));
    if (r.error) return h('div', {}, head, h('div', { class: 'errtxt', text: String(r.error) }));
    const p = passOf(r);
    const why = failReasons(r);
    return h('div', {},
      head,
      kv('Result', p ? 'PASS' : `FAIL${why.length ? ` (${why.join(', ')})` : ''}`),
      h('div', { class: 'sep' }),
      kv('Avg FPS', fmt(r.avgFps, 1)),
      kv('Frames ≥ 45 FPS', `${fmt(r.pctAt45 * 100, 1)}%`),
      kv('Frames > 33 ms', `${fmt(r.pctOver33 * 100, 1)}%`),
      kv('p50 / p95 / p99', `${fmt(r.p50, 1)} / ${fmt(r.p95, 1)} / ${fmt(r.p99, 1)} ms`),
      kv('Max frame', `${fmt(r.maxFrame, 1)} ms`),
      h('div', { class: 'sep' }),
      kv('Speed achieved', `${fmt(r.simRate * sp, 2)}× of ${sp}×`),
      kv('Sim ms / tick', fmtMs(r.simPerTick)),
      kv('Ticks / frame', fmt(r.ticksPerFrame, 2)),
      kv('Frame CPU avg / p95', `${fmtMs(r.cpuAvg)} / ${fmtMs(r.cpuP95)} ms`),
      kv('Sim / render', `${fmtMs(r.simAvg)} / ${fmtMs(r.renderAvg)} ms`),
      r.worker !== undefined ? kv('Sim thread', r.worker ? 'worker' : 'main') : null);
  }

  function renderMatrix() {
    const run = state.runs[state.sel];
    const m = clear($('matrix'));
    if (!run) return;
    const desc = clear($('runDesc'));
    append(desc, [h('b', { text: run.label }), ` · ${describe(run)}`]);
    m.style.gridTemplateColumns = `minmax(44px, auto) repeat(${state.speeds.length}, minmax(52px, 1fr))`;
    m.append(h('div', { class: 'mx-h corner', text: 'CPU \\ SPEED' }));
    for (const sp of state.speeds) m.append(h('div', { class: 'mx-h', text: `${sp}×` }));
    const [msLo, msHi] = msDomain();
    const msSpan = Math.log(msHi) - Math.log(msLo) || 1;
    const mode = state.colorBy;
    for (const t of state.throttles) {
      m.append(h('div', { class: 'mx-h row' }, `${t}×`, h('i', { text: 'CPU' })));
      for (const sp of state.speeds) {
        const r = run.cells.get(key(t, sp));
        let cell;
        if (!r) {
          cell = h('div', { class: 'cell missing', tabindex: '0', text: 'no data' });
        } else if (r.error) {
          cell = h('div', { class: 'cell err', tabindex: '0' }, statusIcon('err'), h('div', { class: 'fps', text: 'ERR' }), h('div', { class: 'spd', text: 'run failed' }));
        } else {
          const p = passOf(r);
          const cls = ['cell'];
          const style = {};
          if (mode === 'pass') cls.push(p ? 'pass' : 'fail');
          else {
            const tt = mode === 'fps' ? r.avgFps / 60 : (Math.log(r.simPerTick) - Math.log(msLo)) / msSpan;
            style.background = rampColor(mode === 'fps' ? FPS_RAMP : MS_RAMP, tt);
            style.borderColor = 'transparent';
            if (tt > 0.72) cls.push('ink-dark');
          }
          const main = mode === 'ms'
            ? h('div', { class: 'fps' }, fmtMs(r.simPerTick), h('small', { text: 'ms' }))
            : h('div', { class: 'fps' }, fmt(r.avgFps, 1), h('small', { text: 'fps' }));
          const why = !p && mode === 'pass' ? failReasons(r).join(' · ') : '';
          cell = h('div', { class: cls.join(' '), style, tabindex: '0' },
            statusIcon(p ? 'pass' : 'fail'),
            main,
            h('div', {},
              why ? h('div', { class: 'why', text: why }) : null,
              h('div', { class: 'spd' }, h('span', { class: 'arr', text: '→ ' }), `${fmt(r.simRate * sp, 2)}×`)));
        }
        cell.setAttribute('aria-label', `${t}× CPU, ${sp}× speed`);
        bindTip(cell, () => cellTip(run, r, t, sp));
        m.append(cell);
      }
    }
    renderLegend(msLo, msHi);
  }

  function renderLegend(msLo, msHi) {
    const el = clear($('matrixLegend'));
    const mode = state.colorBy;
    if (mode === 'pass') {
      append(el, [
        h('span', {}, h('i', { class: 'sw', style: { background: 'var(--good-bg)', borderColor: 'rgba(92,255,157,.5)' } }), 'Pass'),
        h('span', {}, h('i', { class: 'sw', style: { background: 'var(--bad-bg)', borderColor: 'rgba(255,93,108,.5)' } }), 'Fail: fps / jank / speed tags give the reason'),
        h('span', {}, h('i', { class: 'sw', style: { background: 'rgba(255,210,90,.08)', borderColor: 'rgba(255,210,90,.5)' } }), 'Error'),
        h('span', { text: 'Big number = avg FPS · → achieved game speed' })
      ]);
    } else {
      const ramp = mode === 'fps' ? FPS_RAMP : MS_RAMP;
      const lo = mode === 'fps' ? '0 fps' : `${fmtMs(msLo)} ms`;
      const hi = mode === 'fps' ? '60 fps' : `${fmtMs(msHi)} ms`;
      append(el, [
        h('span', { class: 'ramp' }, lo, h('i', { style: { background: `linear-gradient(90deg, ${ramp.join(',')})` } }), hi),
        h('span', { text: mode === 'ms' ? 'Log scale, fixed across all runs. Icons still mark pass and fail.' : 'Fixed 0–60 scale. Icons still mark pass and fail.' })
      ]);
    }
  }

  // ----- charts -----
  function niceLinearTicks(lo, hi, count = 5) {
    const span = hi - lo || 1;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= count) || mag * 10;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
      }
    }
    return out;
  }

  // series: [{ name, color, values[] (per run; null = missing), fmt }]
  function lineChart(container, opts) {
    const runs = state.runs;
    const W = Math.max(280, container.clientWidth || 600);
    const narrow = W < 460;
    const H = 240;
    const M = { t: 14, r: opts.endLabels ? (narrow ? 64 : 96) : 18, b: 30, l: 44 };
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;
    const all = opts.series.flatMap((se) => se.values).filter(isNum);
    let yLo;
    let yHi;
    if (opts.yDomain) [yLo, yHi] = opts.yDomain;
    else if (opts.log) {
      yLo = Math.min(...all) / 1.25;
      yHi = Math.max(...all) * 1.25;
    } else {
      yLo = 0;
      yHi = Math.max(...all) * 1.12 || 1;
    }
    const ticks = opts.log ? logTicks(yLo, yHi) : niceLinearTicks(yLo, yHi, 4);
    if (!opts.log && !opts.yDomain) yHi = Math.max(yHi, ticks[ticks.length - 1]);
    const y = opts.log
      ? (v) => M.t + ih - ((Math.log(v) - Math.log(yLo)) / (Math.log(yHi) - Math.log(yLo))) * ih
      : (v) => M.t + ih - ((v - yLo) / (yHi - yLo)) * ih;
    const n = runs.length;
    const x = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, tabindex: '0', role: 'img', 'aria-label': opts.aria });
    const ax = s('g', { class: 'ax' });
    for (const tv of ticks) {
      ax.append(s('line', { class: 'g', x1: M.l, x2: M.l + iw, y1: y(tv), y2: y(tv) }));
      ax.append(s('text', { x: M.l - 8, y: y(tv) + 3.5, 'text-anchor': 'end', text: opts.tickFmt ? opts.tickFmt(tv) : String(tv) }));
    }
    ax.append(s('line', { class: 'base', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 34))));
    runs.forEach((run, i) => {
      if (i % every && i !== n - 1) return;
      ax.append(s('text', { class: 'tick-x', x: x(i), y: H - 10, 'text-anchor': 'middle', text: run.partial ? `${run.code}*` : run.code }));
    });
    svg.append(ax);

    if (opts.ref) {
      svg.append(s('line', { class: 'ref', x1: M.l, x2: M.l + iw, y1: y(opts.ref.v), y2: y(opts.ref.v) }));
      svg.append(s('text', { class: 'ref-t', x: M.l + 4, y: y(opts.ref.v) - 5, text: opts.ref.label }));
    }

    const xhair = s('line', { class: 'xhair', y1: M.t, y2: M.t + ih, visibility: 'hidden' });
    svg.append(xhair);

    for (const se of opts.series) {
      // Solid path through complete runs; segments touching a partial run are faded.
      let d = '';
      let faded = '';
      se.values.forEach((v, i) => {
        if (!isNum(v) || i === 0 || !isNum(se.values[i - 1])) return;
        const seg = `M${x(i - 1).toFixed(1)},${y(se.values[i - 1]).toFixed(1)}L${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        if (runs[i].partial || runs[i - 1].partial) faded += seg;
        else d += seg;
      });
      const line = { fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      svg.append(s('path', { ...line, d }));
      if (faded) svg.append(s('path', { ...line, d: faded, 'stroke-opacity': 0.4 }));
      se.values.forEach((v, i) => {
        if (!isNum(v)) return;
        svg.append(runs[i].partial
          ? s('circle', { cx: x(i), cy: y(v), r: 3.5, fill: 'var(--panel)', stroke: se.color, 'stroke-width': 1.5 })
          : s('circle', { cx: x(i), cy: y(v), r: 4, fill: se.color, stroke: 'var(--panel)', 'stroke-width': 2 }));
      });
    }

    // Direct end labels with simple collision relaxation.
    if (opts.endLabels) {
      const labels = opts.series
        .map((se) => {
          let li = se.values.length - 1;
          while (li >= 0 && !isNum(se.values[li])) li--;
          if (li < 0) return null;
          return { se, y: y(se.values[li]), v: se.values[li], first: se.values.find(isNum) };
        })
        .filter(Boolean)
        .sort((a, b) => a.y - b.y);
      const gap = 13;
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < gap) labels[i].y = labels[i - 1].y + gap;
      const maxY = M.t + ih;
      for (let i = labels.length - 1; i >= 0; i--) {
        const lim = i === labels.length - 1 ? maxY : labels[i + 1].y - gap;
        if (labels[i].y > lim) labels[i].y = lim;
      }
      for (const lb of labels) {
        const t = s('text', { class: 'lbl-end', x: M.l + iw + 10, y: lb.y + 4 });
        t.append(s('tspan', { text: lb.se.name }));
        if (!narrow && opts.endSub) t.append(s('tspan', { class: 'sub', dx: 5, text: opts.endSub(lb) }));
        svg.append(s('line', { x1: M.l + iw + 2, x2: M.l + iw + 7, y1: lb.y, y2: lb.y, stroke: lb.se.color, 'stroke-width': 2 }));
        svg.append(t);
      }
    }

    // Hover layer: crosshair snaps to the nearest run.
    const hit = s('rect', { x: M.l - 10, y: 0, width: iw + 20, height: H, fill: 'transparent' });
    svg.append(hit);
    let cur = -1;
    const show = (i, cx, cy) => {
      cur = i;
      xhair.setAttribute('x1', x(i));
      xhair.setAttribute('x2', x(i));
      xhair.setAttribute('visibility', 'visible');
      tip.show(opts.tip(i), cx, cy);
    };
    const hide = () => {
      xhair.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const i = n === 1 ? 0 : Math.round(((px - M.l) / iw) * (n - 1));
      show(Math.max(0, Math.min(n - 1, i)), e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', hide);
    const kbShow = (i) => {
      const rect = svg.getBoundingClientRect();
      show(i, rect.left + (x(i) / W) * rect.width, rect.top + rect.height * 0.3);
    };
    svg.addEventListener('focus', () => kbShow(cur >= 0 ? cur : n - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      kbShow(Math.max(0, Math.min(n - 1, (cur < 0 ? n - 1 : cur) + (e.key === 'ArrowRight' ? 1 : -1))));
    });
    clear(container).append(svg);
  }

  function barChart(container, opts) {
    const runs = state.runs;
    const W = Math.max(280, container.clientWidth || 600);
    const H = 240;
    const M = { t: 18, r: 18, b: 30, l: 44 };
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;
    const max = opts.max;
    const ticks = niceLinearTicks(0, max, 4);
    const y = (v) => M.t + ih - (v / max) * ih;
    const n = runs.length;
    const band = iw / n;
    const bw = Math.min(36, band * 0.56);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': opts.aria });
    const ax = s('g', { class: 'ax' });
    for (const tv of ticks) {
      ax.append(s('line', { class: 'g', x1: M.l, x2: M.l + iw, y1: y(tv), y2: y(tv) }));
      ax.append(s('text', { x: M.l - 8, y: y(tv) + 3.5, 'text-anchor': 'end', text: String(tv) }));
    }
    svg.append(ax);
    runs.forEach((run, i) => {
      const v = opts.values[i];
      const cx = M.l + band * (i + 0.5);
      const top = y(v);
      const hgt = M.t + ih - top;
      const r = Math.min(4, hgt / 2, bw / 2);
      const x0 = cx - bw / 2;
      const d = hgt > 0
        ? `M${x0},${M.t + ih}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${M.t + ih}Z`
        : '';
      const g = s('g', { tabindex: '0', class: 'bar' });
      g.append(s('rect', { x: cx - band / 2, y: M.t, width: band, height: ih, fill: 'transparent' }));
      if (d) g.append(s('path', { d, fill: run.partial ? 'rgba(79, 209, 255, 0.22)' : i === state.sel ? 'var(--accent)' : 'rgba(79, 209, 255, 0.55)' }));
      g.append(s('text', { class: 'lbl-end', x: cx, y: top - 6, 'text-anchor': 'middle', text: String(v) }));
      g.append(s('text', { class: 'lbl', x: cx, y: H - 10, 'text-anchor': 'middle', text: run.partial ? `${run.code}*` : run.code }));
      bindTip(g, () => opts.tip(i));
      svg.append(g);
    });
    svg.append(s('line', { class: 'ax-base', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih, stroke: 'var(--line-strong)' }));
    clear(container).append(svg);
  }

  function runHead(i) {
    const run = state.runs[i];
    return h('h4', {}, `${run.code} · ${run.label}`,
      run.partial ? h('small', { class: 'partial', text: `Partial: ${run.cells.size} of ${totalCells()} cells measured` }) : null,
      h('small', { text: describe(run) }));
  }
  function seriesRow(color, value, name, deltas) {
    return h('div', { class: 'row' }, h('i', { class: 'key', style: { background: color } }), h('b', { text: value }), h('span', { class: 'dd' }, name, deltas ? ' ' : '', deltas || null));
  }
  function pctPair(series, i, lowerBetter = true) {
    const v = series[i];
    const b = series[0];
    const p = series[i - 1];
    if (!isNum(v) || i === 0) return null;
    const parts = [h('span', { class: `d ${tone(v / b - 1, lowerBetter)}`, text: fmtPct(v / b - 1) }), ' base'];
    if (i > 1 && isNum(p)) parts.push(' · ', h('span', { class: `d ${tone(v / p - 1, lowerBetter)}`, text: fmtPct(v / p - 1) }), ' prev');
    return h('span', {}, parts);
  }

  function chartData() {
    const thr = state.throttles.map((t, ti) => ({
      t,
      color: throttleColor(t, ti),
      sim: state.runs.map((run) => throttleGeo(run, t, 'simPerTick')),
      fps: state.runs.map((run) => {
        const r = run.cells.get(key(t, state.speeds[state.speeds.length - 1]));
        return r && !r.error ? r.avgFps : null;
      })
    }));
    const cpu = state.runs.map((run) => runGeo(run, 'cpuAvg'));
    const pass = state.runs.map(passCount);
    return { thr, cpu, pass };
  }

  function renderCharts() {
    const { thr, cpu, pass } = chartData();
    const top = state.speeds[state.speeds.length - 1];
    $('topSpeedCap').textContent = `${top}×`;
    $('passCap').textContent = `of ${totalCells()} cells`;
    const partial = state.runs.filter((r) => r.partial).map((r) => r.code);
    $('trendHint').textContent = `Hover or focus a chart and use ← → to step through runs.${
      partial.length ? ` * ${partial.join(', ')}: partial run, still being measured (hollow points).` : ''}`;

    lineChart($('chSim'), {
      aria: 'Sim milliseconds per tick across runs, one line per CPU throttle',
      log: true,
      tickFmt: (v) => (v < 1 ? String(v) : `${v}`),
      endLabels: true,
      series: thr.map((d) => ({ name: `${d.t}×`, color: d.color, values: d.sim })),
      endSub: (lb) => (isNum(lb.first) && lb.first > 0 ? fmtPct(lb.v / lb.first - 1, 0) : ''),
      tip: (i) =>
        h('div', {}, runHead(i), thr.map((d) => seriesRow(d.color, `${fmtMs(d.sim[i])} ms`, `${d.t}× CPU`, pctPair(d.sim, i))))
    });

    lineChart($('chCpu'), {
      aria: 'Frame CPU geomean across runs',
      endLabels: true,
      series: [{ name: `${fmtMs(cpu[cpu.length - 1])}ms`, color: 'var(--accent)', values: cpu }],
      endSub: (lb) => (isNum(lb.first) && lb.first > 0 ? fmtPct(lb.v / lb.first - 1, 0) : ''),
      tip: (i) => h('div', {}, runHead(i), seriesRow('var(--accent)', `${fmtMs(cpu[i])} ms`, 'frame CPU', pctPair(cpu, i)),
        state.runs[i].worker ? h('div', { class: 'row kv' }, h('span', { text: 'Main thread only: the sim runs in a worker.' })) : null)
    });

    barChart($('chPass'), {
      aria: 'Passing cells per run',
      max: totalCells(),
      values: pass,
      tip: (i) => {
        const d0 = pass[i] - pass[0];
        const dp = i > 0 ? pass[i] - pass[i - 1] : null;
        return h('div', {}, runHead(i), kv('Passing cells', `${pass[i]} / ${totalCells()}`),
          i > 0 ? kv('vs baseline', d0 === 0 ? '±0' : (d0 > 0 ? '+' : MINUS) + Math.abs(d0)) : null,
          i > 1 ? kv('vs previous', dp === 0 ? '±0' : (dp > 0 ? '+' : MINUS) + Math.abs(dp)) : null);
      }
    });

    lineChart($('chFps'), {
      aria: `Average FPS at ${top}× speed per CPU throttle`,
      yDomain: [0, 64],
      tickFmt: (v) => String(v),
      ref: { v: 45, label: '45 fps' },
      endLabels: true,
      series: thr.map((d) => ({ name: `${d.t}×`, color: d.color, values: d.fps })),
      endSub: (lb) => `${fmt(lb.v, 0)}`,
      tip: (i) => h('div', {}, runHead(i), thr.map((d) => seriesRow(d.color, `${fmt(d.fps[i], 1)} fps`, `${d.t}× CPU`, pctPair(d.fps, i, false))))
    });
  }

  function renderTrendTable() {
    const { thr, cpu, pass } = chartData();
    const top = state.speeds[state.speeds.length - 1];
    const t = clear($('trendTable'));
    t.append(h('thead', {}, h('tr', {},
      h('th', { text: 'Run' }),
      h('th', { text: 'Pass' }),
      h('th', { text: 'Frame CPU ms' }),
      thr.map((d) => h('th', { text: `ms/tick ${d.t}×` })),
      thr.map((d) => h('th', { text: `FPS ${d.t}×@${top}×` })))));
    const tb = h('tbody');
    state.runs.forEach((run, i) => {
      tb.append(h('tr', {},
        h('td', { class: 'cellname' }, `${run.code} `, h('i', { text: run.label })),
        h('td', { text: `${pass[i]}/${totalCells()}` }),
        h('td', { text: fmtMs(cpu[i]) }),
        thr.map((d) => h('td', { text: fmtMs(d.sim[i]) })),
        thr.map((d) => h('td', { text: fmt(d.fps[i], 1) }))));
    });
    t.append(tb);
  }

  // ----- diff -----
  function renderDiff() {
    const a = state.runs[state.diffA];
    const b = state.runs[state.diffB];
    const sum = clear($('diffSummary'));
    const t = clear($('diffTable'));
    if (!a || !b) return;
    let newlyPass = 0;
    let newlyFail = 0;
    for (const t2 of state.throttles) {
      for (const sp of state.speeds) {
        const pa = passOf(a.cells.get(key(t2, sp)));
        const pb = passOf(b.cells.get(key(t2, sp)));
        if (pa === false && pb === true) newlyPass++;
        if (pa === true && pb === false) newlyFail++;
      }
    }
    const pcA = passCount(a);
    const pcB = passCount(b);
    const simC = geoChange(a, b, 'simPerTick');
    const cpuC = geoChange(a, b, 'cpuAvg');
    const fpsC = geoChange(a, b, 'avgFps');
    const chip = (k, v, cls, sub) => h('div', { class: 'chip' }, h('div', { class: 'k', text: k }), h('div', { class: `v ${cls}`, text: v }), h('div', { class: 's', text: sub }));
    append(sum, [
      chip('Passing cells', `${pcA} → ${pcB}`, toneAbs(pcB - pcA), `${newlyPass} newly pass · ${newlyFail} newly fail`),
      chip('Sim ms / tick', fmtPct(simC), tone(simC), 'geomean, shared cells'),
      chip('Frame CPU', fmtPct(cpuC), tone(cpuC), 'geomean, shared cells'),
      chip('Avg FPS', fmtPct(fpsC), tone(fpsC, false), 'geomean, shared cells')
    ]);
    if (a === b) {
      sum.append(h('div', { class: 'chip' }, h('div', { class: 'k', text: 'Note' }), h('div', { class: 's', text: 'Both sides are the same run. Pick two different runs.' })));
    }

    t.append(h('thead', {}, h('tr', {},
      h('th', { text: 'Cell' }),
      h('th', { text: 'Pass' }),
      h('th', { text: 'Avg FPS' }),
      h('th', { text: 'Speed achieved' }),
      h('th', { text: 'Sim ms/tick' }),
      h('th', { text: 'Frame CPU ms' }),
      h('th', { text: 'p95 frame ms' }))));
    const tb = h('tbody');
    // value cell: B value, then "A → Δ" line. kind: 'rel' (relative %) or 'abs'
    const vcell = (va, vb, fmtv, lowerBetter, kind) => {
      if (!isNum(va) || !isNum(vb)) return h('td', { class: 'ab' }, h('b', { text: isNum(vb) ? fmtv(vb) : '—' }));
      let cls;
      let dtxt;
      if (kind === 'abs') {
        const dd = vb - va;
        const rel = va ? dd / va : dd;
        cls = tone(rel, lowerBetter);
        dtxt = Math.abs(dd) < 0.005 ? '±0' : (dd > 0 ? '+' : MINUS) + fmtv(Math.abs(dd));
      } else {
        const rel = vb / va - 1;
        cls = tone(rel, lowerBetter);
        dtxt = fmtPct(rel);
      }
      return h('td', { class: `ab ${cls !== 'flat' ? `c-${cls}` : ''}` },
        h('b', { text: fmtv(vb) }), ' ', h('span', { class: `d ${cls}`, text: dtxt }),
        h('div', { text: `was ${fmtv(va)}` }));
    };
    const passCell = (ra, rb) => {
      const pa = passOf(ra);
      const pb = passOf(rb);
      const icon = (ok) =>
        s('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          s('path', ok ? { d: 'M3 8.5 6.5 12 13 4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' } : { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
      if (pb === null) return h('td', { class: 'ab', text: 'no data' });
      if (pa === null) return h('td', {}, h('span', { class: 'pflag same' }, icon(pb), pb ? 'pass (new)' : 'fail (new)'));
      if (pa === pb) return h('td', {}, h('span', { class: 'pflag same' }, icon(pb), pb ? 'pass' : 'fail'));
      return h('td', { class: pb ? 'c-good' : 'c-bad' }, h('span', { class: `pflag ${pb ? 'good' : 'bad'}` }, icon(pb), pb ? 'now passes' : 'now fails'));
    };
    for (const t2 of state.throttles) {
      state.speeds.forEach((sp, si) => {
        const ra = a.cells.get(key(t2, sp));
        const rb = b.cells.get(key(t2, sp));
        const ok = (r) => r && !r.error;
        const g = (r, f) => (ok(r) ? r[f] : null);
        const spd = (r) => (ok(r) ? r.simRate * sp : null);
        const name = h('td', { class: 'cellname' }, `${t2}× `, h('i', { text: `CPU · ${sp}×` }));
        const tr = h('tr', { class: si === 0 ? 'grp' : '' },
          name,
          rb?.error ? h('td', { class: 'c-bad' }, h('span', { class: 'pflag bad', text: 'error' })) : passCell(ra, rb),
          vcell(g(ra, 'avgFps'), g(rb, 'avgFps'), (v) => fmt(v, 1), false, 'abs'),
          vcell(spd(ra), spd(rb), (v) => `${fmt(v, 2)}×`, false, 'abs'),
          vcell(g(ra, 'simPerTick'), g(rb, 'simPerTick'), fmtMs, true, 'rel'),
          vcell(g(ra, 'cpuAvg'), g(rb, 'cpuAvg'), fmtMs, true, 'rel'),
          vcell(g(ra, 'p95'), g(rb, 'p95'), (v) => fmt(v, 1), true, 'rel'));
        if (rb?.error) tr.title = String(rb.error);
        tb.append(tr);
      });
    }
    t.append(tb);
  }

  // ----- breaking point -----
  function renderBreaks() {
    const el = clear($('breaks'));
    const runs = state.runs;
    el.style.gridTemplateColumns = `minmax(84px, auto) repeat(${runs.length}, minmax(76px, 1fr))`;
    el.append(h('div', { class: 'br-h', style: { textAlign: 'left', paddingLeft: '0' }, text: 'CPU' }));
    runs.forEach((run) => {
      const hd = h('div', { class: 'br-h', tabindex: '0', text: run.code });
      bindTip(hd, () => h('div', {}, runHead(runs.indexOf(run))));
      el.append(hd);
    });
    state.throttles.forEach((t, ti) => {
      el.append(h('div', { class: 'br-h row' }, h('i', { class: 'key', style: { background: throttleColor(t, ti) } }), `${t}× throttle`));
      runs.forEach((run, i) => {
        const b = breakSpeed(run, t);
        const prevB = i > 0 ? breakSpeed(runs[i - 1], t) : undefined;
        const ladder = h('div', { class: 'ladder', 'aria-hidden': 'true' });
        state.speeds.forEach((sp, k) => {
          const r = run.cells.get(key(t, sp));
          const on = b !== null && sp <= b;
          const iso = !on && passOf(r);
          ladder.append(h('i', { class: on ? 'on' : iso ? 'iso' : '', style: { height: `${6 + k * 3}px` } }));
        });
        const pending = breakPending(run, t);
        let arrow = null;
        if (prevB !== undefined && !pending) {
          const cur = b ?? 0;
          const pv = prevB ?? 0;
          if (cur > pv) arrow = h('span', { class: 'up', text: '▲' });
          else if (cur < pv) arrow = h('span', { class: 'down', text: '▼' });
        }
        const val = pending
          ? h('div', { class: 'br-v pending', text: b === null ? 'PENDING' : `≥ ${b}×` })
          : b === null
            ? h('div', { class: 'br-v none' }, 'NONE', arrow)
            : h('div', { class: 'br-v' }, `${b}×`, arrow);
        const c = h('div', { class: 'br-c', tabindex: '0' }, ladder, val);
        c.setAttribute('aria-label', `${run.label}, ${t}× CPU: passes up to ${b === null ? 'no speed' : `${b}×`}`);
        bindTip(c, () => {
          const firstFail = state.speeds.find((sp) => !passOf(run.cells.get(key(t, sp))));
          const r = firstFail !== undefined ? run.cells.get(key(t, firstFail)) : null;
          return h('div', {},
            runHead(i),
            kv(`${t}× CPU passes up to`, b === null ? 'none' : `${b}×`),
            prevB !== undefined ? kv('Previous run', prevB === null ? 'none' : `${prevB}×`) : null,
            firstFail !== undefined
              ? kv(`First failure (${firstFail}×)`, !r ? 'no data' : r.error ? 'error' : `${fmt(r.avgFps, 1)} fps · ${fmt(r.simRate * firstFail, 2)}×`)
              : kv('First failure', 'none'));
        });
        el.append(c);
      });
    });
  }

  // ---------- wiring ----------
  function wire() {
    tip.el = $('tip');
    $('reloadBtn').addEventListener('click', () => {
      loadDoc().finally(loadFromUrl);
    });
    $('fileInput').addEventListener('change', (e) => {
      loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('runSelect').addEventListener('change', (e) => selectRun(Number(e.target.value)));
    $('colorBy').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      state.colorBy = btn.dataset.mode;
      for (const b of $('colorBy').querySelectorAll('button')) b.classList.toggle('on', b === btn);
      renderMatrix();
    });
    $('diffA').addEventListener('change', (e) => {
      state.diffA = Number(e.target.value);
      renderDiff();
    });
    $('diffB').addEventListener('change', (e) => {
      state.diffB = Number(e.target.value);
      renderDiff();
    });
    $('swapBtn').addEventListener('click', () => {
      [state.diffA, state.diffB] = [state.diffB, state.diffA];
      $('diffA').value = String(state.diffA);
      $('diffB').value = String(state.diffB);
      renderDiff();
    });

    // Drag and drop anywhere on the page.
    let depth = 0;
    const drop = $('drop');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      drop.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) drop.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      loadFile(e.dataTransfer.files[0]);
    });

    // Charts are drawn at their real pixel width; redraw when that changes.
    let lastW = 0;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      const w = $('chSim').clientWidth;
      if (!state.runs.length || w === lastW) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderCharts);
    });
    ro.observe($('chSim'));
    window.addEventListener('scroll', () => tip.hide(), { passive: true });
  }

  wire();
  loadDoc().finally(loadFromUrl);
})();
