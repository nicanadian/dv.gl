/*
 * Copyright 2026 nicanadian
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Sensor ground footprint geometry: the circle a nadir-pointing conical sensor of
 * a given half-angle projects onto the Earth, and its ring of points on the
 * surface. Frame-agnostic -- the footprint is a small circle on a sphere centred
 * on the sub-satellite direction, so the same ring sits on the globe whether the
 * input position is inertial or ECEF (the sphere is rotationally symmetric).
 *
 * The app owns which sensor and what a footprint MEANS (tasked vs opportunistic,
 * on/off, colour); dv.gl computes the geometry.
 */

const EARTH_R_KM = 6371.0088; // mean radius; footprints are a visualization approx

/**
 * Earth-central half-angle (radians) of the footprint of a sensor at radius
 * `rSatKm` with nadir half-angle `halfAngleDeg`. If the cone reaches past the
 * limb, it clamps to the horizon (the largest footprint the geometry allows).
 */
export function footprintCentralAngleRad(rSatKm: number, halfAngleDeg: number): number {
  const R = EARTH_R_KM;
  if (rSatKm <= R) return 0;
  const eta = (halfAngleDeg * Math.PI) / 180;
  const horizon = Math.acos(R / rSatKm); // central angle to the visible limb
  const s = (rSatKm / R) * Math.sin(eta);
  if (s >= 1) return horizon; // cone misses the surface -> full visible cap
  // triangle (Earth centre, satellite, ground point): central angle
  const lambda = Math.asin(s) - eta;
  return Math.min(Math.max(lambda, 0), horizon);
}

/**
 * Ring of `segments` surface points (km, stride 3, same frame as `satKm`) around
 * the sub-satellite point at the footprint's central angle, lifted `bumpKm` above
 * the sphere. Caller closes the loop. Degenerate (zero-radius) footprints return
 * all points at the sub-satellite point.
 */
export function footprintRing(
  satKm: readonly [number, number, number],
  halfAngleDeg: number,
  segments = 48,
  bumpKm = 6,
): Float32Array {
  const r = Math.hypot(satKm[0], satKm[1], satKm[2]) || 1;
  const u: [number, number, number] = [satKm[0] / r, satKm[1] / r, satKm[2] / r];
  const lambda = footprintCentralAngleRad(r, halfAngleDeg);
  // two tangent basis vectors orthogonal to u
  const ref: [number, number, number] = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(u, ref));
  const e2 = cross(u, e1);
  const rad = EARTH_R_KM + bumpKm;
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const out = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i += 1) {
    const phi = (i / segments) * 2 * Math.PI;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let c = 0; c < 3; c += 1) {
      const dir = cl * (u[c] ?? 0) + sl * (cp * (e1[c] ?? 0) + sp * (e2[c] ?? 0));
      out[i * 3 + c] = dir * rad;
    }
  }
  return out;
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
