# Optimisation log

Each step is one commit. The numbers come from `tools/stressmatrix.mjs` (real Chrome and the real GPU, Apple M2, 1920×1080):
the `?stress` scenario at 1/2/4/8/12× game speed, under DevTools CPU throttling of 1/4/6/20×.
`tools/perfdiff.mjs <a> <b>` reproduces each diff. Raw rows are in `results.jsonl`, and the full matrices are in `runs/`.

A cell **passes** when it meets all three conditions:
- at least 95% of frames run at 45 FPS or better
- fewer than 5% of frames take longer than 33 ms
- the simulation reaches at least 98% of the requested game speed

Gameplay must stay bit-identical. `node tools/simbench.mjs` prints state hashes for the stress run and for two full
50-wave bot games, and a pure performance change has to leave all three unchanged:
`stress 789190078`, `victory/w50/3412512395`, `victory/w50/2908296023`.

| # | Change | Sim ms/tick (geomean, all cells) | Frame CPU (geomean) | Passing cells (of 20) |
|---|---|---|---|---|
| 0 | baseline | — | — | 10 |
| 1 | Targeting: fused query and scoring, culling of grid cells outside the range circle, per-cell cached best target used as an upper bound | **−24.5%** | **−25.7%** | 10 |
| 2 | Tesla chain: nearest-first cell walk with distance pruning | **−10.3%** vs #1 | **−11.2%** vs #1 | 10 |
| 3 | *(branch `perf/frame-budget`)* Frame-time budget for sim catch-up | +2% (noise) | **−55.5%** vs #2 | 10 |
| 4 | *(branch `perf/sim-worker`)* Simulation in a Web Worker, with snapshots to the main thread | +14% (includes snapshot encode) | **−63.4%** vs the same build without a worker | **11** |

## 0 · Baseline: where it breaks

| CPU throttle | passes up to | first failing cell |
|---|---|---|
| 1× | 12× | none |
| 4× | 4× | 8×: 12.8 FPS, and the game reaches only 5.1× speed |
| 6× | 2× | 4×: 15.8 FPS |
| 20× | none | 1×: 5 FPS, with the sim at 15 ms/tick and the catch-up loop spiralling to about 11 ticks per frame |

DevTools CPU profile at 4× CPU and 8× speed (`node tools/profile.mjs --throttle=4 --speed=8`):

| Function | Self time |
|---|---|
| `findTarget` | 39% |
| `updateEnemies` | 21% |
| `fireChain` | 9% |
| `updateProjectiles` | 7% |
| `damage` | 5% |
| `queryCircle` | 5% |
| `buildGrid` | 3% |
| all rendering (`Scene.build`, buffer upload, fx) | about 3% |

The game is bound by simulation CPU, not by the GPU.

## 1 · Targeting with cell bounds

Each tick ran 84 range queries that returned about 47 500 candidates, because 5 000 enemies are packed along the path at about 50 per 40 px cell.
- `findTarget` now scores candidates in the same pass as the grid walk, and reads path lengths from a flat `Float64Array`.
- Cells whose nearest point lies outside the circle are skipped.
- For the *first*, *last* and *strong* modes, every cell lazily caches its best enemy and that enemy's score.
  The cache is invalidated per cell when an enemy there is damaged or removed.
  The cached score is an upper bound on what any in-range enemy in that cell can score, so the search works like this:
  - If the bound cannot beat the current best, the cell is skipped.
  - If the cell's best enemy is itself in range, it is taken without a scan.
  - Only the remaining cells are scanned.

  This picks exactly the same enemy as a linear scan, ties included, so all hashes are unchanged.

Node: 0.690 → 0.518 ms/tick (−25%). Chrome: ms/tick −26% at 4×, 6× and 20× CPU.
At 4× CPU and 8× speed the achieved speed rose from 5.13× to 7.02×. At 6× CPU and 4× speed, FPS went from 15.8 to 31.6.

## 2 · Tesla chain nearest-neighbour search

After step 1, `fireChain` became the largest user of `queryCircle`.
Each tick it ran 18.7 queries over 6 655 candidates just to find one nearest enemy per jump.
`nearestUnhit` replaces those queries:
- It visits the current enemy's own grid cell first, then the other cells.
- It skips any cell whose nearest point is farther than the best distance found so far.
- Ties go to the lower grid item index. That index is the order a row-major scan meets the items, so the result is identical to the old linear scan.

Node: 0.518 → 0.434 ms/tick (−16%). In Chrome, sim cost fell 9–13% in every cell.
At 6× CPU and 4× speed, FPS went from 31.6 to 49.0, and the frame CPU there fell 37%.

I tried using the same routine for findTarget's *close* mode. It gave no measurable gain, so I dropped it.

### Tried and dropped (sim hot path)

These changes gave less than 3% each, so I did not keep them:

