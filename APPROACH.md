# Approach

## How I worked

I built Bastion with an LLM as a pair programmer.
- First I planned the architecture.
- Then I built the game together with the LLM.
- Then I ran a measure → optimise → re-measure loop: every optimisation was benchmarked and committed with its % gain.

Details:
- Design decisions are in [README.md](README.md).
- The step-by-step optimisation log is in [perf/OPTIMIZATIONS.md](perf/OPTIMIZATIONS.md).
- A live dashboard of every benchmark run is at `/analytics`.

## The #1 challenge: trustworthy performance numbers

Writing the optimisations was the easier half. The hard part was making sure every measured gain was real.

### Where the first version broke

I built an automated stress test first. It runs real Chrome at every game speed (1/2/4/8/12×) under DevTools CPU throttling (1/4/6/20×) and logs every run to `perf/results.jsonl`.

On a fast laptop the first version held 60 FPS everywhere. Under CPU throttling it collapsed:

| CPU throttle | Game speed | FPS |
|---|---|---|
| 4× | 8× | 12.8 |
| 6× | 4× | 15.8 |
| 20× | 1× | about 5 |

Profiling showed about 95% of the frame was simulation, with tower targeting alone at 39%. The GPU was mostly idle.

### Measurement problems I had to solve

1. **Throttling doesn't reach Web Workers.** My biggest optimisation moved the simulation into a Web Worker. Chrome's CPU throttling only slows the main thread; it rejects throttling a worker. A naive measurement would therefore have shown a large improvement that wasn't real.
   - So the worker emulates the same slowdown itself.
   - I validated that against real throttling: 2.2–2.5 ms per tick emulated, against 2.0 ms real at 4×.
   - This is documented as a known limitation.
2. **A noisy machine.** Background load caused 15–20% swings between identical runs. I switched to back-to-back A/B runs and a fixed-state benchmark that freezes one moment of the stress test and times it repeatedly.
3. **Proving gameplay didn't change.** Every optimisation had to leave the simulation's state hashes bit-identical. The hashes cover a stress run plus 41 mid-game checkpoints across two full 50-wave games. They caught one optimisation that subtly changed the game, so I dropped it.

## Results

| # | Optimisation | Measured gain |
|---|---|---|
| 1 | Smarter tower targeting (cell-bounded search) | −24.5% sim cost |
| 2 | Faster Tesla chain-jump search | −10.3% sim cost |
| 3 | Frame-time budget, so slow CPUs keep 60 FPS | −55.5% frame CPU |
| 4 | Simulation moved to a Web Worker | −63.4% main-thread CPU |
| 5 | Scene-builder restructure | −20% render CPU |
| 6 | Adaptive effects quality | −25% frame CPU at 20× CPU |

Overall:
- **10 → 12 of 20** stress cells pass.
- **Every cell now runs at 59–60 FPS**; before, some ran as low as 1.8 FPS.

Highest passing game speed per CPU throttle:

| CPU throttle | Before | After |
|---|---|---|
| 6× | 2× | **4×** |
| 20× | none | **1×** |

The remaining failures need more than one CPU core of simulation. I chose not to trade away gameplay accuracy to fix them.

## Rough time breakdown (9:00 AM – 5:00 PM)

| Time | Activity |
|---|---|
| 9:00 – 9:30 | Planning: architecture, rendering approach, data structures, stress-test design |
| 9:30 – 11:50 | Building the game with the LLM: simulation, WebGL renderer, 5 towers, 7 enemy types, 50 waves, UI, balance tuning |
| 11:50 – 2:10 | Deploying to Vercel, playtesting, polish, lint cleanup, adding 8×/12× speeds |
| 2:10 – 2:45 | Stress-test harness and baseline measurement (finding the breaking point) |
| 2:45 – 3:50 | Optimisation loop: profiling, six optimisations and one failed experiment, each benchmarked and committed with its % gain |
| 3:50 – 4:20 | README and docs, final benchmark run, analytics dashboard, merging all work and deploying to production |
| 4:20 – 5:00 | NUMBERS.md, demo video recording, submission |

About a third of the optimisation time went to waiting on benchmark runs; each full stress run takes about 7 minutes. I used quick benchmarks to iterate, and the full Chrome run only to confirm each step.
