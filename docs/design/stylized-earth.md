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


---

# Artist Panel Review (2026-07-06)

*8-panelist artist-weighted review of this note. Verdict: unanimous build; primary correction: invert the value budget — mute the Earth, saturate the data.*


*8 panelists · weighted toward art direction, cartographic craft, and mission-ops legibility · synthesized for the product owner*

## 1. Verdict

**Unanimous yes — build the faceted mosaic.** All 8 panelists endorse the direction, and for the same strategic reason: fighting Cesium on photoreal is a losing game, and turning your two "bugs" (chording + seams) into a signature is the honest, cheap, brand-defining move. The rendering engineer confirms every knob is already a shader uniform; the creative director calls it "the honest register — this is a simulation, not a photograph."

**The near-unanimous course-correction:** the design note has the value budget *inverted*. The note flirts with "gemstone / faceted / jewel" and proposes **index-seeded hue/value jitter** — and 7 of 8 panelists push back hard on both. The refrain (art director, dataviz, creative director, cartographer): *make the Earth the quietest, lowest-chroma object on screen; spend all saturation on the data.* The dataviz designer flags two §3.2 proposals as "actively dangerous": seeded hue jitter (reads as coverage data) and flat per-facet sun shading (staircases the terminator).

**Lone genuine dissent is about intensity, not direction:** the FUI/motion designer wants *more* life (idle shimmer, terminator scanline, glowing graticule), where the cartographer and dataviz designer want the globe near-still and silent. Resolvable by theme layering (see §6).

## 2. Art directions on the table

The panel's ideas cluster into **three coherent, nameable directions** plus one shared bold bet.

