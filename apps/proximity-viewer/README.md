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

Set `GLTF_MODEL_BUILDER_DIR` to override that location. The script rebuilds
`public/packs/pdb-native/` as a complete `rpo_viewer_pack/v1` from the native
pdb run and its Sublime Kinematics replay. The pack contains model tiers,
metadata, scene plans, replay, policy, checksums, and a strict visual-only
manifest; the viewer loads only that manifest and its referenced files.

## Boundary

- Replay evidence supplies every relative transform; the viewer does not propagate a
  second trajectory.
- `rpo_viewer_pack/v1` supplies the only replay/model paths and content digests.
- Absolute ECI and relative LVLH modes are a hard presentation cut over the
  same pdb run, gate epoch, and deterministic mission clock.
- Vehicle orientation comes from paired scalar-last pdb body-to-ECI attitude,
  transformed into LVLH from the target absolute basis; no aim-at pose remains.
- Only `skframe/v1`, `LVLH_RIC`, meters, meters/second, and strictly increasing
  replay samples sharing the declared epoch load.
- GLBs are `not_official_model: true` visual proxies.
- Meshes do not define collision, keep-out, approach, attachment, or metrology truth.
- The viewer has no admission, runtime-assurance, controller, actuator, or write-back API.

The app uses one Three.js WebGL canvas for near-field PBR models. It does not interleave
that canvas with dv.gl's WebGPU renderer. `@dvgl/core` supplies deterministic mission time
and timeline indexing.
