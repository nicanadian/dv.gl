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
import * as satellite from "satellite.js";
import { describe, expect, it } from "vitest";
import { gmst, unixMsToJulianDate } from "./gmst.js";
import { ecefToGeodetic, temeToEcef, WGS84_A_KM } from "./transforms.js";

describe("gmst", () => {
  it("reproduces Vallado example 3-5 (1992-08-20 12:14:00 UT1)", () => {
    // Vallado 4th ed., example 3-5: GMST = 152.578787886 deg
    const unixMs = Date.UTC(1992, 7, 20, 12, 14, 0);
    const deg = (gmst(unixMs) * 180) / Math.PI;
    expect(deg).toBeCloseTo(152.578787886, 6);
  });

  it("agrees with satellite.js gstime across a year of epochs", () => {
    for (let month = 0; month < 12; month += 1) {
      const unixMs = Date.UTC(2026, month, 15, 7, 31, 12);
      const ours = gmst(unixMs);
      const theirs = satellite.gstime(new Date(unixMs));
      // both fp64, same IAU-82 lineage: sub-milliarcsecond agreement expected
      expect(Math.abs(ours - theirs)).toBeLessThan(1e-9);
    }
  });

  it("julian date conversion anchors at the Unix epoch", () => {
    expect(unixMsToJulianDate(0)).toBe(2_440_587.5);
  });
});

describe("temeToEcef", () => {
  it("matches satellite.js eciToEcf for arbitrary positions and epochs", () => {
    const unixMs = Date.UTC(2026, 0, 1, 3, 45, 0);
    const theta = satellite.gstime(new Date(unixMs));
    const cases = [
      [6795.1, -1234.5, 2345.6],
      [0, 42164, 0],
      [-15000, 8000, -20000],
    ];
    const input = new Float32Array(cases.flat());
    const out = new Float32Array(input.length);
    temeToEcef(input, cases.length, unixMs, out);
    cases.forEach((c, k) => {
      const ref = satellite.eciToEcf({ x: c[0] ?? 0, y: c[1] ?? 0, z: c[2] ?? 0 }, theta);
      // fp32 storage of km-scale values rounds at ~2 m
      expect(Math.abs((out[k * 3] ?? Number.NaN) - ref.x)).toBeLessThan(5e-3);
      expect(Math.abs((out[k * 3 + 1] ?? Number.NaN) - ref.y)).toBeLessThan(5e-3);
      expect(Math.abs((out[k * 3 + 2] ?? Number.NaN) - ref.z)).toBeLessThan(5e-3);
    });
  });

  it("preserves radius, passes NaN through, and supports in-place rotation", () => {
    const unixMs = Date.UTC(2026, 5, 4);
    const buf = new Float32Array([7000, 100, -300, Number.NaN, 1, 2]);
    temeToEcef(buf, 2, unixMs, buf); // in place
    const r = Math.hypot(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0);
    expect(r).toBeCloseTo(Math.hypot(7000, 100, -300), 2);
    expect(Number.isNaN(buf[3] ?? 0)).toBe(true);
    expect(() => temeToEcef(buf, 3, unixMs, buf)).toThrow(/too small/);
  });
});

describe("ecefToGeodetic", () => {
  it("equator and poles are exact anchor points", () => {
    const eq = ecefToGeodetic(WGS84_A_KM, 0, 0);
    expect(eq.latDeg).toBeCloseTo(0, 9);
    expect(eq.lonDeg).toBeCloseTo(0, 9);
    expect(eq.heightKm).toBeCloseTo(0, 6);
    const pole = ecefToGeodetic(0, 0, 6356.7523142 + 100);
    expect(pole.latDeg).toBe(90);
    expect(pole.heightKm).toBeCloseTo(100, 3);
  });

  it("matches satellite.js eciToGeodetic through the same rotation", () => {
    const unixMs = Date.UTC(2026, 2, 10, 18, 0, 0);
    const theta = satellite.gstime(new Date(unixMs));
    const teme = { x: 5102.5096, y: 6123.01152, z: 6378.1363 };
    const ref = satellite.eciToGeodetic(teme, theta);
    const buf = new Float32Array([teme.x, teme.y, teme.z]);
    temeToEcef(buf, 1, unixMs, buf);
    const ours = ecefToGeodetic(buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0);
    expect(ours.latDeg).toBeCloseTo((ref.latitude * 180) / Math.PI, 4);
    expect(ours.lonDeg).toBeCloseTo((ref.longitude * 180) / Math.PI, 4);
    expect(ours.heightKm).toBeCloseTo(ref.height, 2);
  });
});
