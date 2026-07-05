# @dvgl/czml

Strict CZML subset parser and exporter: document (+ clock) and entity packets with
availability, sampled `position` (epoch + cartesian, meters converted to km at the
boundary), and `point` styling. Parse and export are inverses over the subset, so
migration off (or back to) Cesium is reversible. Semantic surprises throw with the
packet id; cosmetic unknowns are collected as warnings. `czmlToSegments` bridges
entities into the same ephemeris seam OEM uses.

**Pre-alpha.** See the [dv.gl root README](../../README.md).
