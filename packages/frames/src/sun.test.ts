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

import { describe, expect, it } from "vitest";
import { inEclipse, sunEciUnit } from "./sun.js";

/** Solar declination (deg) = asin(z) of the ECI unit vector. */
function declDeg(unixMs: number): number {
  const [, , z] = sunEciUnit(unixMs);
  return (Math.asin(z) * 180) / Math.PI;
}

describe("sunEciUnit", () => {
  it("returns a unit vector", () => {
    const s = sunEciUnit(Date.UTC(2026, 6, 6));
    expect(Math.hypot(s[0], s[1], s[2])).toBeCloseTo(1, 6);
  });

  it("declination ~ +23.4 deg at the June solstice", () => {
    // 2000-06-21 (northern summer solstice)
    expect(declDeg(Date.UTC(2000, 5, 21, 1))).toBeGreaterThan(23.0);
    expect(declDeg(Date.UTC(2000, 5, 21, 1))).toBeLessThan(23.6);
  });

  it("declination ~ -23.4 deg at the December solstice", () => {
    expect(declDeg(Date.UTC(2000, 11, 21, 13))).toBeLessThan(-23.0);
    expect(declDeg(Date.UTC(2000, 11, 21, 13))).toBeGreaterThan(-23.6);
  });

  it("declination ~ 0 deg at the March equinox", () => {
    expect(Math.abs(declDeg(Date.UTC(2000, 2, 20, 7)))).toBeLessThan(0.6);
  });
});

describe("inEclipse", () => {
  const sun: [number, number, number] = [1, 0, 0]; // sun toward +x
  it("sunward side is lit", () => {
    expect(inEclipse([7000, 0, 0], sun)).toBe(false);
  });
  it("anti-solar within a radius is eclipsed", () => {
    expect(inEclipse([-7000, 0, 0], sun)).toBe(true);
  });
  it("anti-solar but far off-axis is lit", () => {
    expect(inEclipse([-7000, 9000, 0], sun)).toBe(false);
  });
});
