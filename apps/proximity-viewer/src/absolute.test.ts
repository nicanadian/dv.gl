/* Copyright 2026 nicanadian. Licensed under the Apache License, Version 2.0. */

import { describe, expect, it } from "vitest";
import { absoluteStateAt, parseAbsolutePair } from "./absolute.js";

const points: Array<{
  time: string;
  position_eci_km: [number, number, number];
  velocity_eci_km_s: [number, number, number];
}> = [
  {
    time: "2026-07-10T00:00:00.000Z",
    position_eci_km: [6878, 0, 0],
    velocity_eci_km_s: [0, 7.6, 0],
  },
  {
    time: "2026-07-10T00:01:00.000Z",
    position_eci_km: [6860, 450, 0],
    velocity_eci_km_s: [-0.5, 7.58, 0],
  },
];
const document = (objectId: string, offset = 0) => ({
  schema_version: "ephemeris/1.0",
  frame_profile: "skframe/v1",
  frame: "ECI_J2000",
  length_units: "km",
  velocity_units: "km/s",
  object: { object_id: objectId },
  provenance: { producer: "pdb", run_id: "run-1" },
  points: points.map((point) => ({
    ...point,
    position_eci_km: [point.position_eci_km[0] + offset, ...point.position_eci_km.slice(1)],
  })),
});
const gate = {
  schema_version: "proximity_gate/0.1",
  gate_id: "gate-1",
  epoch: "2026-07-10T00:00:00.000Z",
  absolute_source: { producer: "pdb", run_id: "run-1" },
};

describe("absolute handoff evidence", () => {
  it("binds aligned pdb tracks to the gate and interpolates", () => {
    const pair = parseAbsolutePair(document("chaser", 0.25), document("target"), gate);
    expect(pair.gateId).toBe("gate-1");
    expect(absoluteStateAt(pair, 30).target.position.yKm).toBe(225);
  });

  it("fails closed on source drift", () => {
    const wrong = document("target");
    wrong.provenance.run_id = "other";
    expect(() => parseAbsolutePair(document("chaser"), wrong, gate)).toThrow("bind");
  });
});
