# Bastion

A browser tower defense game. You hold a core against 50 waves of enemies on two maps and three difficulties. It is plain JavaScript with no dependencies and no build step, and it never touches the network.

**Run it:** run `npm start` and go to <http://localhost:8080>. The simulation then runs in a Web Worker. You can also open the single-file build `dist/bastion.html` directly, which embeds the worker.
Opening `index.html` from `file://` also works, but the sim then runs on the main thread, because browsers block worker scripts on `file://`.
The performance dashboard is at <http://localhost:8080/analytics>.

![Battle](docs/battle.png)

## The game

| | |
|---|---|
| **Towers (5)** | **Blaster**: cheap and fast-firing, but weak against armour. **Mortar**: splash shells. **Cryo**: area slow pulse. **Tesla**: chain lightning that ignores half of armour. **Railgun**: a long piercing beam that ignores all armour. Each tower has 4 levels and 4 targeting modes (first, last, strong, close). Selling refunds 70%, or 100% within 3 seconds of building. |
| **Enemies (7 + spawnling)** | **Grunt**. **Runner** (fast). **Swarmling** (comes in large clouds). **Juggernaut** (armour that grows each wave). **Mender** (heals nearby enemies). **Splitter** (breaks into 3 spawnlings). **Behemoth** boss on waves 10/20/30/40/50, which resists slows and summons swarms. |
| **Waves** | 50 waves from a seeded generator. Enemy HP grows roughly quadratically, wave budgets grow, and new enemy types appear on waves 3, 5, 7, 11 and 14. There are themed waves (swarm floods, armoured columns, runner rushes) and a boss every 10th wave. Calling a wave early pays bonus credits. |
| **State** | Lives, credits, score (kills, wave clears and a victory bonus), best score per map and difficulty, and victory and defeat screens. |
| **Controls** | Pause, restart, and speeds 1×/2×/4×/8×/12×. Pan and zoom with mouse, touch (pinch) or keyboard. `1–5` build, `U` upgrade, `X` sell, `T` targeting, `N` next wave, `Space` pause, `F` speed, `` ` `` performance overlay. Touch uses tap-to-preview, then tap to confirm. On portrait phones the camera turns 90° so the map fills the screen. |
| **Extras** | AI demo mode (the bot plays, and you can help). Built-in **Stress test** with a results screen. Synthesized WebAudio sound effects. |

Balance was tuned with a headless bot over every map and difficulty (`npm run balance`). On Veteran, a competent build with upgrades and mixed towers wins, often losing lives on the final boss. Builds with no upgrades lose around wave 20, and a Blaster-only build loses in the 40s. Warlord is tight even for the bot.

## Architecture

```
js/core/      DOM-free; runs unchanged in Node for tests
  util.js     namespace, seeded RNG (mulberry32), colour packing
  data.js     tower/enemy/difficulty/map tables, HP curves, wave generator
  map.js      tile grid + smoothed paths sampled into lookup tables
  sim.js      the simulation (fixed 60 Hz step)
  bot.js      autoplay AI (demo mode, balance tests, long-run test)
  stress.js   fixed-step loop driver + the stress scenario
  snapshot.js worker <-> main-thread snapshot format, fx event recorder, SimView
js/sim-worker.js  the simulation worker (authoritative Sim + bot)
js/render/    atlas.js (procedural sprites), background.js, renderer.js (WebGL batcher), scene.js
js/game/      fx.js (particles etc.), audio.js, input.js, ui.js (DOM HUD), main.js (loop, camera, modes)
tools/        headless.mjs, bench.mjs, longrun.mjs, smoke.mjs, build.mjs,
              stressmatrix.mjs, profile.mjs, simbench.mjs, scenebench.mjs, perfdiff.mjs
