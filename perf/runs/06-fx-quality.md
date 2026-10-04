# Stress matrix — 06-fx-quality

commit `31ba735` (+uncommitted js changes) · 2026-10-04T10:12:23.782Z · 1920×1080@1 · GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)
Scenario: `?stress` (5 000 enemies, 100 towers, ≥ 1 000 projectiles), 3 s warm-up + 8 s sampled per cell. URL: `http://127.0.0.1:PORT/index.html` flags `none`. Sim: Web Worker (CPU slowdown emulated in the worker).

| CPU throttle | speed | avg FPS | p50 / p95 / p99 ms | > 33 ms | CPU/frame ms | sim ms | render ms | ms/tick | ticks/frame | speed achieved | result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 20× | 1× | 58.4 | 16.7 / 16.8 / 33.4 | 0.2% | 10.26 | 0.32 | 9.88 | 14.512 | 0.98 | 0.96× | ❌ |
| 20× | 2× | 58.5 | 16.7 / 16.8 / 33.3 | 0.2% | 10.33 | 0.31 | 10.00 | 11.667 | 1.43 | 1.40× | ❌ |
| 20× | 4× | 59.3 | 16.7 / 16.8 / 33.3 | 0.6% | 8.62 | 0.37 | 8.21 | 12.086 | 1.33 | 1.32× | ❌ |
| 20× | 8× | 59.0 | 16.7 / 16.8 / 33.3 | 0.2% | 9.63 | 0.29 | 9.32 | 11.309 | 1.44 | 1.42× | ❌ |
| 20× | 12× | 59.1 | 16.7 / 16.8 / 33.4 | 0.6% | 8.75 | 0.32 | 8.42 | 11.081 | 1.47 | 1.45× | ❌ |

Breaking point (highest passing speed per throttle):

- CPU 20×: fails at every speed
