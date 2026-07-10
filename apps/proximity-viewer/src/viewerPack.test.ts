/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it } from "vitest";
import { packAssetUrl, parsePackScenario, parseViewerPack } from "./viewerPack.js";

const digest = "a".repeat(64);
const fixture = {
  schema_version: "rpo_viewer_pack/v1",
  pack_id: "native-run",
  version: "1.0.0",
  frame_profile: "skframe/v1",
  frame: "LVLH_RIC",
  length_units: "m",
  authority: "visual_only",
  models: {
    client: {
      name: "client",
      accuracy_tier: "rpo_presentation",
      source_basis: "fixture",
      not_official_model: true,
      tiers: { high: "models/client.high.glb" },
    },
    chaser: {
      name: "chaser",
      accuracy_tier: "rpo_presentation",
      source_basis: "fixture",
      not_official_model: true,
      tiers: { high: "models/chaser.high.glb" },
    },
  },
  robot: {
    name: "servicing_arm",
    accuracy_tier: "rpo_interaction",
    not_official_model: true,
    glb: "models/robot.high.glb",
    document: "metadata/robot.json",
    base_frame: "arm_base",
    base_frame_resolved: true,
    tool_frame: "tool0",
    trajectory: "evidence/robot-joint-trajectory.json",
    trajectory_report: "reports/robot-trajectory.json",
  },
  scenes: { replay: "replay/approach.json", scenario: "config/scenario.json" },
  evidence: {
    proximity_gate: "evidence/proximity-gate.json",
    absolute_chaser_ephemeris: "evidence/chaser-absolute.json",
    absolute_target_ephemeris: "evidence/target-absolute.json",
    robot_joint_trajectory: "evidence/robot-joint-trajectory.json",
  },
  files: [
    { path: "models/client.high.glb", sha256: digest },
    { path: "models/chaser.high.glb", sha256: digest },
    { path: "replay/approach.json", sha256: digest },
    { path: "config/scenario.json", sha256: digest },
    { path: "evidence/proximity-gate.json", sha256: digest },
    { path: "evidence/chaser-absolute.json", sha256: digest },
    { path: "evidence/target-absolute.json", sha256: digest },
    { path: "models/robot.high.glb", sha256: digest },
    { path: "metadata/robot.json", sha256: digest },
    { path: "evidence/robot-joint-trajectory.json", sha256: digest },
    { path: "reports/robot-trajectory.json", sha256: digest },
  ],
};

describe("parseViewerPack", () => {
  it("accepts the strict visual-only sibling contract", () => {
    const pack = parseViewerPack(fixture);
    expect(pack.pack_id).toBe("native-run");
    expect(pack.models.client.not_official_model).toBe(true);
    expect(packAssetUrl("/packs/native", pack.scenes.replay)).toBe(
      "/packs/native/replay/approach.json",
    );
  });

  it("loads the packaged keep-out presentation envelope", () => {
    expect(parsePackScenario({ schema_version: "rpo_scenario/v1", keep_out_margin_m: 10 })).toEqual(
      { keepOutMarginM: 10 },
    );
    expect(() =>
      parsePackScenario({ schema_version: "rpo_scenario/v1", keep_out_margin_m: 0 }),
    ).toThrow("positive");
  });

  it("fails closed on authority, frame, path, or manifest drift", () => {
    expect(() => parseViewerPack({ ...fixture, authority: "collision" })).toThrow("visual_only");
    expect(() => parseViewerPack({ ...fixture, frame_profile: "unknown/v1" })).toThrow("frame");
    expect(() => parseViewerPack({ ...fixture, scenes: { replay: "../escaped.json" } })).toThrow(
      "unsafe",
    );
    expect(() => parseViewerPack({ ...fixture, files: fixture.files.slice(1) })).toThrow(
      "does not manifest",
    );
  });
});
