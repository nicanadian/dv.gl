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
import {
  collectFootprintCorners,
  collectGroundRing,
  collectState,
  parseCollects,
} from "./collects.js";

const EPOCH_MS = Date.parse("2026-06-15T00:00:00Z");

describe("parseCollects", () => {
  it("converts ISO windows to seconds since the mission epoch and sorts by start", () => {
    const cs = parseCollects(
      {
        collects: [
          {
            id: "b",
            sat: "EO-05",
            start: "2026-06-15T00:37:00Z",
            end: "2026-06-15T00:39:00Z",
            targetLatDeg: 37.5,
            targetLonDeg: -85,
          },
          {
            id: "a",
            sat: "SAR-01",
            start: "2026-06-15T00:04:00Z",
            end: "2026-06-15T00:05:00Z",
            targetLatDeg: 12.6,
            targetLonDeg: 103.6,
          },
        ],
      },
      EPOCH_MS,
    );
    expect(cs.map((c) => c.id)).toEqual(["a", "b"]); // sorted by start
    expect(cs[0]?.startSec).toBe(4 * 60);
    expect(cs[0]?.endSec).toBe(5 * 60);
    expect(cs[1]?.startSec).toBe(37 * 60);
  });

  it("drops entries with bad times or targets", () => {
    const cs = parseCollects(
      {
        collects: [
          {
            id: "bad",
            sat: "X",
            start: "not-a-date",
            end: "2026-06-15T00:05:00Z",
            targetLatDeg: 0,
            targetLonDeg: 0,
          },
          {
            id: "ok",
            sat: "Y",
            start: "2026-06-15T00:00:00Z",
            end: "2026-06-15T00:01:00Z",
            targetLatDeg: 0,
            targetLonDeg: 0,
          },
        ],
      },
      EPOCH_MS,
    );
    expect(cs.map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("collectState", () => {
  const c = {
    id: "c",
    sat: "EO-01",
    startSec: 1000,
    endSec: 1100,
    targetLatDeg: 0,
    targetLonDeg: 0,
  };
  it("classifies upcoming / active / recent / idle around the window", () => {
    expect(collectState(c, 1050, 600, 600)).toBe("active"); // inside window
    expect(collectState(c, 900, 600, 600)).toBe("upcoming"); // 100s before, lead 600
    expect(collectState(c, 1300, 600, 600)).toBe("recent"); // 200s after, trail 600
    expect(collectState(c, 100, 600, 600)).toBe("idle"); // 900s before
    expect(collectState(c, 2000, 600, 600)).toBe("idle"); // 900s after
  });
});

describe("collectGroundRing", () => {
  it("rings the target on the surface at the given radius", () => {
    const R = 6371.0088;
    const ring = collectGroundRing(0, 0, 50, 16, 0); // target at (0,0) -> +x axis
    for (let i = 0; i < 16; i += 1) {
      const p = [ring[i * 3] ?? 0, ring[i * 3 + 1] ?? 0, ring[i * 3 + 2] ?? 0];
      const r = Math.hypot(p[0], p[1], p[2]);
      expect(r).toBeCloseTo(R, 3); // on the surface
      // central angle from the target direction (+x) ~ radius/R
      expect(Math.acos((p[0] ?? 0) / r)).toBeCloseTo(50 / R, 4);
    }
  });
});

describe("collectFootprintCorners", () => {
  const extent = (corners: Float32Array): { ew: number; ns: number } => {
    // target (0,0) -> +x axis; east ~ +y, north ~ +z
    let yMin = Infinity;
    let yMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < 4; i += 1) {
      const y = corners[i * 3 + 1] ?? 0;
      const z = corners[i * 3 + 2] ?? 0;
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
    }
    return { ew: yMax - yMin, ns: zMax - zMin };
  };

  it("EO footprint is a compact near-square; SAR is an elongated strip", () => {
    const eo = extent(collectFootprintCorners(0, 0, 60, 60, 10, 0));
    const sar = extent(collectFootprintCorners(0, 0, 24, 60, 10, 0));
    expect(eo.ns / eo.ew).toBeCloseTo(1, 1); // EO ~ square
    expect(sar.ns / sar.ew).toBeGreaterThan(2); // SAR strip: long in along-track
  });

  it("grows with look angle", () => {
    const near = extent(collectFootprintCorners(0, 0, 60, 60, 0, 0));
    const far = extent(collectFootprintCorners(0, 0, 60, 60, 45, 0));
    expect(far.ew).toBeGreaterThan(near.ew);
  });
});
