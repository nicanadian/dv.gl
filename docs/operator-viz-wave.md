# Operator-viz wave

The next dv.gl build wave: the reusable half of a mission-visualization SDK, drawn
from a review of the pdb-spacecraft-simulator dashboard (Cesium + deck.gl) against
the boundary principle:

> **dv.gl owns mechanism** — how to draw N time-varying things in a precise geospatial
> scene, fast, from standard inputs (typed arrays, OEM/CZML/TLE). **The app owns
> policy** — what a thing means, when it is shown, what a colour signifies, layout,
> workflow, and data binding.

Litmus (a feature belongs in dv.gl only if all hold): a different operator would need
it identically; it is geometry/time/rendering not semantics/workflow; it consumes
standard inputs not an app schema; it is stateless given its inputs.

Each item lists dv.gl-side scope, inputs → outputs, how it is tested (headless where
possible so CI stays GPU-free), and the explore-page demo. Geometry primitives land
in `@dvgl/core`/`@dvgl/frames`/`@dvgl/orbits` (headless, unit-tested); renderers land
in `@dvgl/webgpu` (browser smoke).

## Priority order

Keystone first, then the cheap promised follow-up, then the coverage/access story,
then data-model + scale, then the large 2D finale. Headless geometry is front-loaded
so the render items have tested inputs.

| # | item | package(s) | headless? | why here |
|---|---|---|---|---|
| V1 | Direction marker at "now" | webgpu | no (smoke) | tiny; closes the accessibility follow-up already flagged |
| V2 | Pick / hover / select | webgpu + app | partial | keystone: every linked-panel workflow needs "click a thing" |
| V3 | Ground tracks on the surface | frames + webgpu | geometry yes | the 2D-in-3D view; reuses the orbit-track window |
| V4 | Ground stations + access lines | frames + core | yes | LOS/elevation geometry + access windows (IntervalSet) |
| V5 | Sensor footprints + swaths | frames + webgpu | geometry yes | the coverage question; generalises app addAccessSwath |
| V6 | Event marks on the timeline | core + app | yes | a marks primitive the app fills with meaning |
| V7 | Coverage accumulation | webgpu | no (smoke) | where has the fleet looked; GPU accumulation |
| V8 | Labels (declutter-aware) | webgpu | partial | identify without hovering |
| V9 | 2D map projection mode | webgpu | no (smoke) | eventually retire the separate deck.gl path |

## V1 — Direction marker at "now"

- **Scope:** at each object's current position, a short along-track leader (or chevron)
  pointing in the direction of motion, in the object's family colour at full bright.
- **In → out:** the orbit-track window already has the samples straddling "now";
  the marker direction is `sample[now+1] - sample[now]`, screen-space normalised.
- **Test:** WGSL layout contract unit test; browser smoke (marker points prograde,
  visible when paused/greyscale).
- **Demo:** explore, tracks on — a chevron at each satellite.

## V2 — Pick / hover / select

- **Scope:** GPU id-picking. A second offscreen render pass writes per-object ids; a
  1x1 read at the cursor returns the id under it. A small `Selection` API
  (`onHover`, `onSelect`, `selected set`) + a hovered/selected visual (halo, or
  brightened point). No panel content — the app owns that.
- **In → out:** the same instanced point positions; ids are instance indices. Emits
  `{ index, name? }` on hover/click.
- **Test:** id-encode/decode round-trip (headless); browser smoke (hover a dot,
  callback fires with the right index).
- **Demo:** explore shows the hovered object name + a halo; click pins a selection.

## V3 — Ground tracks on the surface

- **Scope:** project the ±1-orbit track window to the WGS84 surface (sub-satellite
  point) and draw it as a surface polyline, dateline-split, past/future by the same
  luminance scheme. Earth-fixed by construction.
- **In → out:** window samples (km, TEME/ECEF) → geodetic lon/lat via
  `ecefToGeodetic` → surface points at a small altitude bump.
- **Test:** projection + dateline-split unit tests (a track crossing +/-180 splits
  into segments; sub-satellite lat matches inclination extrema); browser smoke.
- **Demo:** explore "ground tracks" toggle; the weave laid on the globe.

## V4 — Ground stations + access lines

- **Scope:** station markers at lat/lon; per-station **access windows** to each
  object as an `IntervalSet` (rise/set by elevation-mask crossing); an access line
  (station→satellite) drawn while in view.
- **In → out:** station `{lat, lon, minElevationDeg}` + a `PropagationSource` →
  `elevationDeg(t)`, `accessWindows()` (IntervalSet), and live in-view boolean.
- **Test:** elevation/LOS math vs a hand-worked geometry case; a circular-orbit pass
  produces one symmetric window per rev; below-mask never in view. Headless.
- **Demo:** explore loads a couple of stations; access lines light up on passes.

## V5 — Sensor footprints + swaths

- **Scope:** given `(position, boresight, half-angle)` compute the ground footprint
  (nadir circle or off-nadir ellipse on the ellipsoid) and, swept along the track, a
  swath ribbon. Render as a translucent surface polygon/ribbon.
- **In → out:** boresight + half-angle + position → footprint ring (geodetic) and
  swath quad-strip.
- **Test:** nadir footprint radius vs closed-form (half-angle, altitude); footprint
  centred on the sub-satellite point; grazing/limb cases clamp cleanly. Headless.
- **Demo:** explore per-family sensor cone toggle; swath painting under a track.

## V6 — Event marks on the timeline

- **Scope:** a `@dvgl/core` `TimelineMarks` model (typed events at scene-times with a
  category) + query "marks in [a,b]" and "nearest mark to t". The app supplies the
  events and their meaning; dv.gl supplies the time-indexing and (optionally) a
  minimal tick strip the host can style.
- **Test:** insertion/sort, range query, nearest, jump-to-next. Headless.
- **Demo:** explore seeds a few synthetic events; ticks on the timeline; press `.`
  to jump to the next.

## V7 — Coverage accumulation

- **Scope:** a persistent GPU accumulation texture in an equirectangular grid; each
  frame the active footprints stamp coverage (count or last-seen time). Read back /
  visualise as a heat overlay on the globe.
- **In → out:** footprints (V5) → an accumulation texture the host colour-maps.
- **Test:** browser smoke (a swath leaves a track in the buffer; clearing resets).
- **Demo:** explore "coverage" overlay accumulating under the fleet.

## V8 — Labels (declutter-aware)

- **Scope:** screen-space labels for selected/hovered/important objects, with simple
  greedy declutter (hide overlapping lower-priority labels). Bitmap-font or canvas
  glyph atlas; no full text engine.
- **Test:** declutter logic (overlap resolution, priority) headless; browser smoke.
- **Demo:** labels on the selected object and its family.

## V9 — 2D map projection mode

- **Scope:** an equirectangular (and later, other) projection of the same scene —
  points, ground tracks, footprints, stations — sharing the mission clock and data,
  so the app can drop the separate deck.gl 2D path. A camera/projection swap, not a
  new data model.
- **Test:** projection round-trip; browser smoke of the 2D scene.
- **Demo:** explore "2D" toggle flipping the same fleet to a map.

## Out of scope (stays in the app)

KPI cards, alert/anomaly semantics, order/approval workflow, the tip→collect→downlink
lifecycle, layout/branding, data binding to the API, the meaning of a colour or a
status. dv.gl provides the mechanism (draw the cone, emit the pick, accumulate
coverage); the app provides the policy (which sensor, what red means, what the panel
shows).
