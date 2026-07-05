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

/**
 * Which side of the ground track the sensor looks. "both" straddles nadir (an
 * agile EO field-of-regard band); "right"/"left" is one side (a SAR access strip).
 * Right/left are defined in the VELOCITY frame -- so the strip automatically
 * lands on the correct geographic side on ascending vs descending passes, which
 * a fixed-longitude offset would get wrong for half of every orbit.
 */
export type SwathSide = "left" | "right" | "both";

export interface SwathOptions {
  readonly side: SwathSide;
  /** Near-edge off-nadir angle (deg). Ignored for "both" (straddles nadir). */
  readonly innerOffNadirDeg: number;
  /** Far-edge off-nadir angle (deg). For "both" this is the +/- half-width. */
  readonly outerOffNadirDeg: number;
  /** Along-track half-extent as a central angle (deg). Default 3. */
  readonly alongHalfDeg?: number;
  /** Samples along each edge. Default 12. */
  readonly segments?: number;
  readonly bumpKm?: number;
}

/**
 * Near and far ground edges (each `segments` points, km, stride 3, same frame as
 * inputs) of a sensor's instantaneous ground swath. The satellite looks off-nadir
 * by the given angles, on the chosen side of the velocity vector; each off-nadir
 * angle projects to a ground central angle via the curvature-aware footprint
 * formula (horizon-clamped). The caller fills the ribbon between near[] and far[].
 *
 * dv.gl gives the geometry; the app owns which angles/side each sensor uses
 * (SAR incidence band one side; EO field of regard straddling nadir) and what the
 * swath MEANS (instantaneous footprint vs access envelope).
 */
export function sensorSwathEdges(
  satKm: readonly [number, number, number],
  velKm: readonly [number, number, number],
  opts: SwathOptions,
): { near: Float32Array; far: Float32Array } {
  const segments = opts.segments ?? 12;
  const rad = EARTH_R_KM + (opts.bumpKm ?? 6);
  const rSat = Math.hypot(satKm[0], satKm[1], satKm[2]) || 1;
  const rHat: [number, number, number] = [satKm[0] / rSat, satKm[1] / rSat, satKm[2] / rSat];
  // along-track = velocity projected into the local horizontal, normalized
  const vDotR = velKm[0] * rHat[0] + velKm[1] * rHat[1] + velKm[2] * rHat[2];
  const aHat = normalize([
    velKm[0] - vDotR * rHat[0],
    velKm[1] - vDotR * rHat[1],
    velKm[2] - vDotR * rHat[2],
  ]);
  // cross-track "right of velocity" = along x nadir
  const cHat = normalize(cross(aHat, rHat));

  const lambda = (offNadirDeg: number): number =>
    footprintCentralAngleRad(rSat, Math.abs(offNadirDeg)) * Math.sign(offNadirDeg || 1);
  const sideSign = opts.side === "left" ? -1 : 1;
  const [aNear, aFar] =
    opts.side === "both"
      ? [lambda(-opts.outerOffNadirDeg), lambda(opts.outerOffNadirDeg)]
      : [lambda(sideSign * opts.innerOffNadirDeg), lambda(sideSign * opts.outerOffNadirDeg)];
  const alongHalf = ((opts.alongHalfDeg ?? 3) * Math.PI) / 180;

  const edge = (alphaCross: number): Float32Array => {
    const out = new Float32Array(segments * 3);
    const ca = Math.cos(alphaCross);
    const sa = Math.sin(alphaCross);
    for (let i = 0; i < segments; i += 1) {
      const beta = -alongHalf + (segments > 1 ? (i / (segments - 1)) * 2 * alongHalf : 0);
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      // rotate nadir toward the cross side by alphaCross, then along-track by beta
      for (let c = 0; c < 3; c += 1) {
        const d1 = ca * (rHat[c] ?? 0) + sa * (cHat[c] ?? 0);
        out[i * 3 + c] = (cb * d1 + sb * (aHat[c] ?? 0)) * rad;
      }
    }
    return out;
  };
  return { near: edge(aNear), far: edge(aFar) };
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
