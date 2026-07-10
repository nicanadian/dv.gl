/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

export const REPLAY_SCHEMA_VERSION = "replay/1.0";
export const REPLAY_FRAME_PROFILE = "skframe/v1";
export const REPLAY_FRAME = "LVLH_RIC";

export interface RelativePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuaternionXyzw {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface ReplaySample {
  readonly phase: string;
  readonly isoTime: string;
  readonly timeSec: number;
  readonly position: RelativePosition;
  readonly chaserAttitudeBodyToEci: QuaternionXyzw;
  readonly targetAttitudeBodyToEci: QuaternionXyzw;
}

export interface ParsedReplay {
  readonly schemaVersion: typeof REPLAY_SCHEMA_VERSION;
  readonly frameProfile: typeof REPLAY_FRAME_PROFILE;
  readonly frame: typeof REPLAY_FRAME;
  readonly missionId: string;
  readonly contractId: string;
  readonly epochMs: number;
  readonly durationSec: number;
  readonly samples: readonly ReplaySample[];
  readonly sourceDescription: string;
  readonly notOfficialModel: boolean;
}

export interface InterpolatedReplayState {
  readonly phase: string;
  readonly timeSec: number;
  readonly position: RelativePosition;
  readonly chaserAttitudeBodyToEci: QuaternionXyzw;
  readonly targetAttitudeBodyToEci: QuaternionXyzw;
  readonly separationM: number;
  readonly progress: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`replay field ${key} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`replay field ${key} must be finite`);
  }
  return value;
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function parseQuaternion(value: unknown, field: string): QuaternionXyzw {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${field} must be scalar-last [x,y,z,w]`);
  }
  const components = value.map(Number);
  const norm = Math.hypot(...components);
  if (!components.every(Number.isFinite) || Math.abs(norm - 1) > 1e-6) {
    throw new Error(`${field} must be a unit quaternion`);
  }
  const [x, y, z, w] = components as [number, number, number, number];
  return { x, y, z, w };
}

export function parseReplay(value: unknown): ParsedReplay {
  if (!isRecord(value)) throw new Error("replay document must be an object");
  if (value.schema_version !== REPLAY_SCHEMA_VERSION) {
    throw new Error(`unsupported replay schema ${String(value.schema_version)}`);
  }
  if (value.frame_profile !== REPLAY_FRAME_PROFILE) {
    throw new Error(`proximity viewer requires ${REPLAY_FRAME_PROFILE}`);
  }
  if (value.frame !== REPLAY_FRAME) {
    throw new Error(`proximity viewer requires ${REPLAY_FRAME}`);
  }
  if (value.length_units !== "m" || value.velocity_units !== "m/s") {
    throw new Error("proximity viewer requires meters and meters/second");
  }

  const epochMs = parseTimestamp(requiredString(value, "epoch"), "epoch");
  if (!Array.isArray(value.samples) || value.samples.length < 2) {
    throw new Error("replay requires at least two samples");
  }

  const samples = value.samples.map((entry, index): ReplaySample => {
    if (!isRecord(entry)) throw new Error(`sample ${index} must be an object`);
    const isoTime = requiredString(entry, "t");
    const timestamp = parseTimestamp(isoTime, `sample ${index} time`);
    if (!isRecord(entry.relative_state)) {
      throw new Error(`sample ${index} requires relative_state`);
    }
    const attitude = isRecord(entry.attitude_body_to_eci) ? entry.attitude_body_to_eci : {};
    if (
      attitude.frame !== "ECI_J2000" ||
      attitude.convention !== "body_to_inertial" ||
      attitude.quaternion_order !== "xyzw"
    ) {
      throw new Error(`sample ${index} attitude contract mismatch`);
    }
    return {
      phase: requiredString(entry, "phase"),
      isoTime,
      timeSec: (timestamp - epochMs) / 1000,
      position: {
        x: finiteNumber(entry.relative_state, "x_m"),
        y: finiteNumber(entry.relative_state, "y_m"),
        z: finiteNumber(entry.relative_state, "z_m"),
      },
      chaserAttitudeBodyToEci: parseQuaternion(attitude.chaser, `sample ${index} chaser attitude`),
      targetAttitudeBodyToEci: parseQuaternion(attitude.target, `sample ${index} target attitude`),
    };
  });

  if (samples[0]?.timeSec !== 0) {
    throw new Error("first replay sample must match the replay epoch");
  }
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index]?.timeSec ?? 0) <= (samples[index - 1]?.timeSec ?? 0)) {
      throw new Error("replay sample times must increase strictly");
    }
  }

  const provenance = isRecord(value.provenance) ? value.provenance : {};
  const absoluteSource = isRecord(value.absolute_source) ? value.absolute_source : {};
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    frameProfile: REPLAY_FRAME_PROFILE,
    frame: REPLAY_FRAME,
    missionId: requiredString(value, "mission_id"),
    contractId: requiredString(value, "contract_id"),
    epochMs,
    durationSec: samples.at(-1)?.timeSec ?? 0,
    samples,
    sourceDescription:
      typeof absoluteSource.description === "string"
        ? absoluteSource.description
        : "source not described",
    notOfficialModel: provenance.not_official_model !== false,
  };
}

function lerp(first: number, second: number, amount: number): number {
  return first + (second - first) * amount;
}

function nlerpQuaternion(
  first: QuaternionXyzw,
  second: QuaternionXyzw,
  amount: number,
): QuaternionXyzw {
  const dot = first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w;
  const sign = dot < 0 ? -1 : 1;
  const x = lerp(first.x, second.x * sign, amount);
  const y = lerp(first.y, second.y * sign, amount);
  const z = lerp(first.z, second.z * sign, amount);
  const w = lerp(first.w, second.w * sign, amount);
  const norm = Math.hypot(x, y, z, w);
  return { x: x / norm, y: y / norm, z: z / norm, w: w / norm };
}

export function replayStateAt(
  replay: ParsedReplay,
  requestedTimeSec: number,
): InterpolatedReplayState {
  const timeSec = Math.min(replay.durationSec, Math.max(0, requestedTimeSec));
  let rightIndex = replay.samples.findIndex((sample) => sample.timeSec >= timeSec);
  if (rightIndex < 0) rightIndex = replay.samples.length - 1;
  const right = replay.samples[rightIndex];
  if (!right) throw new Error("replay has no samples");
  const left = replay.samples[Math.max(0, rightIndex - 1)] ?? right;
  const span = right.timeSec - left.timeSec;
  const amount = span > 0 ? (timeSec - left.timeSec) / span : 0;
  const position = {
    x: lerp(left.position.x, right.position.x, amount),
    y: lerp(left.position.y, right.position.y, amount),
    z: lerp(left.position.z, right.position.z, amount),
  };
  return {
    phase: amount >= 1 ? right.phase : left.phase,
    timeSec,
    position,
    chaserAttitudeBodyToEci: nlerpQuaternion(
      left.chaserAttitudeBodyToEci,
      right.chaserAttitudeBodyToEci,
      amount,
    ),
    targetAttitudeBodyToEci: nlerpQuaternion(
      left.targetAttitudeBodyToEci,
      right.targetAttitudeBodyToEci,
      amount,
    ),
    separationM: Math.hypot(position.x, position.y, position.z),
    progress: replay.durationSec > 0 ? timeSec / replay.durationSec : 0,
  };
}
