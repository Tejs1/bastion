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
