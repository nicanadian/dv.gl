# @dvgl/bench-runner

The Stage 0 Track B benchmark runner. Two pages, one shared driver:

- `composed.html` -- CesiumJS (pinned exact version) at its lowest practical
  primitive layer. Records whether BufferPrimitiveCollection was available.
- `cleansheet.html` -- the @dvgl/webgpu instanced point hot path in a minimal raw
  WebGPU host (no framework; the Three.js-hosted friction variant comes later).

Both consume the same catalog, the same SatelliteJsSource propagation, and the same
scripted camera/scrub timeline from @dvgl/benchmarks. See docs/benchmark-fairness.md.

## Running

```
pnpm install
node scripts/fetch-catalog.mjs        # full public GP snapshot (optional; ~12MB)
pnpm --filter @dvgl/bench-runner dev  # then open /composed.html and /cleansheet.html
```

Without the fetch step the committed 240-object sample catalog is used -- fine for
smoke-testing the pages, NOT valid for published results (the scenario calls for the
~50k-object snapshot, checksummed).

Protocol per path: 1 warmup pass (discard) + 3 measured passes, reload between
passes, report the median pass. Each pass downloads a results JSON automatically.
