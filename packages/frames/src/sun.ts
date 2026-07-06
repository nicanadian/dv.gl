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

import { unixMsToJulianDate } from "./gmst.js";

const DEG = Math.PI / 180;

/**
 * Geocentric unit vector to the Sun in the Earth-centered inertial (mean equator of
 * date, TEME-compatible for viz) frame. Low-precision analytical model (Vallado /
 * NREL, ~0.01° over this century) — a day/night terminator and eclipse geometry, not
 * an ephemeris. Returns a unit `[x, y, z]`.
 */
export function sunEciUnit(unixMs: number): [number, number, number] {
  const n = unixMsToJulianDate(unixMs) - 2_451_545.0; // days since J2000.0
  const L = (280.46 + 0.985_647_4 * n) * DEG; // mean longitude
  const g = (357.528 + 0.985_600_3 * n) * DEG; // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic lon
  const eps = (23.439 - 0.000_000_4 * n) * DEG; // obliquity
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  return [cl, Math.cos(eps) * sl, Math.sin(eps) * sl];
}

/**
 * True when a satellite at ECI position `posKm` is in Earth's umbra (cylindrical
 * shadow model): behind Earth relative to the Sun and within one Earth radius of the
 * anti-solar axis. `sunHat` is the unit Sun direction (from `sunEciUnit`).
 */
export function inEclipse(
  posKm: readonly [number, number, number],
  sunHat: readonly [number, number, number],
  earthRadiusKm = 6371.0088,
): boolean {
  const along = posKm[0] * sunHat[0] + posKm[1] * sunHat[1] + posKm[2] * sunHat[2];
  if (along >= 0) return false; // sunward side is always lit
  // perpendicular distance from the Earth-Sun (anti-solar) axis
  const px = posKm[0] - along * sunHat[0];
  const py = posKm[1] - along * sunHat[1];
  const pz = posKm[2] - along * sunHat[2];
  return Math.hypot(px, py, pz) < earthRadiusKm;
}
