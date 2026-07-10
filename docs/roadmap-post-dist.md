# dv.gl roadmap — post-DIST (v2, after expert-panel review)

**Status:** agreed plan of record. Supersedes the v1 draft after a 5-seat panel
(mission-ops, WebGPU rendering, library-DX, astrodynamics, independent GTM/gpt-5.5).
Effort key: **S** ≈ ≤1 day, **M** ≈ 2–4 days, **L** ≈ a week+, **XL** ≈ multi-week epic.
Everything rides the composable-`Layer` + DOM-free-`Scene`/`Map2DView` architecture; new
capability is a `Layer` or a `*Source`, never a fork.

---

## 0. Who this is for (the ICP — answered)

**Primary customer: the pdb spacecraft-simulator's own dashboards, replacing Cesium.**
The pain is real and internal: the Cesium dashboards are annoying and not customizable
enough. dv.gl exists to be a dashboard renderer the owner controls end-to-end.

- **Phase 1 use case:** LEO/VLEO **mission analysis**.
- **Phase 2 use case:** **RPO** (rendezvous & proximity ops) and **OSAM** (on-orbit
  servicing / assembly / manufacturing).

**What this means for "adoption"** (this is the panel's #1 concern, resolved by the ICP):
- "Adoption" = **replace Cesium in the pdb viewer**, not external open-source uptake.
- The external-adoption epic (npm publish, `create-dvgl-app`, hosted demo, React example,
  SSR/`navigator.gpu` guards, versioning/changelog) is **DEFERRED, not cancelled** — it
  earns its place only when a *second, external* consumer exists.
- Distribution stays **git-SHA / local tarball** — proven sufficient for one internal
  consumer (D3). No npm publish yet; the supply-chain-wary stance is fine here because
  there is no external trial to unblock.
- The one framework that matters is **SolidJS** (the pdb viewer). D3 already proved the
  embed; Phase 1's #1 is taking that spike to production.

---

## Phase 1 — LEO/VLEO mission analysis (replace Cesium in pdb)

### P1 · Productionize the pdb `<GeometryView>` (D3 → production) — **M**
Take the D3 spike from "renders a static OEM in an isolated page" to "a real Cesium
replacement in the pdb viewer": feed **live pdb run data** (through the existing mission/
run-data path, not a vendored file), wire the pdb **time store + selection store** to the
`Scene` clock + `onPick`, and make it a switchable view alongside (then instead of) the
Cesium `GeometryView`. **This is the real adoption artifact.**
**Exit.** A pdb run renders in dv.gl with working play/scrub/select, fed by live run data;
mounts/disposes cleanly on view switches. **Deps.** D3 (done).

### F1 · BasemapLayer: coastlines + country borders (+ optional land fill) — **M**
Mission analysis needs geography — "where is this pass" must be legible. Vector **Natural
Earth 110m** (public domain), baked to compact ECEF-on-surface polylines, drawn in 3D and
reprojected in the 2D map.
**Panel correction (rendering seat):** `LineRenderer` has **no GMST spin** (`lines.ts:163`)
— ECEF coastlines drawn through it won't rotate with the globe. Add a model/GMST spin
uniform to `LineRenderer` (or a thin earth-fixed variant) so vectors spin without per-frame
CPU rebakes. Bake with **densified long segments** (49th parallel etc. chord *under* the
ellipsoid otherwise) and **pre-split antimeridian** for the 2D path. 110m only; 50m later.
Land fill (earcut → `TriRenderer`) is an optional follow-on, not a blocker.
**Exit.** Continents/borders legible + correctly spinning in 3D and 2D, no FPS regression;
data vendored with provenance. **Deps.** the spin-uniform fix.

### E1 · Event source: AOS/LOS + eclipse/terminator — **M**
**Panel (mission-ops):** a timeline with no events is an empty ruler, and AOS/LOS + eclipse
are the day-one questions of mission analysis — neither exists in `@dvgl/orbits` today
(only live "who's up now" access *lines*). Add a time-indexed **event source**: AOS/LOS
windows per station (bisected rise/set — the geometry already exists in `access.ts`), and
sun/eclipse (subsolar point, umbra/penumbra entry-exit, day/night terminator).
**Exit.** AOS/LOS + eclipse events available as data + a day/night terminator on the globe.
**Deps.** none. **Pairs with C3.**