analytics.html  /analytics: dashboard over perf/results.jsonl
perf/           OPTIMIZATIONS.md (step-by-step log), results.jsonl, runs/, profiles/
```

* **Two threads.** The simulation runs in a **Web Worker**, and the main thread only renders and handles input.
  * Data flow:
    * After each batch of ticks, the worker packs enemy, projectile and tower render state, plus the fx and sound events the sim emitted, into one transferable `ArrayBuffer` (`snapshot.js`).
    * Two buffers ping-pong, and the main thread hands one back each rendered frame.
    * A `SimView` gives the scene and HUD the same field names as `Sim`.
  * Player commands:
    * They are checked locally with `Sim`'s rules, applied optimistically, and posted to the worker, which stays authoritative.
  * Fallbacks:
    * Opened from `file://` (browsers block worker scripts there) or with `?noworker`, the sim runs on the main thread.
    * The single-file `dist/bastion.html` embeds the worker and starts it as a Blob worker.

* **Fixed-step loop.** There are no per-entity timers.
  * Elapsed real time × game speed feeds an accumulator (`FixedLoop`), which steps the sim in fixed `1/60 s` ticks.
  * Each batch has a **wall-clock budget**: 12 ms in the worker, or `13 ms − render cost` on the main thread.
  * If the CPU can't keep up, the backlog is dropped. The game then runs slower instead of the frame rate collapsing. Rendering interpolates enemy and projectile positions between the last two ticks (`alpha`), so motion stays smooth at 30, 60, 144 or 240 Hz.
* **Deterministic sim.** All gameplay randomness comes from a seeded RNG. Player and bot commands apply between ticks. `headless.mjs determinism` drives the same game through the browser's loop code at 30, 60, 144 and 240 Hz and at 60 and 75 Hz with ±60% / ±30% frame jitter. The state hash is identical at every checkpoint, so behaviour does not depend on refresh rate.
* **Data-oriented state.** Enemies and projectiles live in preallocated typed arrays (structure of arrays):
  * Enemies use stable slots, a free-list stack and a dense active list with O(1) swap-remove. Uids guard against reused slots.
  * Projectiles use dense arrays with swap-remove.
  * Towers (at most one per tile) are plain objects.
* **Spatial hash.** A uniform 40 px grid is rebuilt every tick with a counting sort, which is O(n), allocation-free and leaves each cell's enemies contiguous.
  * Every range query uses it: tower targeting, splash, chain jumps, rail lines, healer pulses and render culling.
  * **Target search** skips cells outside the range circle.
  * It also keeps a per-cell cached best enemy for first, last and strong targeting, used as an upper bound:
    * a cell is skipped when it can't win
    * its cached best is taken directly when it is in range
  * **Chain jumps** search the nearest cell first, with distance pruning.
  * Both return exactly what a linear scan would.
* **Paths.** Waypoints are corner-rounded and resampled every 2 px into position, tangent and angle tables. Moving an enemy is `dist += speed·dt` plus one table lookup, and a per-enemy lateral offset spreads crowds across the lane.
* **Sim ↔ presentation.** The sim emits side effects through an `fx` hook object (`death`, `explosion`, `arc`, …). In Node it is a no-op, and in the browser it feeds particles and sound. The DOM HUD reads sim state, caches every value and only touches the DOM when a value changes.

## Rendering approach

