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
import { POINTS_WGSL } from "./points.js";
import { combineSplit, packRte, splitCamera, splitDouble } from "./rte.js";

describe("RTE split math (why the clean-sheet path doesn't jitter)", () => {
  it("split halves are individually fp32-representable and sum back to fp64", () => {
    const x = 6795.123456789; // km, LEO radius scale
    const { high, low } = splitDouble(x);
    expect(Math.fround(high)).toBe(high);
    expect(Math.fround(low)).toBe(low);
    expect(Math.abs(combineSplit(high, low) - x)).toBeLessThan(1e-10);
  });

  it("naive fp32 world-space loses meters; RTE subtraction keeps sub-millimeter", () => {
    // satellite at LEO radius, camera 1.5 km away along x
    const sat = 6795.1234567;
    const eye = 6793.6;
    const trueRel = sat - eye;

    // naive: both rounded to fp32 in world space, subtracted on the GPU
    const naive = Math.fround(sat) - Math.fround(eye);
    const naiveErrKm = Math.abs(naive - trueRel);

    // RTE: (high-high) exact + (low-low) near the origin
    const s = splitDouble(sat);
    const e = splitDouble(eye);
    const rte = s.high - e.high + (s.low - e.low);
    const rteErrKm = Math.abs(rte - trueRel);

    expect(rteErrKm).toBeLessThan(1e-9); // < 1 mm
    expect(rteErrKm).toBeLessThan(naiveErrKm / 100); // orders of magnitude better
  });

  it("packRte fills parallel high/low buffers", () => {
    const positions = [6795.1234567, -3210.987654, 1234.5678901];
    const high = new Float32Array(3);
    const low = new Float32Array(3);
    packRte(positions, high, low);
    for (let k = 0; k < 3; k += 1) {
      const p = positions[k];
      if (p === undefined) continue;
      expect(Math.abs((high[k] ?? 0) + (low[k] ?? 0) - p)).toBeLessThan(1e-10);
    }
    expect(() => packRte(positions, new Float32Array(1), low)).toThrow(/too small/);
  });

  it("splitCamera lays out vec4-aligned high/low for the uniform buffer", () => {
    const out = splitCamera([6795.1234567, -3210.987654, 1234.5678901]);
    expect(out).toHaveLength(8);
    expect((out[0] ?? 0) + (out[4] ?? 0)).toBeCloseTo(6795.1234567, 6);
    expect(out[3]).toBe(0); // padding
  });
});

describe("points WGSL", () => {
  it("shader consumes the split-buffer layout the CPU side produces", () => {
    expect(POINTS_WGSL).toContain("posHigh");
    expect(POINTS_WGSL).toContain("posLow");
    expect(POINTS_WGSL).toContain("eyeHigh");
    // the RTE subtraction order: high parts first, then low residual
    expect(POINTS_WGSL).toContain(
      "(posHigh[i].xyz - cam.eyeHigh.xyz) + (posLow[i].xyz - cam.eyeLow.xyz)",
    );
  });
});