### C3 · Timeline + marks as a façade surface — **S→M**
Expose `TimelineMarks` as **data** (`setMarks`, `onMarks`, `scrubToMark`/next-prev on the
clock) — host renders its own timeline, façade owns the time-indexing. Fed by **E1** so the
timeline is operationally real, not decorative. **Deps.** E1 for meaningful content.

### C1 · Picking in Map2DView — **S**
CPU nearest-dot pick over the plane coords already computed each frame; `onPick`/`pickAt`
parity with `Scene`. **Panel (rendering):** exclude alpha-0/NaN dots (mirror the tracks
guard), invert the letterbox `sx/sy` + dpr when projecting to screen px. **Deps.** none.

### X1 · SAR look-geometry on collects — **S→M**  *(cross-cutting)*
**Panel (mission-ops):** for an EO+SAR tool the collects layer draws **generic boxes** —
an operator can't tell ascending-right-look from descending-left-look. Add look-side /
incidence-angle shading to the collect footprint. **Deps.** none.

### Deprioritized within Phase 1 (do when the pain is real)
- **C2 · Worker-thread propagation** and **C4 · GPU SGP4 packaging** solve **10k-catalog**
  scale pain. The internal customer is **constellation-scale** (~dozens), so these wait for
  an external big-catalog user. **When built**, heed the rendering seat: `propagateInto` is
  *sync-pull-caller-owned*; worker/GPU sources are *async-push-transferred*. Define an
  explicit **async `PropagationSource`** + a **buffer pool / return handshake** (transfer
  detaches buffers; naïve reuse re-GCs ~120 KB/frame) and decide device ownership up front —
  "consume unchanged" is false.

---

## Phase 2 — RPO / OSAM (relative operations)

RPO/OSAM is about **relative geometry between two spacecraft** — you cannot do it with
points, and it needs a **relative frame**, not cislunar. This raises S1 and adds R1.

### R0 · Read-only proximity viewer vertical slice — **done 2026-07-10**

`apps/proximity-viewer` proves the leaf presentation path with a strict `replay/1.0`
consumer, the deterministic `@dvgl/core` mission clock and phase marks, a target-centered
LVLH/RIC scene, trajectory/corridor/keep-out overlays, inspection controls, and three
generated `gltf-model-builder` visual proxies. The app uses one Three.js WebGL canvas; it
does not interleave WebGL with the dv.gl WebGPU canvas or move viewer state back into any
admission/control path. **Exit.** Desktop/mobile build, replay parser tests, generated-asset
hash manifest, and browser render checks pass.

**Native handoff closure (2026-07-10).** The app now consumes one complete
`rpo_viewer_pack/v1` built from pdb run `pdb_proximity_reference_001` and the
Sublime Kinematics replay. The pack includes hashed gate, chaser/target absolute
ephemerides, relative replay, model tiers, scenes, and policy. A segmented hard
cut switches Absolute ECI and Relative LVLH presentation while both use the same
mission clock; neither mode writes back or propagates replacement truth.

### R0.1 · Promote replay and asset manifests to reusable adapters — **M**

Move the app-local strict `replay/1.0` parser and `dvgl/proximity-assets/0.1` manifest
loader behind reusable packages once the second consumer arrives. Preserve clock-as-data,
visual-only authority, frame/unit validation, and content hashes. **Deps.** R0 plus a second
consumer proving the API shape.

### R0.2 · Attitude, attachment frames, and articulated servicing assets — **M→L**

Consume explicit body attitude and named glTF attachment/joint nodes. Never infer grapple
metrology or collision truth from render meshes. This item depends on the corresponding
asset-pack and robotics export work in `gltf-model-builder`; until then the chaser uses an
explicit viewer-only aim-at pose. **Deps.** S1a and glTF consumer-pack tickets.

**Attitude sub-step done 2026-07-10.** Native pdb NADIR body-to-ECI scalar-last
quaternions now survive SK replay and the viewer pack. The app derives
body-to-LVLH from the target absolute basis and no longer uses an aim-at pose.
The packaged robot mounts through the audited `arm_base` node and now consumes
an SK-produced `robot_joint_trajectory/1.0` rehearsal on the same mission clock.
The viewer binds only audited joint metadata and interpolates absolute named
positions. The current `ready` to `pregrasp` path explicitly excludes capture,
contact, torque, clearance, and hardware evidence; the viewer still invents no
presentation motion.

