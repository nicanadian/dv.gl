# Stage 0 benchmark fairness rules

Set in writing before either render path was built, per the Stage 0 plan. An unfair
benchmark gets dismantled in public; these rules are the contract, and the harness in
`@dvgl/benchmarks` encodes them as code. Changes to this file after results are
published must be called out in the results.

## The two paths

- **Path 1, composed:** CesiumJS with `BufferPrimitiveCollection` (the lowest practical
  primitive layer). The Cesium **Entity API is measured only as a baseline**, never as
  the comparison. The Cesium dependency is **pinned to an exact commit** in the
  benchmark package, because `BufferPrimitiveCollection` is experimental (Cesium issue
  #13156) and may shift; results name the pinned commit.
- **Path 2, clean-sheet:** a raw WebGPU hot path (instanced points, camera-relative
  RTE precision, compute-driven epoch evaluation) mounted inside a minimal Three.js
  WebGPU scene.

Both paths consume the **same propagation buffers** (sgp4.gl WebGPU compute; identical
catalog upload, identical epoch evaluation cadence).

## Shared workload (identical for both paths)

1. **Catalog:** the same snapshot of the public GP catalog (~50k objects), stored in the
   repo by checksum reference, filtered identically (drop decayed/invalid records with
   the same rule on both paths).
2. **Propagation source:** sgp4.gl, same version/fork commit, same workgroup
   configuration, same epoch-evaluation cadence.
3. **Timeline:** a 7-day scrubbable window at the same start epoch.
4. **Trails:** the single fairness-mandated configuration (defined in
   `@dvgl/benchmarks` scenario; no per-path tuning). Stage 0 default is trails **off**;
   if enabled for a scenario variant, both paths render the same trail length and
   update cadence.
5. **Camera and scrub:** the scripted camera motion and scrub pattern defined
   deterministically in `@dvgl/benchmarks` (`stage0Scenario`). No hand-driven input
   during measurement. The same script drives both paths.
6. **Hardware/browser matrix:** results are reported per (device, OS, browser,
   browser version) cell. No cross-cell comparisons in headline numbers.

## Globe-cost boundary

The comparison measures **scene architecture, not Cesium's imagery pipeline**. Either:

- both paths render an identical single-texture ellipsoid basemap (no imagery
  streaming, no terrain), or
- the globe pass cost is measured separately and subtracted, with the measurement
  method published.

Whichever is used is stated in the results.

## Metrics

Collected identically on both paths, by the same harness code:

| Metric | Definition |
|---|---|
| p50/p95 frame time | Per-frame wall time over the scripted run, after warmup |
| Main-thread CPU per frame | Long-task/`performance` derived main-thread ms |
| JS allocation per frame | Delta of `performance.memory`/heap samples; GC events counted |
| Draw calls | Per-frame, from the renderer's own counters |
| GPU memory | Peak, from adapter info where available |
| Time to first frame | Page load to first rendered frame with the full catalog |
| Scrub-to-frame latency | Scrub input event to the next presented frame reflecting the new time (**the gate metric, p95**) |
| Max object count | Largest catalog multiple sustaining 30 and 60 FPS |

**Gate (Outcome A requires):** clean-sheet p95 scrub-to-frame latency ≥3x lower than
the composed path. Everything else is evidence, not a gate.

## Warmup and runs

Each measured configuration runs: 1 warmup pass (discarded) + 3 measured passes;
report the median pass. Page reloaded between passes. Background tabs closed;
power connected; thermal throttling noted if observed.

## Friction log

Implementation friction (API workarounds, missing capabilities, precision hacks,
version pinning pain) is logged per path in `docs/friction-log.md`, separately from
runtime metrics. Friction informs the standalone-versus-hosted decision; it does not
contaminate the performance numbers.

## Numerics (Stage 0 scope)

sgp4.gl FP32 accuracy versus a double-precision Vallado reference across a 7-day
window for representative LEO, MEO, and GEO cases. The reference chain is
established headless first (`@dvgl/validate`): python-sgp4 (Vallado, fp64) fixtures
cross-checked against satellite.js (Vallado, fp64) so the JS-side reference is itself
validated before any GPU comparison. The full regime matrix is v0.1 work, not Stage 0.

## Publication

The harness, scenario definition, catalog checksum, pinned dependency commits, raw
per-frame samples, and this document are published together with any results.
