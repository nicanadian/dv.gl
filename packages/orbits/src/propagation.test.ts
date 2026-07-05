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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "./catalog.js";
import { catalogEpochMs, jdayToUnixMs, readPosition, SatelliteJsSource } from "./propagation.js";

// Reuse the validated fp64 reference fixture from @dvgl/validate (monorepo path;
// test-only). Its TLE was produced by python-sgp4's exporter, so it is valid.
const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../validate/fixtures/leo_iss_like.json"),
    "utf8",
  ),
) as {
  line1: string;
  line2: string;
  points: [number, number, number, number][];
};

describe("SatelliteJsSource", () => {
  const obj = { name: "LEO", line1: FIXTURE.line1, line2: FIXTURE.line2 };

  it("propagates into a packed buffer matching the fp64 reference (fp32 storage)", () => {
    const source = new SatelliteJsSource([obj]);
    expect(source.count).toBe(1);
    expect(source.rejected).toHaveLength(0);
    const out = new Float32Array(3);
    // spot-check a handful of reference epochs across the 7-day window
    for (const idx of [0, 100, 500, 1008]) {
      const row = FIXTURE.points[idx];
      if (row === undefined) continue;
      const [minutes, x, y, z] = row;
      const { written, failed } = source.propagateInto(minutes, out);
      expect(written).toBe(1);
      expect(failed).toBe(0);
      // tolerance = fp32 storage rounding at LEO radius (~0.5 m), not model error
      expect(Math.abs((out[0] ?? Number.NaN) - x)).toBeLessThan(2e-3);
      expect(Math.abs((out[1] ?? Number.NaN) - y)).toBeLessThan(2e-3);
      expect(Math.abs((out[2] ?? Number.NaN) - z)).toBeLessThan(2e-3);
    }
  });

  it("rejects invalid TLEs at init instead of silently propagating", () => {
    const source = new SatelliteJsSource([
      obj,
      { name: "garbage", line1: "1 garbage", line2: "2 garbage" },
    ]);
    expect(source.count).toBe(1);
    expect(source.rejected).toHaveLength(1);
    expect(source.rejected[0]?.name).toBe("garbage");
  });

  it("applies per-object epoch offsets for a shared scenario epoch", () => {
    // scenario epoch = TLE epoch + 60 min: propagating to t=0 must equal
    // propagating the offset-free source to t=60.
    const epochMs = catalogEpochMs([obj]);
    expect(epochMs).toBeDefined();
    if (epochMs === undefined) return;
    const shifted = new SatelliteJsSource([obj], epochMs + 3_600_000);
    const plain = new SatelliteJsSource([obj]);
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    shifted.propagateInto(0, a);
    plain.propagateInto(60, b);
    expect(a[0]).toBeCloseTo(b[0] ?? Number.NaN, 5);
    expect(a[1]).toBeCloseTo(b[1] ?? Number.NaN, 5);
    expect(a[2]).toBeCloseTo(b[2] ?? Number.NaN, 5);
  });

  it("throws on undersized output buffers", () => {
    const source = new SatelliteJsSource([obj, obj]);
    expect(() => source.propagateInto(0, new Float32Array(3))).toThrow(/too small/);
  });
});

describe("catalog", () => {
  it("parses the snapshot format and rejects malformed entries", () => {
    const good = JSON.stringify({
      source: "test",
      sha256: "abc",
      objects: [{ name: "A", line1: FIXTURE.line1, line2: FIXTURE.line2 }],
    });
    const catalog = parseCatalog(good);
    expect(catalog.objects).toHaveLength(1);
    expect(catalog.sha256).toBe("abc");
    expect(() => parseCatalog('{"objects":[{"name":1}]}')).toThrow(/missing/);
    expect(() => parseCatalog("{}")).toThrow(/missing objects/);
  });

  it("jdayToUnixMs maps the Unix epoch Julian day to 0", () => {
    expect(jdayToUnixMs(2440587.5)).toBe(0);
  });
});

describe("readPosition (satellite.js failure shapes)", () => {
  it("maps every observed failure shape to undefined", () => {
    expect(readPosition(false)).toBeUndefined();
    expect(readPosition(undefined)).toBeUndefined();
    expect(readPosition(null)).toBeUndefined();
    expect(readPosition({})).toBeUndefined();
    expect(readPosition({ position: false })).toBeUndefined();
    expect(readPosition({ position: undefined })).toBeUndefined();
    expect(readPosition({ position: null })).toBeUndefined();
    expect(readPosition({ position: { x: Number.NaN, y: 0, z: 0 } })).toBeUndefined();
    expect(readPosition({ position: { x: 1 } })).toBeUndefined();
    expect(readPosition({ position: { x: 1, y: 2, z: 3 } })).toEqual({ x: 1, y: 2, z: 3 });
  });
});
