# @dvgl/core

The mission-time data model: deterministic `MissionClock` (caller-supplied wall
deltas, rate/loop/scrub), immutable `IntervalSet` (availability/visibility/contact
windows; merged, binary-searched), and columnar `SampledTrack` (Float64 times +
strided Float32 values, allocation-free `sampleInto` with a sequential-access memo).

**Pre-alpha.** APIs will change before v0.1. See the [dv.gl root README](../../README.md).