### S1a · Oriented spacecraft body + body axes — **S**
Instanced body glyph per object oriented by the attitude quaternion; body axes triad.
**Panel (astro) — pin the contract in writing:** quaternion is **scalar-last `[x,y,z,w]`**
(matches pdb `cb86365`), **body→inertial**, and state **WHICH inertial** (TEME vs J2000) —
a body rendered in an ECEF world from a TEME-referenced quaternion is wrong by GMST.
**Deps.** an attitude channel in the source/ephemeris contract.

### S1b · Sensor cones / FOV frustums (incl. SAR look-side) — **M→L**
**Panel (astro):** boresight = body-frame unit vector, **half-angle** (not full), and
Earth-intersection is a **ray / WGS84-ellipsoid** solve (two roots, take the near hit, clamp
to the limb) — a sphere makes footprints walk at high latitude. **Deps.** S1a.

### R1 · Target-relative frame (RIC/LVLH/Hill) + relative viz — **L**  *(RPO enabler)*
A **target-centered** radial-in-track-cross-track / LVLH frame + Clohessy-Wiltshire-style
relative-motion view (chaser trajectory in the target's Hill frame, approach corridors,
proximity geometry). This — not cislunar — is the frame RPO/OSAM actually needs.
**Panel (astro/rendering):** route through an explicit inertial hub; the frame swap touches
the `Scene` world→view + RTE anchor (currently Earth-centered), so treat it as a frame
provider on the `Scene`, not a per-layer hack. **Deps.** S1 (relative attitude/docking).

---

## Phase 3 / opportunistic (gated)

### S2 · Cislunar / multi-body frames — **XL**
No cislunar pain is stated, so this is gated on a **named cislunar demo**. **Panel (astro),
when built:** frame registry = Earth-fixed / Moon-fixed / Earth-Moon **rotating** /
barycentric, **all routed through an explicit J2000/ICRF hub node**; never mix **synodic vs
sidereal** rotating frames; make **normalized-DU vs km** explicit in the source contract;
use a real lunar orientation model (IAU PA/ME). **Validation is not a screenshot:** take a
published CR3BP L2-southern NRHO (Gateway 9:2), assert it **closes** in the synodic frame
and **Jacobi C is conserved** to tolerance, cross-checked against a **SPICE/GMAT** state.

### External-adoption epic — **L** (deferred until a 2nd/external user)
npm publish (scoped, pinned deps, provenance, "experimental API" label) + React example +
hosted live demo + `navigator.gpu` guard/fallback + `create-dvgl-app` + versioning/changelog
+ a store/debounce adapter for the per-frame data callbacks (they'll thrash a consumer's
reactive store otherwise). Only when someone outside pdb wants to integrate.

---

## Engineering contracts carried from the panel (apply at build time)
- **F1:** `LineRenderer` model/GMST spin uniform; bake ECEF-on-surface, densified long
  segments, pre-split antimeridian; 110m first.
- **C2/C4 (deferred):** explicit async push `PropagationSource` + buffer pool; device
  ownership decided up front.
- **S1:** quaternion scalar-last `[x,y,z,w]`, body→inertial, name the inertial; cone =
  boresight body-vector + half-angle + ray/WGS84-ellipsoid intersection.
- **S2:** J2000/ICRF hub; synodic≠sidereal; DU-vs-km explicit; Jacobi-conserved closed NRHO
  validated vs SPICE/GMAT.
- **Cross-cutting:** a store/debounce adapter for per-frame `on*` callbacks (ships with the
  external-adoption epic; document the recipe sooner).

## Non-goals (explicit)
- **Raster imagery / real elevation terrain / LOD tile streaming** — that is a globe engine
  (Cesium's business); dv.gl beat the Cesium-composed path *by not being one*, and orbit/
  RPO viz doesn't need mountains. A Blue Marble texture is the *most* we'd consider, on demand.
- **Three.js single-canvas interleave** — WebGL/WebGPU can't share a canvas; demand-driven,
  stacked-canvas is the cheap fallback.
- **npm publish / external-adoption polish** — deferred (not cancelled) until an external
  consumer exists; the internal pdb consumer uses git-SHA / local tarball.