| Change | Result |
|---|---|
| Flatten the per-path sample tables | 0% |
| Invalidate the per-cell cache only when the cached argmax itself is hit | 0% |
| Use `nearestUnhit` for the *close* targeting mode | 0% |
| Walk enemies in slot order instead of the dense list | −2%, and it changes gameplay hashes, because healer pulses see positions mid-update |

Exact-equivalence work on the sim has plateaued at about −35% versus baseline.

## 3 · Frame-time budget for sim catch-up (`perf/frame-budget`)

At high game speed, `FixedLoop` ran up to `speed × 3` ticks in one frame (36 at 12×).
On a slow CPU each frame then needed more ticks, which made frames slower still, and FPS collapsed:
- 4× CPU at 12× speed: 13.8 FPS
- 20× CPU at 12× speed: 2.6 FPS

`FixedLoop.budgetMs` now stops stepping once a frame's sim time passes the budget. At least one tick always runs, and the leftover backlog is dropped.
`main.js` sets the budget to `max(3, 13 ms − smoothed render+UI cost)`, so the whole frame fits in a 60 Hz vsync slot. `?nobudget` restores the old behaviour.

| Cell | FPS before → after | Achieved speed before → after |
|---|---|---|
| 4× CPU, 8× | 24.2 → **60.0** | 7.93× → 5.94× |
| 4× CPU, 12× | 13.8 → **60.0** | 8.26× → 6.12× |
| 6× CPU, 4× | 49.0 → **60.0** | 4.00× → 3.59× |
| 6× CPU, 12× | 8.9 → **60.0** | 5.33× → 3.82× |
| 20× CPU, 1× | 21.1 → **36.8** | 1.00× → 0.61× |
| 20× CPU, 12× | 2.6 → **41.4** | 2.40× → 0.69× |

Frame CPU fell 55.5% (geomean), and the game stays responsive at every throttle and speed.
The cost is sim throughput when the CPU is overloaded, because render overhead is now paid on every frame.
So no new cell passes, since the speed criterion fails. Getting 60 FPS and full throughput together needs the sim on another core (step 4).

## 4 · Simulation in a Web Worker (`perf/sim-worker`)

**Architecture change.** `js/sim-worker.js` owns the authoritative `Sim` and the bot, and steps them on its own fixed-step clock.
The worker caps its own catch-up at 12 ms per pump, so it keeps posting snapshots.

After each pump the worker packs the render state into one transferable `ArrayBuffer`, defined in `js/core/snapshot.js`:
- a Float64 header of scalars
- fixed-capacity Float32 SoA blocks for enemies and projectiles
- per-tower dynamic state
- the fx and sound event stream the sim emitted since the last snapshot

Two buffers ping-pong: one is shown and one is in flight. The main thread hands the spare back once per rendered frame, so snapshots never outpace the display.
On the main thread, `SimView` exposes the same field names as `Sim`, so `scene.js` and `ui.js` stay almost unchanged.
`SimView` replays the fx events into the particle system and checks player commands locally with the same rules as `Sim`.
It applies each command optimistically and posts it to the worker, which stays authoritative.

Fallbacks:
- `file://` blocks worker scripts, so `index.html` opened that way keeps the single-thread path.
- `?noworker` forces the single-thread path.
- The single-file `dist/bastion.html` inlines the worker source and starts it as a Blob worker, so it works from `file://` as well.

**How the worker is measured.** DevTools CPU throttling does not reach workers.
I confirmed this: CDP answers "Operation is only supported for pages, not workers", and a worker busy-loop ran at full speed under 4× throttle.
So the harness passes `?workerslow=N`. After each pump, the worker busy-waits for (N − 1) × the time that pump's work took.
The emulation holds up: the worker measures 2.2–2.5 ms/tick at an emulated 4× slowdown, against 2.0 ms/tick on the main thread under real 4× throttling.
Both runs below use the same HTTP origin (`--serve`): `04-noworker-http` against `04-sim-worker`.

| Cell | No worker | Worker |
|---|---|---|
| 1× CPU, 12× speed: main-thread CPU/frame | 6.3 ms | **0.7 ms** |
| 4× CPU, 8×: FPS / achieved speed | 60 / 5.83× | 60 / **7.04×** |
| 6× CPU, 4× | 59.9 FPS / 3.37× ❌ | 60 / **4.00× ✅** |
| 20× CPU, 1× | 36.0 FPS / 0.60× | **51.9 FPS / 1.00×** |
| 20× CPU, 12× | 41.5 FPS / 0.69× | **59.9 FPS / 1.56×** |

- Main-thread frame CPU fell 63.4% (geomean). Against the original baseline it is down 89.3%.
- The worker's ms/tick is about 14% higher than the in-thread sim, because it includes encoding a snapshot per pump. At low game speeds that cost is amortised over few ticks.
- What still fails:
  - 4× and 6× CPU at 8–12×: the worker core is saturated, and the game reaches about 7× and about 4.7×.
  - 20× CPU at 1×: main-thread **render** CPU (scene build plus particles, about 15 ms) is now the bottleneck.
