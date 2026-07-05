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
 * Greenwich Mean Sidereal Time, IAU 1982 model (Vallado, "Fundamentals of
 * Astrodynamics and Applications", eq. 3-47) -- the same model SGP4 tooling uses,
 * so TEME->ECEF here is consistent with the propagation stack.
 *
 * Approximation, documented: UT1 is taken equal to UTC (|UT1-UTC| < 0.9 s by
 * definition), which bounds the rotation error below ~0.9 s * 15"/s ~ 14 arcsec
 * -- about 470 m at GEO radius, well inside the fp32 propagation error budget
 * already published for the visualization pipeline. Earth-orientation corrections
 * (polar motion, dUT1) are v0.1+ work behind this same API.
 */

const TWO_PI = 2 * Math.PI;

/** Julian date from Unix epoch milliseconds. */
export function unixMsToJulianDate(unixMs: number): number {
  return unixMs / 86_400_000 + 2_440_587.5;
}

/** GMST in radians, [0, 2pi), for a UTC time given as Unix ms (UT1~=UTC). */
export function gmst(unixMs: number): number {
  const jd = unixMsToJulianDate(unixMs);
  // split JD at 0h for numerical behavior matching the reference formulation
  const jd0 = Math.floor(jd - 0.5) + 0.5;
  const tut1 = (jd0 - 2_451_545.0) / 36_525.0;
  // GMST at 0h UT1, seconds (IAU 1982)
  let seconds =
    67_310.54841 +
    (876_600.0 * 3600 + 8_640_184.812866) * tut1 +
    0.093104 * tut1 * tut1 -
    6.2e-6 * tut1 * tut1 * tut1;
  // advance by the elapsed fraction of the day at the sidereal rate
  const dayFrac = jd - jd0; // days since 0h
  seconds += dayFrac * 86_400 * 1.00273790934;
  const rad = ((seconds % 86_400) / 86_400) * TWO_PI;
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI;
}
