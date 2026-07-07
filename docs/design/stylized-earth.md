# Design Note — Stylized ("Mosaic") Earth

Status: **draft for review** · Owner: dv.gl · Date: 2026-07-06

## TL;DR

dv.gl renders the globe with flat, draped vector geometry (earcut land fill,
coastlines, borders) occluded by an analytic **horizon cull** rather than the depth
buffer. That works, but two things pushed us here: flat triangles *chord* below the
sphere, and our data-driven tessellation created *seams* (T-junction cracks). Rather
than chase photoreal imagery (Cesium's game), we propose leaning into a **stylized,
faceted "mosaic" Earth** as dv.gl's signature look — cheaper, distinctive, trivially
customizable, and it makes the flat-facet "limitation" the aesthetic.

The enabling architectural change: build the globe on a **uniform sphere tessellation
(quadsphere / geodesic)** instead of earcut land polygons. Uniform conforming facets
kill chording and seams *by construction*, and the mosaic is then just "color each
facet." A door stays open to screen-space-error imagery tiles later if a customer
demands photoreal.

This note captures the prior art we're (knowingly) retreading, the recommended
architecture, and the open **stylization** questions we want an artist panel to weigh in
on — specifically *how* to give it style and character, and *what* to draw inspiration
from.

---

## 1. Where we are today

- **Basemap**: Natural Earth 110m baked to ECEF km — coastlines + admin-0 borders as
  line-lists, land polygons earcut-triangulated to a triangle-list. GMST-spun in-shader
  so a static Earth-fixed buffer rotates with the globe.
- **Occlusion**: an analytic **horizon cull** in the fragment shader — discard a
  fragment when `dot(worldPos, eye) < R²` (R = 6371 km). Fills and draped lines use it
  and set `depthCompare: "always"`, so a flat triangle chording below the surface still
  renders on the near side and the far hemisphere is hidden at the limb.
- **Precision**: relative-to-eye (RTE) position split (`posHigh`/`posLow`) to survive
  fp32 at Earth scale.
- **Current look**: opaque green land, steel-blue coastlines, near-black borders on a
  dark ocean/space background. Legible, plain.

### Problems that got us here
1. **Chording** — a flat triangle spanning a wide arc dips below the sphere; with a
   depth-writing Earth mesh it was depth-culled, leaving only coasts. (Fixed via horizon
   cull.)
2. **Seams** — our longest-edge tessellation introduced **T-junctions** (a midpoint
   vertex mid-edge on a non-split neighbor → hairline cracks when zoomed). (Fixed by
   reverting to raw earcut, which is conforming — but earcut slivers are a poor mosaic.)

Both are classic *"drape flat vector data on a curved surface"* problems.

---

## 2. Prior art we are (knowingly) retreading

Virtual-globe rendering is a well-mapped field. Two reassuring tells: we independently
reinvented **RTE precision** and **analytic horizon culling**, both textbook. The single
best reference maps 1:1 onto our backlog:

> **Cozzi & Ring, _3D Engine Design for Virtual Globes_ (2011)**, virtualglobebook.com —
> RTE precision, ellipsoid tessellation, horizon culling, logarithmic depth, vector draping.

Techniques mapped to *our* problems:

| Our problem | Field's solution(s) |
|---|---|
| Flat polygons chord the sphere | **Draping**: tessellate-to-curvature, or *image-space* draping (render vectors → texture → project onto terrain, as Cesium does) |
| Seams / T-junctions across LOD | **Skirts** (Cesium terrain), restricted-quadtree edge stitching (Lindstrom–Koller), **CDLOD** morphing (Strugar 2010) |
| How finely to tessellate | **Screen-space error (SSE)**: refine until projected error < N px (Cesium terrain, 3D Tiles spec) |
| Uniform sphere cells | **Quadsphere / cube-sphere** (Google S2; most game planets), **HEALPix** (equal-area, astronomy), Fibonacci-spiral points |
| Terrain LOD at scale | **Geometry clipmaps** (Losasso–Hoppe 2004), **chunked LOD** (Ulrich 2002) |
| Depth fighting near/far | **Logarithmic** or **reversed-Z** depth |
| Atmosphere glow | O'Neil scattering (GPU Gems 2), Bruneton precomputed scattering |

Stylized/planetary game work for the *aesthetic* angle: Outerra, and the procedural-planet
talks from No Man's Sky and Star Citizen (seamless quadsphere LOD, much of it stylized).

**Strategic read.** For LEO/VLEO mission *analysis* (and later RPO/OSAM), streamed
photoreal imagery is a large pipeline for a look we may not want. Higher value: keep the
RTE + horizon-cull spine, adopt a quadsphere substrate (chording/seams gone for free),
and make the **stylized mosaic** the signature — with a documented path to SSE imagery
tiles if ever required.

---

## 3. Recommended architecture

### 3.1 Geometric substrate — quadsphere
Replace the earcut land mesh with a **cube-sphere**: 6 cube faces, each subdivided into
an N×N grid, projected to the ellipsoid. Properties:
- **Conforming** (shared whole edges) → no T-junctions, no seams.
- **Near-uniform facet size** → a good mosaic; predictable LOD later (per-face quadtree).
- Small facets → chord dip is tiny; horizon cull still handles occlusion cleanly.
- Deterministic facet index → stable seed for per-facet styling.

(Alternative: subdivided **icosahedron / geodesic** sphere — more isotropic facets, but
awkward texture params and indexing. Quadsphere wins on tooling/indexing; revisit if the
art direction wants the "geodesic dome" triangle look specifically.)

### 3.2 Fill model — `MosaicEarthLayer`
Per facet:
- Sample a **land/ocean mask** at the facet centroid (bake a low-res mask, or point-in-
  polygon against Natural Earth land) → base palette (land vs sea, maybe elevation/biome
  bands later).
- Apply **deterministic per-facet jitter** (index-seeded hue/value wobble) so adjacent
  facets read as distinct tiles — the low-poly "cut" look.
- **Flat per-facet shading** (`flat` interpolation) + a per-facet normal so a configurable
  sun direction catches facets → gemstone/faceted feel, optional day/night terminator
  shading for free.
- Everything is **shader uniforms** (palette, jitter amount, sun dir, facet density) →
  "customize as much as I please."

### 3.3 Optional imagery mode (later, gated)
Same mesh, different fill source: sample real imagery (e.g. Landsat/Blue Marble) per
facet and **posterize/quantize** → a photo-mosaic that's still stylized. Strict superset
of the palette mode; a natural bridge toward SSE-tiled photoreal if a customer needs it.

### 3.4 What stays
RTE precision, GMST spin, horizon cull, the coast/border **line overlays** (they still
add legibility on top of the mosaic — "where is this?"), 2D `Map2DView` peer.

---

## 4. Open questions for the artist panel

We can build the machinery; we want taste on the *look*. Specifically:

1. **Style & character** — how do you take a faceted globe from "flat and technical" to
   something with intent and personality? Palette strategy, facet density, lighting,
   edge treatment (wireframe? bevel? none?), motion/idle life, atmosphere.
2. **Inspirations** — what references would you reach for? (Low-poly art movements,
   cartographic traditions, sci-fi/mission-ops "FUI", game planets, physical materials —
   ceramics, stained glass, terrazzo, topographic models…)
3. **Legibility vs. beauty** — this is an *analysis* tool first. Where's the line between
   stylization and hurting an operator's ability to read geography, day/night, coverage,
   and tasking overlays?
4. **Coherence with overlays** — orbits, footprints, field-of-regard, stations, labels,
   selection highlight all sit on top. What palette/value strategy keeps the mosaic from
   fighting the data?
5. **Customization surface** — which knobs should be first-class (themeable) vs. fixed to
   protect the brand?

---

## 5. Rough roadmap

1. **Spike** — `MosaicEarthLayer` prototype: quadsphere + land mask + seeded facet jitter
   + flat shading, wired into the bench. Look-test only. (~1 day)
2. **Art pass** — apply panel direction: palette(s), lighting, edge treatment, atmosphere.
3. **Legibility pass** — verify overlays (orbits/footprints/labels) read cleanly on the
   mosaic; tune values.
4. **Theme surface** — expose the customization knobs; ship 2–3 built-in themes.
5. **(Gated)** imagery/posterized mode; **(gated)** per-face quadtree LOD + SSE if scale
   demands.

---

## Appendix — references
- Cozzi & Ring, *3D Engine Design for Virtual Globes* (2011).
- Losasso & Hoppe, *Geometry Clipmaps* (SIGGRAPH 2004).
- Ulrich, *Rendering Massive Terrains using Chunked LOD* (2002).
- Strugar, *Continuous Distance-Dependent LOD (CDLOD)* (2010).
- Lindstrom & Koller et al., real-time continuous LOD terrain (1996).
- Google **S2 Geometry** (cube-sphere + Hilbert indexing); **HEALPix** (equal-area sphere).
- O'Neil, *Accurate Atmospheric Scattering* (GPU Gems 2); Bruneton precomputed scattering.
- OGC **3D Tiles** / Cesium **quantized-mesh** terrain format.
</content>