* **WebGL2 instanced sprite batcher**, falling back to WebGL1 + `ANGLE_instanced_arrays`, then to Canvas2D. Each sprite is one instance of 11 floats (`x y w h rot u0 v0 u1 v1 rgba flash`) in one interleaved buffer, uploaded with a single `bufferSubData`.
* **Two draw calls per frame:** one textured quad for the pre-rendered map background, and one instanced call for every other sprite.
* **One texture.** All sprites (enemies, tower bases and 4 turret levels each, projectiles, particles, glyphs for floating numbers) are drawn procedurally with Canvas2D at start-up into a 2048² atlas. UI icons and map thumbnails are made from the same atlas.
* **No blend-state switches.** Colours are premultiplied, so a tint with alpha 0 blends *additively* in the same pass (glows, beams, sparks), and painter's order is kept without sorting or state changes.
* **Shader tricks that save quads.** A hit flash is a per-instance `flash` value that mixes the texel toward white (no white-silhouette overlay sprite). A health bar is a single quad: a negative `flash` encodes the fill fraction, and the fragment shader draws fill plus background.
* **Culling.** Enemies are visited only through spatial-grid cells that overlap the camera rectangle. Projectiles, towers and particles are bounds-checked before queueing. Off-screen objects add no GPU work and almost no CPU work.
* **Dynamic resolution.** If frames run long while CPU work is a small share of the frame (GPU-bound), the backing resolution drops in 10% steps to 50%. It recovers when there is headroom. If a step doesn't help (for example a browser capping frames at 30 Hz), it reverts and stops.
* **Effects** use fixed-size ring buffers (6 144 particles, 640 beams/arcs, 320 rings, 96 decals, 96 popups) plus a per-frame emission budget. An effect storm overwrites the oldest effects and never grows memory.
  * **Adaptive effects quality** is the CPU counterpart of dynamic resolution.
  * When smoothed render CPU passes 10 ms, the particle budget scales down to 20% and Tesla arcs drop their second line.
  * The sim is unaffected, and on normal hardware the quality stays at 100%.
* **Scene builder** has one small method per hot section: enemies, health bars, projectiles, beams and particles. V8 optimised the original single ~250-line `build()` poorly.

## GPU or CPU? Which browser APIs the game uses

| Work | API | Runs on |
|---|---|---|
| Drawing the game: about 16 k sprites in **2 draw calls** per frame | **WebGL2** (`drawArraysInstanced`, `bufferSubData`), falling back to WebGL1 + `ANGLE_instanced_arrays`, then Canvas2D | **GPU**. On macOS, Chrome translates WebGL to Metal through ANGLE. |
| Hit flash, single-quad health bars, additive blending in the same pass | GLSL vertex and fragment shaders | **GPU** |
| Simulation: movement, targeting, damage, waves, bot | Plain JS on typed arrays, in a **Web Worker** | **CPU**, background thread |
| Scene build (filling the instance buffer), particle update, interpolation | JS | **CPU**, main thread |
| Sprite atlas, map background and UI icons (once, at start-up) | Canvas2D, uploaded with `texImage2D` | CPU and GPU at start-up only |
| HUD | DOM. Values are diffed, so it writes only on change, and nothing is blurred over the canvas | CPU layout, GPU compositor |
| Sound effects | WebAudio oscillators and noise | Audio thread |

Not used: WebGPU, compute shaders, OffscreenCanvas, SharedArrayBuffer.

**Where the time goes.** Measured with `EXT_disjoint_timer_query_webgl2` in the stress scenario at 1920×1080 on an Apple M2:
- The GPU spends **4.3 ms per frame (p50), 5.9 ms at most**, drawing about 16.3 k sprites. That is about 26% of a 60 Hz frame.
- DevTools CPU throttling does not slow the GPU.
- Every failure in the stress matrix is a **CPU** problem: first the simulation, then the main-thread scene build.

## Performance

### How performance was measured

| Tool | What it measures |
|---|---|
| `npm run stress:matrix -- --serve --label=X` (`tools/stressmatrix.mjs`) | Real Chrome on the real GPU, `?stress` scenario (5 000 enemies, 100 towers, ≥ 1 000 projectiles). Grid of **game speed 1/2/4/8/12× × DevTools CPU throttling 1/4/6/20×** (CDP `Emulation.setCPUThrottlingRate`). 3 s warm-up + 8 s sampled per cell. Appends every cell to `perf/results.jsonl` and writes `perf/runs/X.md`. |
| `tools/perfdiff.mjs A B` | Per-cell and geomean change between two runs |
| `tools/profile.mjs` | DevTools CPU profile (CDP `Profiler`) under throttling, ranked by self time. Profiles are in `perf/profiles/`. |
| `tools/simbench.mjs` | Node sim ms/tick, plus state hashes for the stress run and 41 mid-game checkpoints of two full bot games. A pure performance change must leave them identical. |
| `tools/scenebench.mjs` | Deterministic main-thread benchmark: freezes one stress state and times `Scene.build` 300 times under throttling |
| `/analytics` (`analytics.html`) | Dashboard over `perf/results.jsonl`: run cards, pass/fail matrix, trends, run-vs-run diff, breaking points |

