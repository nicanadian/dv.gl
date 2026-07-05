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

describe("workload replication", () => {
  const obj = { name: "LEO", line1: FIXTURE.line1, line2: FIXTURE.line2 };

  it("replicate=N multiplies count with phase-shifted, distinct replicas", () => {
    const source = new SatelliteJsSource([obj], undefined, { replicate: 4 });
    expect(source.count).toBe(4);
    const out = new Float32Array(12);
    const { written, failed } = source.propagateInto(0, out);
    expect(written).toBe(4);
    expect(failed).toBe(0);
    // replicas are phase-shifted along the orbit: positions must differ
    const r0 = [out[0], out[1], out[2]];
    const r1 = [out[3], out[4], out[5]];
    const dist = Math.hypot(
      (r0[0] ?? 0) - (r1[0] ?? 0),
      (r0[1] ?? 0) - (r1[1] ?? 0),
      (r0[2] ?? 0) - (r1[2] ?? 0),
    );
    expect(dist).toBeGreaterThan(100); // km apart, not co-located
    // all replicas still on the same orbit: same radius to within eccentric wiggle
    const rad0 = Math.hypot(r0[0] ?? 0, r0[1] ?? 0, r0[2] ?? 0);
    const rad1 = Math.hypot(r1[0] ?? 0, r1[1] ?? 0, r1[2] ?? 0);
    expect(Math.abs(rad0 - rad1)).toBeLessThan(50);
  });

  it("replicate=1 (default) is unchanged", () => {
    expect(new SatelliteJsSource([obj]).count).toBe(1);
    expect(new SatelliteJsSource([obj], undefined, {}).count).toBe(1);
  });
});

describe("sampleWindowInto (SGP4 orbit tracks)", () => {
  const obj = { name: "LEO", line1: FIXTURE.line1, line2: FIXTURE.line2 };

  it("period comes from the mean motion and the window closes on itself", () => {
    const source = new SatelliteJsSource([obj]);
    const period = source.periodMinutes(0);
    expect(period).toBeGreaterThan(90); // ~420 km orbit
    expect(period).toBeLessThan(96);
    const S = 129;
    const window = new Float32Array(S * 3);
    source.sampleWindowInto(500, S, window);
    // middle sample == direct propagation at the center epoch
    const direct = new Float32Array(3);
    source.propagateInto(500, direct);
    const mid = ((S - 1) / 2) * 3;
    expect(window[mid]).toBeCloseTo(direct[0] ?? Number.NaN, 3);
    // +/- one full period: first and last samples land near the same point
    // (J2 drift over 2 revs keeps them within a few tens of km, not identical)
    const d = Math.hypot(
      (window[0] ?? 0) - (window[(S - 1) * 3] ?? 0),
      (window[1] ?? 0) - (window[(S - 1) * 3 + 1] ?? 0),
      (window[2] ?? 0) - (window[(S - 1) * 3 + 2] ?? 0),
    );
    expect(d).toBeLessThan(100);
    expect(() => source.sampleWindowInto(0, S, new Float32Array(3))).toThrow(/too small/);
  });
});
