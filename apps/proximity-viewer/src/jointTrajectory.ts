/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import type { ParsedReplay } from "./replay.js";

export interface RobotJoint {
  readonly name: string;
  readonly type: "revolute" | "prismatic";
  readonly axis: readonly [number, number, number];
  readonly lower: number;
  readonly upper: number;
  readonly maxVelocity: number;
}

export interface RobotJointModel {
  readonly name: string;
  readonly joints: readonly RobotJoint[];
}

export interface JointTrajectorySample {
  readonly timeSec: number;
  readonly positions: Readonly<Record<string, number>>;
}

export interface ParsedJointTrajectory {
  readonly trajectoryId: string;
  readonly intent: "ready_to_pregrasp_rehearsal";
  readonly robotName: string;
  readonly samples: readonly JointTrajectorySample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function axis(value: unknown, field: string): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${field} must have 3 axes`);
  const result = value.map(Number) as [number, number, number];
  if (!result.every(Number.isFinite) || Math.abs(Math.hypot(...result) - 1) > 1e-9) {
    throw new Error(`${field} must be a unit vector`);
  }
  return result;
}

export function parseRobotJointModel(value: unknown): RobotJointModel {
  if (!isRecord(value) || value.schema_version !== "robot/v1" || value.angle_units !== "rad") {
    throw new Error("robot joint model contract mismatch");
  }
  if (!Array.isArray(value.joints)) throw new Error("robot joint model requires joints");
  const joints = value.joints.flatMap((entry, index): RobotJoint[] => {
    if (!isRecord(entry)) throw new Error(`robot joint ${index} must be an object`);
    if (entry.type === "fixed") return [];
    if (entry.type !== "revolute" && entry.type !== "prismatic") {
      throw new Error(`robot joint ${index} has unsupported type`);
    }
    if (!isRecord(entry.limit)) throw new Error(`robot joint ${index} requires limits`);
    const lower = finite(entry.limit.lower, `robot joint ${index} lower limit`);
    const upper = finite(entry.limit.upper, `robot joint ${index} upper limit`);
    const maxVelocity = finite(entry.limit.velocity, `robot joint ${index} velocity limit`);
    if (lower >= upper || maxVelocity <= 0)
      throw new Error(`robot joint ${index} limits are invalid`);
    return [
      {
        name: string(entry.name, `robot joint ${index} name`),
        type: entry.type,
        axis: axis(entry.axis, `robot joint ${index} axis`),
        lower,
        upper,
        maxVelocity,
      },
    ];
  });
  if (joints.length === 0 || new Set(joints.map((joint) => joint.name)).size !== joints.length) {
    throw new Error("robot joint names must be non-empty and unique");
  }
  return { name: string(value.name, "robot name"), joints };
}

export function parseJointTrajectory(
  value: unknown,
  robot: RobotJointModel,
  replay: ParsedReplay,
): ParsedJointTrajectory {
  if (!isRecord(value) || value.schema_version !== "robot_joint_trajectory/1.0") {
    throw new Error("joint trajectory contract mismatch");
  }
  if (
    value.authority !== "simulation_evidence_only" ||
    value.time_basis !== "source_replay_epoch" ||
    value.angle_units !== "rad" ||
    value.intent !== "ready_to_pregrasp_rehearsal"
  ) {
    throw new Error("joint trajectory authority or scope mismatch");
  }
  if (value.epoch !== new Date(replay.epochMs).toISOString()) {
    throw new Error("joint trajectory does not share the replay epoch");
  }
  if (value.mission_id !== replay.missionId || value.contract_id !== replay.contractId) {
    throw new Error("joint trajectory mission binding mismatch");
  }
  if (!isRecord(value.robot) || value.robot.name !== robot.name) {
    throw new Error("joint trajectory robot binding mismatch");
  }
  if (
    value.robot.model_schema_version !== "robot/v1" ||
    value.robot.hash_basis !== "canonical_json" ||
    typeof value.robot.model_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.robot.model_sha256)
  ) {
    throw new Error("joint trajectory robot hash contract mismatch");
  }
  if (
    !isRecord(value.source_replay) ||
    value.source_replay.schema_version !== "replay/1.0" ||
    value.source_replay.hash_basis !== "canonical_json" ||
    typeof value.source_replay.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.source_replay.sha256) ||
    value.source_replay.duration_s !== replay.durationSec
  ) {
    throw new Error("joint trajectory replay binding mismatch");
  }

  const names = robot.joints.map((joint) => joint.name);
  if (!Array.isArray(value.joint_order) || value.joint_order.join("\0") !== names.join("\0")) {
    throw new Error("joint trajectory order does not match robot/v1");
  }
  if (!isRecord(value.constraints) || !isRecord(value.simulation)) {
    throw new Error("joint trajectory constraints and simulation are required");
  }
  if (
    value.simulation.adapter !== "deterministic_piecewise_linear_joint_sampler/v1" ||
    value.simulation.accepted !== true ||
    !Array.isArray(value.simulation.reason_codes) ||
    value.simulation.reason_codes.length !== 0
  ) {
    throw new Error("joint trajectory simulation was not accepted");
  }
  for (const joint of robot.joints) {
    const constraint = value.constraints[joint.name];
    if (
      !isRecord(constraint) ||
      constraint.lower_rad !== joint.lower ||
      constraint.upper_rad !== joint.upper ||
      constraint.max_velocity_radps !== joint.maxVelocity
    ) {
      throw new Error(`joint trajectory constraint drift for ${joint.name}`);
    }
  }

  if (!Array.isArray(value.samples) || value.samples.length < 2) {
    throw new Error("joint trajectory requires at least two samples");
  }
  let previous = -Infinity;
  const samples = value.samples.map((entry, index): JointTrajectorySample => {
    if (!isRecord(entry) || !isRecord(entry.positions_rad)) {
      throw new Error(`joint trajectory sample ${index} is malformed`);
    }
    const timeSec = finite(entry.t_rel_s, `joint trajectory sample ${index} time`);
    if (timeSec <= previous) throw new Error("joint trajectory times must increase strictly");
    previous = timeSec;
    if (entry.t !== new Date(replay.epochMs + timeSec * 1000).toISOString()) {
      throw new Error(`joint trajectory sample ${index} timestamp mismatch`);
    }
    const positions: Record<string, number> = {};
    if (Object.keys(entry.positions_rad).length !== robot.joints.length) {
      throw new Error(`joint trajectory sample ${index} joint set mismatch`);
    }
    for (const joint of robot.joints) {
      const position = finite(
        entry.positions_rad[joint.name],
        `joint trajectory sample ${index} ${joint.name}`,
      );
      if (position < joint.lower || position > joint.upper) {
        throw new Error(`joint trajectory sample ${index} exceeds ${joint.name} limits`);
      }
      positions[joint.name] = position;
    }
    return { timeSec, positions };
  });
  if (samples[0]?.timeSec !== 0 || samples.at(-1)?.timeSec !== replay.durationSec) {
    throw new Error("joint trajectory must cover the complete replay window");
  }
  if (
    !isRecord(value.provenance) ||
    value.provenance.producer !== "sublime-kinematics" ||
    value.provenance.deterministic !== true ||
    value.provenance.not_hardware !== true ||
    !Array.isArray(value.unsupported_evidence) ||
    !value.unsupported_evidence.includes("hardware_execution")
  ) {
    throw new Error("joint trajectory provenance or unsupported scope mismatch");
  }
  return {
    trajectoryId: string(value.trajectory_id, "joint trajectory id"),
    intent: "ready_to_pregrasp_rehearsal",
    robotName: robot.name,
    samples,
  };
}

export function jointStateAt(
  trajectory: ParsedJointTrajectory,
  requestedTimeSec: number,
): Readonly<Record<string, number>> {
  const last = trajectory.samples.at(-1);
  if (!last) throw new Error("joint trajectory has no samples");
  const timeSec = Math.min(last.timeSec, Math.max(0, requestedTimeSec));
  let rightIndex = trajectory.samples.findIndex((sample) => sample.timeSec >= timeSec);
  if (rightIndex < 0) rightIndex = trajectory.samples.length - 1;
  const right = trajectory.samples[rightIndex] ?? last;
  const left = trajectory.samples[Math.max(0, rightIndex - 1)] ?? right;
  const span = right.timeSec - left.timeSec;
  const amount = span > 0 ? (timeSec - left.timeSec) / span : 0;
  return Object.fromEntries(
    Object.keys(left.positions).map((name) => [
      name,
      (left.positions[name] ?? 0) +
        ((right.positions[name] ?? 0) - (left.positions[name] ?? 0)) * amount,
    ]),
  );
}
