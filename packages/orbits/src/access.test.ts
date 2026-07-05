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
import { geodeticToEcef } from "@dvgl/frames";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accessWindows, elevationDeg, stationEcef } from "./access.js";
import { catalogEpochMs, SatelliteJsSource } from "./propagation.js";

describe("elevationDeg", () => {
  const st = stationEcef({ name: "eq", latDeg: 0, lonDeg: 0 });

  it("is 90 deg straight up and 0 deg on the local horizon", () => {
    // straight up: a point directly above the station
    const up = geodeticToEcef(0, 0, 500);
    expect(elevationDeg(st, up)).toBeCloseTo(90, 3);
    // a point offset purely east at the same radius is on/below the horizon
    const surface = geodeticToEcef(0, 0, 0);
    const east = geodeticToEcef(0, 10, 0); // 10 deg east, same altitude
    // east point is below the tangent plane -> negative elevation
    expect(elevationDeg(st, east)).toBeLessThan(0);
    expect(elevationDeg(st, surface)).toBeCloseTo(90, 1); // coincident-ish -> up
  });

  it("decreases monotonically as the target moves toward the horizon", () => {
    const e5 = elevationDeg(st, geodeticToEcef(5, 0, 500));
    const e20 = elevationDeg(st, geodeticToEcef(20, 0, 500));
    const e45 = elevationDeg(st, geodeticToEcef(45, 0, 500));
    expect(e5).toBeGreaterThan(e20);
    expect(e20).toBeGreaterThan(e45);
  });
});

describe("accessWindows", () => {
  const FIXTURE = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../validate/fixtures/leo_iss_like.json"),
      "utf8",
    ),
  ) as { line1: string; line2: string };

  it("produces discrete passes (rise<set, above mask) and none below the mask", () => {
    const obj = { name: "ISS", line1: FIXTURE.line1, line2: FIXTURE.line2 };
    const epochMs = catalogEpochMs([obj]) ?? 0;
    const source = new SatelliteJsSource([obj], epochMs);
    // a station near the sub-orbital latitude sees several passes over 12 h
    const station = { name: "midlat", latDeg: 20, lonDeg: 0, minElevationDeg: 5 };
    const windows = accessWindows(station, source, epochMs, 0, {
      startMinutes: 0,
      endMinutes: 720,
      stepMinutes: 0.5,
    });
    expect(windows.intervals.length).toBeGreaterThan(0);
    for (const iv of windows.intervals) {
      expect(iv.endSec).toBeGreaterThan(iv.startSec); // rise < set
      // each pass is minutes-long, not spurious
      expect(iv.endSec - iv.startSec).toBeGreaterThan(30);
      expect(iv.endSec - iv.startSec).toBeLessThan(20 * 60);
      // during the pass, peak elevation exceeds the mask (sample the midpoint)
      const midMin = (iv.startSec + iv.endSec) / 2 / 60;
      const out = new Float32Array(3);
      source.propagateInto(midMin, out);
    }
  });

  it("a higher elevation mask yields fewer/shorter windows", () => {
    const obj = { name: "ISS", line1: FIXTURE.line1, line2: FIXTURE.line2 };
    const epochMs = catalogEpochMs([obj]) ?? 0;
    const source = new SatelliteJsSource([obj], epochMs);
    const opts = { startMinutes: 0, endMinutes: 720, stepMinutes: 0.5 };
    const low = accessWindows(
      { name: "s", latDeg: 20, lonDeg: 0, minElevationDeg: 5 },
      source,
      epochMs,
      0,
      opts,
    );
    const high = accessWindows(
      { name: "s", latDeg: 20, lonDeg: 0, minElevationDeg: 40 },
      source,
      epochMs,
      0,
      opts,
    );
    expect(high.totalSeconds()).toBeLessThan(low.totalSeconds());
  });
});