A cell **passes** when all three hold:
- at least 95% of frames run at 45 FPS or better
- fewer than 5% of frames take longer than 33 ms
- the game reaches at least 98% of the requested speed

**Worker caveat.** DevTools CPU throttling does not reach Web Workers; CDP answers "only supported for pages".
So the harness passes `?workerslow=N`, and the worker busy-waits (N − 1) × its own work time after every batch.
I checked the emulation: 2.2–2.5 ms/tick in the worker at an emulated 4×, against 2.0 ms/tick on the main thread under real 4× throttling.

### Major bottlenecks (found by measuring)

1. **Tower target acquisition.** In the baseline profile, `findTarget` took 39% of the CPU at 4× throttle and 8× speed.
   About 47 000 candidate enemies were scored per tick, because 5 000 enemies are packed at about 50 per grid cell.
2. **Tesla chain search.** 18.7 range queries over about 6 600 candidates per tick, each to find one nearest enemy.
3. **Catch-up spiral.** At high game speed the loop ran up to 36 ticks in one frame. On a slow CPU each frame then needed more ticks, and FPS collapsed:
   - 4× CPU at 12× speed: 8.7 FPS
   - 20× CPU at 12× speed: 1.8 FPS
4. **Simulation and rendering on one thread.** About 95% of frame CPU was simulation. Rendering was 0.5–3 ms, and the GPU sat mostly idle.
5. **Main-thread scene build**, once the sim moved to the worker. At 20× CPU, `Scene.build` was 47% of main-thread time: 16 k sprites in one oversized function.

Earlier work, already in the baseline:
- `backdrop-filter` blur over the WebGL canvas (17 → 400 ms frames under software compositing)
- allocation and GC: steady-state frames allocate no pools
- per-sprite GPU overhead: one draw call, single-quad bars

### Optimisations (one commit each; details in `perf/OPTIMIZATIONS.md`)

| # | Branch | Change | Measured gain |
|---|---|---|---|
| 1 | `perf/sim-hotpath` | Cell-bounded target search: fused query, circle-culled cells, per-cell cached best as an upper bound | sim ms/tick **−24.5%**, frame CPU **−25.7%** (geomean, 20 cells) |
| 2 | `perf/sim-hotpath` | Nearest-first, pruned chain-jump search | sim **−10.3%**, frame CPU **−11.2%** |
| 3 | `perf/frame-budget` | Wall-clock budget for sim catch-up | frame CPU **−55.5%**. 4× and 6× CPU hold 60 FPS at every speed (were 8.9–49 FPS) |
| 4 | `perf/sim-worker` | **Simulation in a Web Worker**, with transferable snapshots | main-thread CPU **−63.4%** against the same build without a worker. 6× CPU at 4× now passes |
| 5 | `perf/sim-worker` | `Scene.build` split into per-section methods | scene build **−20%** at 20× CPU |
| 6 | `perf/fx-lod` | Adaptive effects quality | frame CPU **−25%** at 20× CPU, 1× speed (A/B). That cell now passes |
| – | – | Tried and dropped: flattened path tables, cache-invalidation tweak, *close* mode via nearest search, slot-order iteration, exact slot compaction (patch in `perf/experiments/`) | 0 to ±4%, or would change gameplay |

All steps keep the gameplay bit-identical; `simbench` checks the state hashes.

### Final constraints: what changed against the baseline

