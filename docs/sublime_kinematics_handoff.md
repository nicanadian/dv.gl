# Sublime Kinematics Visualization Handoff

Status: acknowledged and implemented for WP-SP-6.3 on 2026-07-10.

dv.gl is an optional, read-only sink for pdb absolute tracks and Sublime
Kinematics relative replay evidence. It has no admission, runtime-assurance,
controller, actuator, or write-back API.

## Interface status

| Requirement | Status | Evidence |
|---|---|---|
| DVGL-1: far-field absolute tracks | implemented | `@dvgl/czml` consumes the strict pdb CZML subset; pdb's `GeometryView` uses dv.gl for live mission-run playback |
| DVGL-2: zero execution authority | implemented | the proximity asset manifest requires `authority: visual_only`; the app exposes inspection and playback only |
| DVGL-3: relative frame, units, and epoch | implemented for the RPO vertical | the replay parser requires `replay/1.0`, `skframe/v1`, `LVLH_RIC`, meters, meters/second, a valid epoch, first sample at epoch, and strictly increasing timestamps |

`apps/proximity-viewer` is the first near-field presentation vertical. Its
relative transforms come only from replay evidence; it does not propagate a
replacement trajectory. glTF meshes are visual proxies and cannot define
collision, keep-out, approach, attachment, or metrology truth.
