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
import { czmlToSegments, exportCzml, parseCzml } from "./czml.js";

const DOC = {
  id: "document",
  name: "demo",
  version: "1.0",
  clock: {
    interval: "2026-07-05T00:00:00Z/2026-07-06T00:00:00Z",
    currentTime: "2026-07-05T00:00:00Z",
    multiplier: 60,
  },
};
const SAT = {
  id: "sat-1",
  name: "DEMO SAT",
  availability: "2026-07-05T00:00:00Z/2026-07-05T12:00:00Z",
  position: {
    epoch: "2026-07-05T00:00:00Z",
    referenceFrame: "INERTIAL",
    interpolationAlgorithm: "LINEAR",
    // meters, [t, x, y, z] quadruples
    cartesian: [0, 6874263, 0, 0, 60, 6859064, 447616, 0, 120, 6813596, 892244, 0],
  },
  point: { pixelSize: 4, color: { rgba: [140, 217, 255, 255] } },
};

describe("parseCzml", () => {
  it("parses document clock and sampled entities, converting meters to km", () => {
    const scene = parseCzml(JSON.stringify([DOC, SAT]));
    expect(scene.name).toBe("demo");
    expect(scene.clock?.multiplier).toBe(60);
    expect(scene.clock?.endMs).toBe(Date.UTC(2026, 6, 6));
    expect(scene.entities).toHaveLength(1);
    const e = scene.entities[0];
    expect(e?.referenceFrame).toBe("INERTIAL");
    expect([...(e?.times ?? [])]).toEqual([0, 60, 120]);
    expect(e?.positions[0]).toBeCloseTo(6874.263, 3); // km
    expect(e?.availabilityMs?.[1]).toBe(Date.UTC(2026, 6, 5, 12));
    expect(e?.pointPixelSize).toBe(4);
    expect(scene.warnings).toHaveLength(0);
  });

  it("collects cosmetic unknowns as warnings, throws on semantic ones", () => {
    const withBillboard = { ...SAT, billboard: { image: "x.png" } };
    const scene = parseCzml([DOC, withBillboard]);
    expect(scene.warnings[0]).toMatch(/sat-1.*billboard/);

    expect(() => parseCzml([{ ...DOC, version: "2.0" }])).toThrow(/unsupported CZML version/);
    expect(() => parseCzml([SAT])).toThrow(/first packet/);
    const fixedPos = { ...SAT, position: { cartesian: [0, 1, 2] } };
    expect(() => parseCzml([DOC, fixedPos])).toThrow(/not quadruples/);
    const noEpoch = { ...SAT, position: { ...SAT.position, epoch: undefined } };
    expect(() => parseCzml([DOC, noEpoch])).toThrow(/parseable epoch/);
    const hermite = {
      ...SAT,
      position: { ...SAT.position, interpolationAlgorithm: "HERMITE" },
    };
    expect(() => parseCzml([DOC, hermite])).toThrow(/unsupported interpolationAlgorithm/);
  });

  it("skips (with warning) entities without position instead of inventing them", () => {
    const scene = parseCzml([DOC, { id: "gs-1", name: "GROUND STATION" }]);
    expect(scene.entities).toHaveLength(0);
    expect(scene.warnings[0]).toMatch(/gs-1: no position/);
  });
});

describe("exportCzml round trip", () => {
  it("parse(export(parse(x))) preserves the subset exactly", () => {
    const a = parseCzml([DOC, SAT]);
    const b = parseCzml(exportCzml(a));
    expect(b.name).toBe(a.name);
    expect(b.clock).toEqual(a.clock);
    expect(b.entities).toHaveLength(1);
    expect([...(b.entities[0]?.times ?? [])]).toEqual([...(a.entities[0]?.times ?? [])]);
    expect(b.entities[0]?.positions[0]).toBeCloseTo(a.entities[0]?.positions[0] ?? 0, 6);
    expect(b.entities[0]?.referenceFrame).toBe("INERTIAL");
    expect(b.entities[0]?.availabilityMs).toEqual(a.entities[0]?.availabilityMs);
    expect(b.entities[0]?.pointColorRgba).toEqual(a.entities[0]?.pointColorRgba);
  });
});

describe("czmlToSegments (EphemerisSource bridge)", () => {
  it("produces OemSegment-shaped objects with the frame preserved", () => {
    const segs = czmlToSegments(parseCzml([DOC, SAT]));
    expect(segs).toHaveLength(1);
    expect(segs[0]?.objectId).toBe("sat-1");
    expect(segs[0]?.refFrame).toBe("INERTIAL");
    expect(segs[0]?.epochMs).toBe(Date.UTC(2026, 6, 5));
    expect(segs[0]?.positions[0]).toBeCloseTo(6874.263, 3);
  });
});
