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
 * Frame transforms for the visualization pipeline. TEME->ECEF is the GMST
 * rotation about Z (no polar motion -- see gmst.ts for the stated error budget);
 * ECEF->geodetic is WGS84 via Bowring's method. Batch functions write into
 * caller-owned buffers and allocate nothing, matching the hot-path discipline.
 */
import { gmst } from "./gmst.js";

export const WGS84_A_KM = 6378.137;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * Rotate packed TEME positions (km, stride 3) into ECEF at the given absolute
 * time. `out` may alias `positions` for in-place rotation. Non-finite entries
 * pass through unchanged.
 */
export function temeToEcef(
  positions: Float32Array,
  count: number,
  unixMs: number,
  out: Float32Array,
): void {
  if (out.length < count * 3 || positions.length < count * 3) {
    throw new Error(`buffers too small for count ${count}`);
  }
  const theta = gmst(unixMs);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let k = 0; k < count; k += 1) {
    const i = k * 3;
    const x = positions[i] ?? Number.NaN;
    const y = positions[i + 1] ?? Number.NaN;
    if (!Number.isFinite(x)) {
      out[i] = positions[i] ?? Number.NaN;
      out[i + 1] = positions[i + 1] ?? Number.NaN;
      out[i + 2] = positions[i + 2] ?? Number.NaN;
      continue;
    }
    // ECEF = Rz(gmst) * TEME
    out[i] = c * x + s * y;
    out[i + 1] = -s * x + c * y;
    out[i + 2] = positions[i + 2] ?? Number.NaN;
  }
}

export interface Geodetic {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly heightKm: number;
}

/** ECEF (km) to WGS84 geodetic via Bowring's method (single iteration). */
export function ecefToGeodetic(xKm: number, yKm: number, zKm: number): Geodetic {
  const a = WGS84_A_KM;
  const b = a * (1 - WGS84_F);
  const e2 = WGS84_E2;
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(xKm, yKm);
  const lon = Math.atan2(yKm, xKm);
  if (p < 1e-9) {
    // on the polar axis
    const lat = zKm >= 0 ? 90 : -90;
    return { latDeg: lat, lonDeg: 0, heightKm: Math.abs(zKm) - b };
  }
  const beta = Math.atan2(a * zKm, b * p);
  const sb = Math.sin(beta);
  const cb = Math.cos(beta);
  const lat = Math.atan2(zKm + ep2 * b * sb * sb * sb, p - e2 * a * cb * cb * cb);
  const sl = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sl * sl);
  const height = p / Math.cos(lat) - n;
  return {
    latDeg: (lat * 180) / Math.PI,
    lonDeg: (lon * 180) / Math.PI,
    heightKm: height,
  };
}
