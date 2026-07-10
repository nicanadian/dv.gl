/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it } from "vitest";
import { jointStateAt, parseJointTrajectory, parseRobotJointModel } from "./jointTrajectory.js";
import { parseReplay } from "./replay.js";

const replay = parseReplay({
  schema_version: "replay/1.0",
  frame_profile: "skframe/v1",
  frame: "LVLH_RIC",
  length_units: "m",
  velocity_units: "m/s",
  mission_id: "mission",
  contract_id: "contract",
  epoch: "2026-07-10T00:00:00.000Z",
  provenance: { not_official_model: true },
  samples: [0, 10].map((time) => ({
    phase: "propagated",
    t: `2026-07-10T00:00:${String(time).padStart(2, "0")}.000Z`,
    relative_state: { x_m: 10 - time, y_m: 0, z_m: 0 },
    attitude_body_to_eci: {
      frame: "ECI_J2000",
      convention: "body_to_inertial",
      quaternion_order: "xyzw",
      chaser: [0, 0, 0, 1],
      target: [0, 0, 0, 1],
    },
  })),
});

const robotValue = {
  schema_version: "robot/v1",
  name: "arm",
  angle_units: "rad",
  joints: [
    {
      name: "elbow",
      type: "revolute",
      axis: [0, 1, 0],
      limit: { lower: -1, upper: 1, velocity: 0.2 },
    },
  ],
};

const trajectoryValue = {
  schema_version: "robot_joint_trajectory/1.0",
  trajectory_id: "trajectory",
  intent: "ready_to_pregrasp_rehearsal",
  mission_id: "mission",
  contract_id: "contract",
  authority: "simulation_evidence_only",
  epoch: "2026-07-10T00:00:00.000Z",
  time_basis: "source_replay_epoch",
  angle_units: "rad",
  robot: {
    name: "arm",
    model_schema_version: "robot/v1",
    hash_basis: "canonical_json",
    model_sha256: "a".repeat(64),
  },
  source_replay: {
    schema_version: "replay/1.0",
    hash_basis: "canonical_json",
    sha256: "b".repeat(64),
    duration_s: 10,
  },
  joint_order: ["elbow"],
  constraints: { elbow: { lower_rad: -1, upper_rad: 1, max_velocity_radps: 0.2 } },
  samples: [
    { t: "2026-07-10T00:00:00.000Z", t_rel_s: 0, positions_rad: { elbow: 0.8 } },
    { t: "2026-07-10T00:00:10.000Z", t_rel_s: 10, positions_rad: { elbow: 0.2 } },
  ],
  simulation: {
    adapter: "deterministic_piecewise_linear_joint_sampler/v1",
    accepted: true,
    reason_codes: [],
  },
  provenance: { producer: "sublime-kinematics", deterministic: true, not_hardware: true },
  unsupported_evidence: ["hardware_execution"],
};

describe("joint trajectory evidence", () => {
  it("binds to robot/replay contracts and interpolates named positions", () => {
    const robot = parseRobotJointModel(robotValue);
    const trajectory = parseJointTrajectory(trajectoryValue, robot, replay);
    expect(jointStateAt(trajectory, 5)).toEqual({ elbow: 0.5 });
  });

  it("fails closed on authority, joint, or clock drift", () => {
    const robot = parseRobotJointModel(robotValue);
    expect(() =>
      parseJointTrajectory({ ...trajectoryValue, authority: "visual_only" }, robot, replay),
    ).toThrow("authority");
    expect(() =>
      parseJointTrajectory({ ...trajectoryValue, joint_order: ["wrist"] }, robot, replay),
    ).toThrow("order");
    expect(() =>
      parseJointTrajectory(
        { ...trajectoryValue, epoch: "2026-07-10T00:01:00.000Z" },
        robot,
        replay,
      ),
    ).toThrow("epoch");
  });
});