### A. "Shaded-relief cartographic" — *the consensus default*
Backed most strongly by: **cartographic-designer, dataviz-designer, art-director, creative-director, lowpoly-3d-artist** (5 of 8, the panel's center of gravity).

- **Palette:** low-chroma hypsometric ramps, not kelly-green. Ocean a desaturated bathymetric ramp (abyssal near-black indigo `#0b1a28`/`#0C1826` → shelf slate-teal `#1f4a5c`); land a muted Imhof ramp lowland olive-khaki → upland taupe → pale grey-violet peaks (`#3e4a34 → #6b6455 → #9aa0ad`). Chroma capped ~35-40%.
- **Lighting:** one Imhof upper-left key sun; **aerial perspective** — sunlit facets shift *warm*, shadowed facets shift *cool* (not merely darker), contrast reduced toward the limb so the sphere recedes.
- **Edge:** **grout, not wireframe** — a thin ambient-occlusion seam darkening (<10% local contrast) like raking light in a plaster relief model. No line layer to fight borders.
- **Inspirations:** Eduard Imhof (*Cartographic Relief Presentation*), Tom Patterson (Natural Earth II/III cross-blended hypsometric tints), Heinrich Berann (atmospheric globe recession), Karl Wenschow (physical plaster relief), Stamen Toner (the near-monochrome "ops" sibling theme).
- **Why it wins:** it makes geography read by *value* (colorblind-safe, projector-safe) and leaves the entire saturated register free for overlays.

### B. "Cloisonné / cut-enamel instrument" — *the signature material read*
Backed by: **technical-artist, rendering-engineer, lowpoly-3d-artist, fui-motion-designer** (the "make the facet a *material*" camp).

- **Palette:** same muted hypsometric base, but jitter handled in **OKLab** (rendering engineer's hard requirement — RGB wobble muddies to grey and reads as z-fighting). The engineer's specific split: allow small **hue** jitter (±6-10°), lock **value** (±3%); the artists invert to value-jitter — see §6.
- **Lighting:** flat per-facet normals catching one sun = "faceted crystal" for ~5 shader instructions. Matte land (ceramic/slate), **one specular ocean glint** that sweeps with GMST = your entire "idle life" for free, no vertex animation.
- **Edge:** cloisonné "leading" — a thin dark seam between enamel tiles, done single-pass via `fwidth()` on facet-id (NOT duplicated barycentric geometry, which triples vertex count). Optional sun-facing bevel catch-light on lit edges.
- **Atmosphere:** analytic **fresnel limb ring** (`pow(1-NdotV, k)`), cool cyan, a few ALU ops — explicitly *not* O'Neil/Bruneton scattering, which the engineer flags as a real precompute+LUT sub-project, not an art toggle.
- **Inspirations:** Cloisonné enamel / Byzantine Ravenna gold-ground mosaic, Edo Kiriko cut crystal, Gothic stained glass (Chartres blue), Tiffany favrile / celadon glaze, Timothy J. Reynolds (Turnislefthome) low-poly, Monument Valley (ustwo). The engineer calls a single-fragment-pass version of this "dv.gl's signature — prototypable in a day."

### C. "FUI live-globe / mission-ops" — *the sci-fi theme, not the default*
Backed by: **fui-motion-designer** (lead), with the value-hierarchy discipline endorsed by **technical-artist, creative-director, rendering-engineer**.

- **Palette:** cold, dark, desaturated Earth so data can be hot. Ocean near-black indigo, land dust-grey-green. Cyan `#38E1FF`, amber `#FFB020`, hot magenta reserved *strictly* for overlays — the Earth never uses them.
- **Motion budget:** three sub-liminal loops — GMST spin, a ~0.02Hz ocean value shimmer, and a **terminator scanline** (a 2-3 facet band of elevated brightness sweeping the day/night line). All ≤5% amplitude, ≤0.05Hz.
- **Extras:** doubled/offset glowing limb edges (Blade Runner 2049 "instrument bezel"), an optional 8%-opacity graticule and 4% CRT scanline post-pass — **shipped OFF by default.**
- **Inspirations:** Territory Studio (The Martian, Blade Runner 2049, The Expanse), GMUNK (Tron: Legacy, Oblivion), Homeworld sensor manager, NORAD plotting boards, NASA Eyes.
- **Caveat from its own author:** "over-designed FUI soup is a real failure mode — ship a restrained default and put the maximal sci-fi look behind an explicit theme toggle."

### The shared bold bet (raised independently by 6 panelists)
**Make the facet grid a data substrate, not decoration.** art-director, cartographic-designer, dataviz-designer, fui-motion-designer, lowpoly-3d-artist, and creative-director *all* converged on this unprompted: because every facet has a deterministic ID and (near-)equal area, the same tessellation that draws the mosaic can be recolored to encode **coverage %, revisit count, access minutes, tasking heat, or FOR wash** — a choropleth painted directly on the globe's own tiles. Flip a theme, the stylized Earth *becomes* the coverage analysis. Several note this pushes toward **HEALPix / H3 / S2 equal-area cells** over the plain cube-sphere so the encoding is quantitatively honest. This is the payoff that justifies the whole quadsphere bet — "a cartographic capability Cesium's photoreal globe structurally cannot offer."

## 3. Inspiration board (highest-signal, grouped)

**Cartographic tradition** *(the panel's most-cited cluster — 6 of 8 name Imhof)*
- **Eduard Imhof, *Cartographic Relief Presentation*** — *steal:* low-chroma hypsometric tints (value carries elevation, hue barely moves), aerial perspective (desaturate + cool toward the limb), warm-light/cool-shadow, the ban on saturated hues on terrain, upper-left key convention.
- **Tom Patterson — Natural Earth II/III, cross-blended hypsometric tints** — *steal:* a vetted, ready-made muted land/sea ramp as your default "Cartographic" theme; cross-blending so biome and elevation mix instead of banding.
- **Heinrich Berann** — *steal:* atmospheric depth and warm/cool recession on a globe.
- **Stamen Toner** — *steal:* the north-star for the extreme "ops" mode where the basemap recedes to grey and all color is data.

**Sci-fi / mission FUI** *(the value-hierarchy authority — 6 of 8 cite Territory Studio)*
- **Territory Studio (The Martian, Blade Runner 2049, The Expanse)** — *steal:* near-black substrate, one or two accent hues carrying all information, thin glowing hairlines, the map always subordinate to the numbers. This is the color-budgeting argument for keeping Earth muted.
- **GMUNK (Tron: Legacy, Oblivion), NASA Eyes, Homeworld** — *steal:* "battlefield is grey, units glow" value hierarchy; doubled glowing limb edges as an instrument bezel.
- **Eleanor Lutz — *Atlas of Space*** — *steal:* map + data sharing one harmonious palette so overlays feel designed *with* the globe.

**Low-poly / faceted art**
- **Timothy J. Reynolds (Turnislefthome)** — *steal:* disciplined ~6-color palette, soft key light, the rule that adjacent facets differ in hue but barely in value.
- **Kurzgesagt** — *steal (with caution):* proof that flat shading + value-jitter reads as intentional; but also the panel's cautionary tale ("toy planet" is the failure mode).
- **Monument Valley / Alto's Odyssey** — *steal:* premium-from-restraint; flat-matte over glossy, confidence over detail.

**Physical materials**
- **Cloisonné enamel / Byzantine mosaic** — *steal:* thin warm-metal leading between jewel cells; jewel *value*, not jewel *hue*. Structurally identical to your problem.
- **Edo Kiriko cut crystal, Gothic stained glass, terrazzo, celadon glaze** — *steal:* beveled-edge read, grout logic, the "each tile subtly its own while the whole stays one fired surface."
- **Karl Wenschow / USGS plaster relief models** — *steal:* seam-shadow grout under raking light; matte chalky material that justifies facets as *material*, not data.

**Data-viz rigor** (the guardrail references)
- **Giorgia Lupi (Data Humanism)** — every mark earns its variation by meaning something (the antidote to seeded jitter).
- **Cynthia Brewer / ColorBrewer** — perceptually ordered, colorblind-safe ramps for both the muted base tints and the categorical overlay colors.

## 4. Legibility guardrails (non-negotiables)

These recurred across nearly every review and should be locked as **brand rules the theme system cannot violate**:

1. **Value/chroma budget is the whole game.** Hold the entire globe (day *and* night) in a compressed low-mid luminance band (~0.10-0.45) and low chroma. Reserve the top ~30% of the value range and all high saturation exclusively for overlays. Rule of thumb (dataviz + rendering eng): *nothing on the basemap may be more saturated or higher-contrast than the least-important item in the data layer.* Squint test: drop a magenta footprint + cyan track and read both, or the globe is too loud.
2. **Land/ocean must separate by VALUE, not just hue** — protects colorblind operators and projector contrast.
3. **Kill hue jitter in the default theme.** Cap any per-facet variation below the hue JND; keep it value-only and low-frequency (±2-6%), so tiles read as "cut" not as false biome/coverage signal. Jitter must **never cross the coastline** and never correlate with geography. (See §6 — the one place the panel splits on hue vs. value.)
4. **Do not flat-shade the terminator.** The day/night line is the single most important geo-temporal cue for tasking/eclipse; per-facet quantization staircases it. Use a **smooth per-fragment sun-dot** for the day/night ramp; let faceting contribute only faint relief/specular.
5. **Never render the night side black.** Floor it to a cool twilight indigo (`~#0A1420`/`#10161f`) so AOIs, coastlines, and overlays on the dark hemisphere stay legible.
6. **Coastlines/borders stay as dedicated line overlays, always on, every theme.** Grout is texture; the vector lines are truth and answer "where exactly is this?" Promote them from steel-blue to a warm desaturated brass so they read as cartographic ink, not another data layer.
7. **Coastline recognizability caps facet coarseness.** Density gated by the "can you still name the continent?" test at LEO/VLEO zoom (~2-4° cells, cube N≈32-48). Fade seam/jitter to zero once a facet projects below ~4px so the full-disk view never dithers into noise.
8. **Idle motion is opt-out and amplitude-clamped** — sub-liminal, and disabled under `prefers-reduced-motion` (motion sensitivity + it reads as an alert in an ops context).

## 5. Recommended path

**Prototype Direction A ("Shaded-relief cartographic") as the default, rendered with Direction B's cloisonné *machinery*.** This is where the panel's weight sits and it's the lowest-risk, highest-credibility read for an aerospace-analysis customer. Concretely, build the rendering engineer's single-fragment-pass "cloisonné enamel" spike but skinned with Imhof/Patterson hypsometric tints instead of gemstone hues:

- Quadsphere + land/ocean mask + OKLab hypsometric ramp (quantized 4-5 bands)
- Flat per-facet normals for facet read, but a **smooth per-fragment sun-dot** for the terminator (respect guardrail #4)
- `fwidth()`-on-facet-id grout seam (no geometry cost, clamp width by NdotV to stop limb flicker)
- Matte land / one specular ocean glint tracking the subsolar point
- Analytic fresnel limb ring — **not** scattering
- Night-side indigo floor; coast/border lines promoted to brass, always on

The engineer's estimate: prototypable on the current quadsphere spike in ~a day. If the enamel read survives at LEO altitude and the limb, that's dv.gl's signature.

**Concrete knobs to expose as first-class themeable uniforms:**
- **The palette LUT itself** — the technical-artist's biggest product idea: drive the *entire* planet from one 256px 1D gradient strip so a customer restyles their branded Earth by swapping a single ramp ("planet as a gradient").
- Facet density (cells per cube face) · jitter amplitude (default low, hard cap enforced) · sun mode (real subsolar vs. free) · night-floor luminance · grout contrast · limb intensity/hue · idle-motion on/off.

**Keep fixed (brand-protected):** the value-budget separation (globe muted, overlays saturated), hue-jitter cap, terminator-as-smooth-ramp, always-on coast/border lines, and a **reserved alert-color channel** (red/amber for violations) that never appears in any basemap theme.

**Tie to the product roadmap:** for LEO/VLEO coverage analysis the default cartographic mosaic is a quiet, legible stage. The real strategic unlock is the **data-substrate mode** (§2 bold bet): the same equal-area facets recolored to coverage/revisit/access heat — the "mosaic limitation" *becomes* the coverage answer. As dv.gl moves toward **RPO/OSAM**, the creative director's warning matters most there: glossy jewels and moving speculars read as decoration and fight overlays in close-proximity work — hence *matte relief-map instrument*, not *gemstone*. Ship the FUI live-globe (Direction C) as an explicit "mission-ops" theme toggle, never the baseline.

## 6. Disagreements worth noting

1. **Hue jitter vs. value jitter — the panel's one real technical split.** The **rendering engineer** argues (from OKLab math) that *hue* should carry the per-tile variation (±6-10°) while *value* stays locked, because value-jitter reads as z-fighting/broken tessellation. Every *artist and cartographer* argues the exact opposite: *value*-only jitter (±3-5%), hue locked, because hue-jitter reads as fake biome/coverage data to an operator. **Resolution for the PM:** the artists win for an analysis tool (false-data risk > z-fight risk), but the engineer's underlying point — *do the math in OKLab, not RGB* — is non-negotiable regardless of which channel you jitter. Prototype both in the sandbox and A/B against a live overlay scene.

2. **How much idle life.** The **FUI/motion designer** wants shimmer, terminator scanlines, and glowing graticules to make the instrument "breathe"; the **cartographer, dataviz, and creative director** want the globe near-still ("let the data move, not the map"). Resolvable by theme: restrained/still default, motion behind the mission-ops toggle, everything under `prefers-reduced-motion`.

3. **Cube-sphere vs. equal-area (HEALPix/H3/S2).** The note commits to a plain quadsphere for tooling/indexing. Three panelists (**cartographer, lowpoly, art-director**) warn its facets bloat at the 8 cube corners and read as false density — a cartographer "will not tolerate it" — and push for equal-area cells, *especially* because that's what makes the data-substrate choropleth honest. Counter-tension: the rendering engineer and the roadmap both flag equal-area + per-face LOD as the biggest hidden engineering cost. **Recommendation:** ship the cube-sphere for the look-test spike (suppress seam contrast where facet area shrinks as a stopgap), but scope HEALPix/H3 as a *gated* follow-on tied explicitly to the data-substrate feature — or, as several warned, the "honest data" win never ships.

4. **"Gemstone" as a word.** The note's "gemstone/jewel/faceted" framing is endorsed by the technical-artist (as a hero theme, sandboxed and A/B'd hard) but explicitly rejected by the creative director and art director as the *emotional target* — "glossy jewels read as decoration, their speculars fight overlays, the brand skews toy." The safe synthesis the panel converges on: **matte cloisonné/relief instrument** as the noun, gemstone glint as a *restrained accent on ocean facets only*.