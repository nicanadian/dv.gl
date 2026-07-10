/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it } from "vitest";
import { parseReplay, replayStateAt } from "./replay.js";

const fixture = {
  schema_version: "replay/1.0",
  frame: "LVLH_RIC",
  length_units: "m",
  velocity_units: "m/s",
  mission_id: "mission-1",
  contract_id: "contract-1",
  epoch: "2026-07-10T00:00:00.000Z",
  provenance: { not_official_model: true },
  absolute_source: { description: "test fixture" },
  samples: [
    {
      phase: "hold",
      t: "2026-07-10T00:00:00.000Z",
      relative_state: { x_m: 0, y_m: -10, z_m: 0 },
    },
    {
      phase: "terminal",
      t: "2026-07-10T00:00:10.000Z",
      relative_state: { x_m: 0, y_m: -2, z_m: 0 },
    },
  ],
};

describe("parseReplay", () => {
  it("accepts the strict target-relative contract", () => {
    const replay = parseReplay(fixture);
    expect(replay.durationSec).toBe(10);
    expect(replay.samples).toHaveLength(2);
    expect(replay.notOfficialModel).toBe(true);
  });

  it("fails closed on a wrong frame or non-increasing samples", () => {
    expect(() => parseReplay({ ...fixture, frame: "ECI_J2000" })).toThrow("requires LVLH_RIC");
    const duplicateTime = structuredClone(fixture);
    const first = duplicateTime.samples[0];
    const second = duplicateTime.samples[1];
    if (!first || !second) throw new Error("test fixture requires two samples");
    second.t = first.t;
    expect(() => parseReplay(duplicateTime)).toThrow("increase strictly");
  });
});

describe("replayStateAt", () => {
  it("interpolates relative position without propagating new truth", () => {
    const state = replayStateAt(parseReplay(fixture), 5);
    expect(state.position).toEqual({ x: 0, y: -6, z: 0 });
    expect(state.separationM).toBe(6);
    expect(state.phase).toBe("hold");
  });

  it("clamps outside the evidence window", () => {
    const replay = parseReplay(fixture);
    expect(replayStateAt(replay, -4).timeSec).toBe(0);
    expect(replayStateAt(replay, 99).timeSec).toBe(10);
  });
});