Stress scenario, Chrome 154 on an Apple M2, 1920×1080, real GPU. Each cell shows **avg FPS / achieved game speed**.
Baseline is `perf/runs/00-baseline.md`; final is `perf/runs/06-final-fx-lod.md`. The final run happened under a machine load average of about 5.

| CPU throttle | 1× | 2× | 4× | 8× | 12× |
|---|---|---|---|---|---|
| **1×** baseline | 60 / 1.00 ✅ | 60 / 2.00 ✅ | 60 / 4.00 ✅ | 60 / 8.00 ✅ | 60 / 12.0 ✅ |
| **1×** final | 60 / 1.00 ✅ | 60 / 2.00 ✅ | 60 / 4.00 ✅ | 60 / 8.00 ✅ | 60 / 12.0 ✅ |
| **4×** baseline | 60 / 1.00 ✅ | 60 / 2.00 ✅ | 60 / 4.00 ✅ | 12.8 / 5.13 ❌ | 8.7 / 5.24 ❌ |
| **4×** final | 60 / 1.00 ✅ | 60 / 2.00 ✅ | 60 / 4.00 ✅ | **60** / 6.72 ❌ | **60** / 6.72 ❌ |
| **6×** baseline | 60 / 1.00 ✅ | 60 / 2.00 ✅ | 15.8 / 3.16 ❌ | 8.4 / 3.34 ❌ | 5.7 / 3.42 ❌ |
| **6×** final | 60 / 1.00 ✅ | 60 / 2.00 ✅ | **60 / 4.01 ✅** | **60** / 4.10 ❌ | **60** / 4.45 ❌ |
| **20×** baseline | 5.2 / 0.97 ❌ | 4.9 / 0.99 ❌ | 4.8 / 0.96 ❌ | 2.6 / 1.60 ❌ | 1.8 / 2.40 ❌ |
| **20×** final | **59.6 / 1.00 ✅** | **59.4** / 1.38 ❌ | **60** / 1.40 ❌ | **59.5** / 1.49 ❌ | **60** / 1.59 ❌ |

* **Passing cells: 10 → 12 of 20.**

  | CPU throttle | Baseline breaking point | Final breaking point |
  |---|---|---|
  | 1× | 12× | 12× |
  | 4× | 4× | 4× |
  | 6× | 2× | **4×** |
  | 20× | none | **1×** |

* **Every cell now renders at 59.4–60 FPS**, against 1.8–60 before. Main-thread frame CPU is **−90.8%** (geomean), and p95 frame time is 16.8 ms everywhere.
* **What is still limited.** The 8 failing cells only miss the *game speed* condition.
  - Their tick rate needs more than one core of simulation. For example, 6× CPU at 12× speed needs 12 × 60 × 3.5 ms = 2.5 cores.
  - The game stays smooth and interactive, and the simulation runs as fast as one core allows: 6.7× at 4× CPU, about 4.3× at 6× CPU, about 1.5× at 20× CPU.
  - Going further would need either the sim split across several workers (hard to keep deterministic), or gameplay changes such as cheaper targeting rules. I chose not to change gameplay.

### Reproduce

```
npm test                                   # determinism, 50-wave memory, sim stress (Node only)
npm run stress:matrix -- --serve --label=x # game speed × CPU throttling matrix (needs playwright + Chrome)
node tools/perfdiff.mjs 00-baseline x      # compare two runs
node tools/profile.mjs --throttle=4 --speed=8 --url=http://127.0.0.1:8765/index.html
node tools/simbench.mjs                    # sim ms/tick + gameplay hashes
node tools/scenebench.mjs --url=…          # main-thread scene build under throttling
npm run build                              # dist/bastion.html single-file build (embeds the worker)
```

Open `/analytics`, served over HTTP, to see the runs.
Useful URL flags: `?stress&speed=8`, `?autoplay&turbo=16`, `?noworker`, `?nobudget`, `?canvas2d`, `?nodrs`, `?lockstep`, `?workerslow=N`.
