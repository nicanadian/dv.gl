# Epic DIST — make dv.gl embeddable (right-sized after panel review)

**Goal:** let a separate app (the pdb SolidJS viewer first) `import` dv.gl and mount
it, without copy-pasting demo code — and without dv.gl becoming a supply-chain risk.

**Panel verdict (build/release, library-DX, supply-chain-security, skeptic):** the
draft was gold-plated. The near-term problem is *not* "run a secure private package
registry"; it's "extract `explore.ts` into a DOM-independent API the viewer can
mount." Registry/OIDC/provenance/SBOM/changesets are **deferred** until a 2nd
consumer or a real release. Distribution for a solo, security-wary owner is a
**git dependency pinned to a commit SHA** — immutable, no credentials to steal, no
registry to run.

---

## Three deliverables (this is the whole epic)

### D1 — `@dvgl/viewer`: a DOM-independent façade  *(the real work)*
The data seam already exists (`PropagationSource`, `parseOem`, `parseCollects`,
`parseCzml`). What's missing is that `explore.ts` is welded to the DOM
(`getElementById`, `window` listeners, a label DOM layer, marks ticks). Extract a
**small `Scene` core** (device + canvas + camera + `MissionClock` + RAF + pick
readback) plus **composable layer instances** — `SatellitesLayer`, `TracksLayer`,
`AccessLayer`, `CollectsLayer`, `CoverageLayer`, `GroundStationsLayer`, `Map2DView`.
`GeometryView` is a preset that wires the default stack. Not a plugin system, not a
builder — one class with `add()/remove()`.

Lifecycle (must never touch `document`/`window`):
- `static async Scene.create({ canvas, device? }): Promise<Scene>`  (accept an injected device)
- `resize(w, h, dpr)`  ·  `start()` / `stop()` (RAF)  ·  `dispose()` (frees GPU objects; `device.destroy()` **only if it created the device**)
- `onPick(cb): () => void`  ·  `attachControls(el): () => void`  (disposers; **no** ambient `window` listeners)

Data (host owns fetching): `setEphemeris(src)`, `setCollects(Collect[])`,
`setStations(Station[])`, or one reactive `setData({ segments?, collects?, stations?, names? })`;
setters idempotent/diffing. Parsers stay pure & separately importable. Labels/marks/
picking surface as **data callbacks**, not DOM writes. Re-export the stable data
types (`Collect`, `Station`, `OemSegment`, `PickHit`, `PropagationSource`) from
`@dvgl/viewer` so consumers never import `@dvgl/orbits` directly.

### D2 — Build one consumable, safe artifact
Build scaffolding mostly exists (`tsc -b` → `dist` with `.js`/`.d.ts`, `exports`
maps, `files:["dist"]`). Fixes:
- A `tsconfig.build.json` that turns **off** `declarationMap`/`sourceMap` (they point
  into `src/`, which `files` excludes → dead refs).
- `"sideEffects": false` (WGSL consts are pure) for tree-shaking.
- `@webgpu/types` → **peerDependency** of `@dvgl/webgpu` (emitted `.d.ts` reference
  ambient `GPUDevice` globals; consumers must install it).
- **Bundle the façade**: `@dvgl/viewer` inlines the first-party `@dvgl/*` workspace
  packages (so there are no `workspace:*` deps a git install can't resolve) while
  keeping `satellite.js` external. This is what makes the git-SHA channel actually
  work. (sgp4.gl WASM is **only** in the bench app, not in any package — the viewer
  needs it only if a consumer wants GPU SGP4; document the loader-takes-a-URL recipe
  for Vite `?url` *and* webpack `new URL(..., import.meta.url)` if/when needed.)
- `pnpm pack --dry-run` and **grep the tarball** for `src/`, `.map`, `.tsbuildinfo`,
  secrets before trusting the allowlist.

### D3 — pdb-viewer integration spike  *(the only proof that matters)*
Consume `@dvgl/viewer` from the pdb viewer via a **pinned git SHA** (or a local
tarball for the first spike), mount it in a `<GeometryView>` SolidJS component, feed
real pdb data, render one representative fleet case, and mount/resize/dispose
cleanly. This is the exit gate — it surfaces the Solid-lifecycle / data-binding /
WASM issues a bench-app dogfood would hide. **Crosses into the viewer thread's lane**
— coordinate or keep it a throwaway spike, don't merge into the viewer unasked.

**Exit gate must be headless/Solid with NO ambient element IDs** — dogfooding only
in the bench app (where every `getElementById` exists) would let DOM assumptions
sneak into the façade and pass.

---

## Security floor (cheap, do now — NOT deferred)
- **`files` allowlist** (already set) + **no `install`/`postinstall` scripts** in any
  package (verify none) — the two highest-value, near-free controls.
- **Distribution = git dependency pinned to a commit SHA.** No publish credential, no
  consumer registry token, immutable. (This is the panel's recommendation for a
  security-wary solo owner over a private registry.)
- **CI hygiene:** SHA-pin GitHub Actions (not `@vN`), minimal workflow `permissions`,
  frozen lockfile, `pnpm` `minimumReleaseAge` (mechanical dependency cooldown),
  `ignore-scripts` in CI.

## Explicitly deferred (until a 2nd consumer or a real release)
GitHub Packages / OIDC trusted publishing / npm provenance / SBOM / Changesets /
formal semver policy / typedoc / an external throwaway consumer / Three.js as a
distribution target. If we ever publish, provenance on a *private* registry is weak —
use **signed git tags + verified commits** as the trust anchor instead.

## Why this is safe (owner's npm-worm worry)
The 2025 npm worms need: a stolen publish token + a malicious install script + fast
downstream uptake. With a **git-SHA dep** there is *no publish token and no registry*;
with **no install scripts** our package can't execute code on `npm install`; with the
**`files` allowlist** no secret ever ships; with **SHA-pinned Actions + cooldown** a
poisoned upstream/Action can't slip in. dv.gl is hard to weaponize and hard to poison.
