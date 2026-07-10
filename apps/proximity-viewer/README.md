# dv.gl Proximity Viewer

Read-only target-relative RPO/OSAM playback over Sublime Kinematics `replay/1.0`
evidence and `gltf-model-builder` visual proxies.

## Run

From the dv.gl repository root:

```bash
pnpm install
pnpm --filter @dvgl/proximity-viewer dev
```

The dev server opens on `http://127.0.0.1:4175`.

## Regenerate Assets

The default checkout layout expects `gltf-model-builder` next to `dv.gl`:

```bash
pnpm --filter @dvgl/proximity-viewer sync-assets
```

Set `GLTF_MODEL_BUILDER_DIR` to override that location. The script:

- runs the sibling `gltf-build generate` command for the servicer, MARMAN client,
  and LEO grapple client recipes;
- retains the GLBs and generated proxy metadata but removes Blender authoring files;
- copies the synthetic V-bar `replay/1.0` fixture;
- writes `dvgl/proximity-assets/0.1` with SHA-256 content hashes.

## Boundary

- Replay evidence supplies every relative transform; the viewer does not propagate a
  second trajectory.
- Only `LVLH_RIC`, meters, meters/second, and strictly increasing replay samples load.
- GLBs are `not_official_model: true` visual proxies.
- Meshes do not define collision, keep-out, approach, attachment, or metrology truth.
- The viewer has no admission, runtime-assurance, controller, actuator, or write-back API.

The app uses one Three.js WebGL canvas for near-field PBR models. It does not interleave
that canvas with dv.gl's WebGPU renderer. `@dvgl/core` supplies deterministic mission time
and timeline indexing.
