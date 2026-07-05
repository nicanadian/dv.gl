# Stage 0 friction log

Implementation friction per path, kept separate from runtime metrics per the
fairness rules. Each entry: what happened, the workaround, and what it implies.

## Composed path (CesiumJS 1.143.0, pinned exact)

- **BufferPrimitiveCollection absent from the npm build.** The experimental
  primitive (issue #13156) is not in the 1.143.0 release; the composed path runs
  `PointPrimitiveCollection` and records that in results. Using BPC means building
  Cesium from a pinned source commit — deferred until it materially changes the
  comparison. Implication: the "lowest practical primitive layer" on the npm
  distribution is PointPrimitiveCollection.
- **widgets.css is load-bearing.** Without importing
  `cesium/Build/Cesium/Widgets/widgets.css` the Viewer silently renders at a
  fallback ~300px size. No error, no warning.
- **Static assets need manual wiring under Vite/pnpm.** Workers/Assets/ThirdParty
  must be copied from the app-local `node_modules/cesium/Build/Cesium` (pnpm's
  layout breaks workspace-root-relative paths) and `CESIUM_BASE_URL` defined.
- **Per-primitive position updates are the scrub cost.** Updating N point
  primitives per epoch is a JS loop with per-primitive setter overhead; at 127k
  objects it dominates scrub-to-frame (240 ms p95 vs 67 ms clean-sheet, headless).

## Clean-sheet path (@dvgl/webgpu)

- **TS 5.8 typed-array generics.** `GPUQueue.writeBuffer` needs
  `Float32Array<ArrayBuffer>` staging annotations under strict mode.
- Otherwise: no workarounds needed for instanced points + RTE at Stage 0 scope.

## sgp4.gl 0.1.5-beta (WASM+GPU propagation)

- **65,536 batch cap.** `propagate_registered_f32` rejects larger sets
  ("Batch size ... exceeds maximum supported size 65536"). Workaround: register
  the constellation as multiple const-set chunks and fan requests across them.
- **The WASM propagator is not reentrant.** Concurrent `propagate_registered_f32`
  calls on one `GpuPropagator` panic with `unreachable`. Chunks must be evaluated
  strictly sequentially (or on separate propagators — untested).
- **`register_const_set` consumes its inputs.** wasm-bindgen moves ownership of
  each `WasmGpuConsts` into WASM; reusing a handle (e.g. for workload replicas)
  hands the registry a neutered pointer and the whole array is rejected
  ("array contains a value of the wrong type"). Replicas need freshly built
  consts.
- **Vite integration.** Works via `import init from "sgp4.gl"` +
  `import wasmUrl from "sgp4.gl/wasm?url"` + `await init(wasmUrl)`; no plugin
  needed.
- Net: usable tonight, three sharp edges. Supports the fork-and-pin posture
  before depending on it for anything published.

## Runner/harness

- **satellite.js `twoline2satrec` accepts garbage** (NaN elements, `error` 0);
  validate by propagating at epoch.
- **satellite.js failure shapes vary** (`false`, `position: false`,
  `position: undefined`, NaN components) across regimes/versions; a real catalog
  hits shapes the docs don't mention. Boundary-guard everything.
- **Headless Chromium runs WebGPU on Metal** (with
  `--enable-unsafe-webgpu --use-angle=metal`), which makes CI-adjacent smoke
  benchmarks possible — but published numbers still require a real desktop
  browser session per the hardware-matrix rule.
