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
import { footprintCentralAngleRad, footprintRing } from "./footprint.js";

describe("footprintCentralAngleRad", () => {
  const rSat = 6371.0088 + 550; // 550 km altitude

  it("grows with half-angle and is zero at nadir", () => {
    expect(footprintCentralAngleRad(rSat, 0)).toBeCloseTo(0, 6);
    const a10 = footprintCentralAngleRad(rSat, 10);
    const a30 = footprintCentralAngleRad(rSat, 30);
    expect(a10).toBeGreaterThan(0);
    expect(a30).toBeGreaterThan(a10);
  });

  it("clamps to the visible horizon when the cone misses the limb", () => {
    const horizon = Math.acos(6371.0088 / rSat);
    // an 89deg half-angle cone from LEO overshoots the limb -> clamp
    expect(footprintCentralAngleRad(rSat, 89)).toBeCloseTo(horizon, 6);
    // never exceeds the horizon
    expect(footprintCentralAngleRad(rSat, 45)).toBeLessThanOrEqual(horizon + 1e-9);
  });

  it("matches the closed-form triangle relation for a mid half-angle", () => {
    const R = 6371.0088;
    const eta = (20 * Math.PI) / 180;
    const expected = Math.asin((rSat / R) * Math.sin(eta)) - eta;
    expect(footprintCentralAngleRad(rSat, 20)).toBeCloseTo(expected, 9);
  });
});

describe("footprintRing", () => {
  it("all ring points sit at the footprint central angle from the sub-satellite point", () => {
    const sat: [number, number, number] = [0, 0, 6371.0088 + 700]; // over the north pole
    const ring = footprintRing(sat, 25, 32, 0);
    const lambda = footprintCentralAngleRad(Math.hypot(...sat), 25);
    const u = [0, 0, 1];
    for (let i = 0; i < 32; i += 1) {
      const p = [ring[i * 3] ?? 0, ring[i * 3 + 1] ?? 0, ring[i * 3 + 2] ?? 0];
      const r = Math.hypot(p[0], p[1], p[2]);
      const cosAngle = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / r;
      expect(Math.acos(cosAngle)).toBeCloseTo(lambda, 4); // central angle
      expect(r).toBeCloseTo(6371.0088, 0); // on the surface
    }
  });

  it("bump lifts the ring off the surface", () => {
    const sat: [number, number, number] = [7000, 0, 0];
    const r0 = Math.hypot(...(footprintRing(sat, 20, 8, 0).subarray(0, 3) as unknown as number[]));
    const r5 = Math.hypot(...(footprintRing(sat, 20, 8, 5).subarray(0, 3) as unknown as number[]));
    expect(r5 - r0).toBeCloseTo(5, 3);
  });
});
