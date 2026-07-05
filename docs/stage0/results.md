# Stage 0 Track B results — 2026-07-04

**Verdict: Outcome A. Build the clean-sheet renderer.** The gate (clean-sheet p95
scrub-to-frame latency ≥3x lower than the composed CesiumJS path) is passed at every
workload scale tested, on real hardware: **5.9x at 16k objects, 3.6x at 64k, 3.5x at
127k.**

Read with `docs/benchmark-fairness.md` (the rules, set before the paths were built,
plus four dated pre-results amendments) and `docs/friction-log.md`. Raw per-pass
JSONs: `docs/stage0/raw/`.

## Environment

- Apple Mac mini (Apple Silicon), macOS 15.6 (Darwin 24.6.0)
- Chrome 150 (stable), WebGPU on Metal; pages driven by Playwright (scripted input
  is the protocol — no hand-driven input)
- Catalog: CelesTrak GP snapshot, 2026-07-04, 15,918 objects,
  sha256 `7f10fead92ad3d86…` (recorded in every result JSON)
- Cesium **1.143.0 pinned exact**; `PointPrimitiveCollection`
  (`BufferPrimitiveCollection` is not in the npm build — friction log)
- Propagation: sgp4.gl 0.1.5-beta (WASM+GPU), identical source on both paths
- Globe pass disabled on both paths (strict form of the globe-cost boundary)
- Protocol: 1 warmup (discarded) + 3 measured passes per config, fresh page per
  pass, median reported

## Gate metric: p95 scrub-to-frame latency (ms)

A scrub closes only when a presented frame renders positions evaluated at the
scrubbed scene time. Workloads above 16k use `?x=N` phase-shifted replication
(each object instantiated N times, 17 min apart along its own orbit).

| objects | composed (Cesium) | clean-sheet (@dvgl/webgpu) | ratio | gate (≥3x) |
|---|---|---|---|---|
| 15,918 | 104.5 (107.1 / 102.2 / 104.5) | 17.6 (17.5 / 18.4 / 17.6) | **5.94x** | pass |
| 63,672 | 128.7 (128.7 / 202.2 / 123.8) | 35.4 (35.4 / 35.3 / 48.5) | **3.64x** | pass |
| 127,344 | 242.7 (242.7 / 242.9 / 242.0) | 68.6 (single pass¹) | **3.54x** | pass |

¹ Session interruption left one measured clean-sheet pass at x8 instead of three.
The single pass matches an independent headless run (66.7 ms) within 3%, and the
composed side's three passes vary by <0.5 ms; the ratio is robust to this gap.

Frame-time p95 medians: clean-sheet 17.5–18.4 ms at every scale (scrubs complete
within roughly one frame); composed 22.4–24.8 ms. The composed path's cost is its
per-primitive JS position-update loop, which scales linearly with object count.
The clean-sheet path is one storage-buffer upload and one instanced draw call.

## Secondary variant: shared CPU worker propagation

With satellite.js in a Web Worker on both paths (no GPU propagation), manually run
in the same Chrome: composed 46.6 ms vs clean-sheet 34.1 ms at 16k (1.37x). With a
CPU source, propagation dominates the scrub interval identically on both paths and
compresses the ratio — this is why the gate configuration uses GPU propagation.
Several manual passes were invalidated by background-tab RAF throttling (145–817
frames instead of ~3,600); invalid passes are excluded and preserved in
`raw/manual-worker/`.

## Numerics: sgp4.gl fp32 vs fp64 Vallado reference (7-day window)

Via `@dvgl/validate` `compareEphemerides` against python-sgp4 fixtures
(`numerics.html`). Reference band = measured disagreement between two independent
fp64 Vallado implementations (python-sgp4 vs satellite.js).

| regime | max error | rms | final (7d) | fp32 storage floor | fp64 reference band |
|---|---|---|---|---|---|
| LEO | 758 m | 171 m | 118 m | 0.34 m | ~0.34 m |
| MEO | 557 m | 111 m | 25 m | 1.22 m | ~3 m |
| GEO | 302 m | 189 m | 203 m | 2.10 m | ~3 m |

The error is fp32 *arithmetic* accumulation inside SGP4 (oscillatory, two to three
orders above the storage floor). **Boundary: GPU fp32 SGP4 is suitable for
visualization (sub-km is sub-pixel at situational-awareness zooms) and not for
conjunction-grade analysis.** This statement accompanies any use of these latency
numbers.

## Caveats

- One hardware/browser cell (Apple Silicon + Chrome/Metal). The fairness rules
  require per-cell reporting; no cross-platform claim is made. Windows/NVIDIA and
  Intel iGPU cells are untested.
- Composed path uses `PointPrimitiveCollection`, not the experimental
  `BufferPrimitiveCollection` (absent from the 1.143.0 npm build). A source-built
  Cesium with BPC could narrow the gap; that variant is future work and the reason
  the "lowest practical primitive" wording exists.
- The clean-sheet host is a minimal raw-WebGPU canvas; the Three.js-hosted friction
  variant (a separate Track B question) has not been run.
- Trails off, globe off, points only — Stage 0 scope. Richer scenes change both
  paths' numbers.

## What this triggers (per the Stage 0 plan)

Outcome A: proceed with the clean-sheet WebGPU renderer as the core of dv.gl.
Next build steps: `@dvgl/core` mission clock/timeline as a real implementation
(the explore page becomes its first consumer), fork-and-pin sgp4.gl per the
dependency posture, and the Three-hosted embedding experiment for the friction
log. Track A (customer discovery, deployment-environment WebGPU checks) remains
open and is unaffected by this result.
