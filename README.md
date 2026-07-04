# dv.gl

A WebGPU mission-visualization SDK for high-dynamic orbital scenes.

dv.gl is a mission-time data model and deterministic playback runtime with a WebGPU
rendering hot path. It is not a Cesium replacement, not a globe engine, and not a GIS
stack.

> **Status: pre-alpha.** This repository is scaffolding for a project under active early
> development. Nothing here is usable yet. APIs, package boundaries, and internals will
> change without notice.

## Why

Dynamic-scene rendering in browser mission tools today is CPU-bound: per-entity
JavaScript work, per-frame allocation, and garbage-collection stalls limit how many
time-varying objects a scene can hold before frame times and scrub latency degrade.
WebGPU makes compute-driven evaluation of orbital state and instanced rendering of large
object populations practical in the browser. dv.gl targets that gap with a typed-array
columnar data model, an allocation-free animation path, and GPU-resident propagation and
rendering.

## Packages

| Package | Responsibility |
|---|---|
| `@dvgl/core` | Deterministic clock, timeline, epochs, intervals, sampled tracks, playback state |
| `@dvgl/frames` | Time systems and coordinate frame transforms |
| `@dvgl/orbits` | TLE/OMM/OEM ingestion and the propagation adapter |
| `@dvgl/czml` | Strict CZML subset parser and exporter with diagnostics |
| `@dvgl/webgpu` | WebGPU render primitives: instanced points, trails, picking, precision math |
| `@dvgl/benchmarks` | Reproducible benchmark scenes and the metric harness |
| `@dvgl/validate` | Reference-comparison tooling for correctness validation |

## Standards interop

Intended ingestion and interchange formats: TLE, OMM (GP JSON), OEM ephemeris, and a
strict CZML subset (document, clock, position, orientation, point, path, availability)
with export of the same subset so migration is reversible.

Non-goals: no terrain engine, no imagery streaming, no vector map tiles or GIS features,
and no SPICE runtime in the browser (SPICE workflows are supported by preprocessing to
OEM outside the browser).

## Planned dependencies

[sgp4.gl](https://github.com/kayhan-space/sgp4.gl) (MIT, by Kayhan Space) is planned as
the GPU SGP4 propagation path. It is not yet integrated.

## License

[Apache-2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute,
including the required DCO sign-off.
