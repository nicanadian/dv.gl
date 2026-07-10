/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

export interface EciPosition {
  readonly xKm: number;
  readonly yKm: number;
  readonly zKm: number;
}

export interface AbsoluteSample {
  readonly timeSec: number;
  readonly position: EciPosition;
  readonly velocity: EciPosition;
}

export interface AbsolutePair {
  readonly epochMs: number;
  readonly durationSec: number;
  readonly runId: string;
  readonly gateId: string;
  readonly chaser: readonly AbsoluteSample[];
  readonly target: readonly AbsoluteSample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(value: unknown, role: string) {
  if (!isRecord(value)) throw new Error(`${role} ephemeris must be an object`);
  if (
    value.schema_version !== "ephemeris/1.0" ||
    value.frame_profile !== "skframe/v1" ||
    value.frame !== "ECI_J2000" ||
    value.length_units !== "km" ||
    value.velocity_units !== "km/s"
  ) {
    throw new Error(`${role} ephemeris contract mismatch`);
  }
  const provenance = isRecord(value.provenance) ? value.provenance : {};
  if (provenance.producer !== "pdb" || typeof provenance.run_id !== "string") {
    throw new Error(`${role} ephemeris requires pdb run provenance`);
  }
  if (!Array.isArray(value.points) || value.points.length < 2) {
    throw new Error(`${role} ephemeris requires at least two points`);
  }
  const first = value.points[0];
  if (!isRecord(first) || typeof first.time !== "string") {
    throw new Error(`${role} ephemeris first point is invalid`);
  }
  const epochMs = Date.parse(first.time);
  if (!Number.isFinite(epochMs)) throw new Error(`${role} ephemeris epoch is invalid`);
  const samples = value.points.map((point, index): AbsoluteSample => {
    if (!isRecord(point) || typeof point.time !== "string") {
      throw new Error(`${role} ephemeris point ${index} is invalid`);
    }
    const timestamp = Date.parse(point.time);
    const vector = point.position_eci_km;
    const velocity = point.velocity_eci_km_s;
    if (
      !Number.isFinite(timestamp) ||
      !Array.isArray(vector) ||
      vector.length !== 3 ||
      !vector.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ||
      !Array.isArray(velocity) ||
      velocity.length !== 3 ||
      !velocity.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      throw new Error(`${role} ephemeris point ${index} is invalid`);
    }
    return {
      timeSec: (timestamp - epochMs) / 1000,
      position: { xKm: vector[0], yKm: vector[1], zKm: vector[2] },
      velocity: { xKm: velocity[0], yKm: velocity[1], zKm: velocity[2] },
    };
  });
  return { epochMs, runId: provenance.run_id, samples };
}

export function parseAbsolutePair(
  chaserValue: unknown,
  targetValue: unknown,
  gateValue: unknown,
): AbsolutePair {
  const chaser = parseDocument(chaserValue, "chaser");
  const target = parseDocument(targetValue, "target");
  if (!isRecord(gateValue) || gateValue.schema_version !== "proximity_gate/0.1") {
    throw new Error("proximity gate contract mismatch");
  }
  const source = isRecord(gateValue.absolute_source) ? gateValue.absolute_source : {};
  if (
    typeof gateValue.gate_id !== "string" ||
    typeof gateValue.epoch !== "string" ||
    source.producer !== "pdb" ||
    source.run_id !== chaser.runId ||
    target.runId !== chaser.runId ||
    Date.parse(gateValue.epoch) !== chaser.epochMs ||
    target.epochMs !== chaser.epochMs ||
    target.samples.length !== chaser.samples.length
  ) {
    throw new Error("absolute evidence does not bind to the proximity gate");
  }
  for (let index = 0; index < chaser.samples.length; index += 1) {
    if (chaser.samples[index]?.timeSec !== target.samples[index]?.timeSec) {
      throw new Error("absolute ephemeris timestamps do not align");
    }
  }
  return {
    epochMs: chaser.epochMs,
    durationSec: chaser.samples.at(-1)?.timeSec ?? 0,
    runId: chaser.runId,
    gateId: gateValue.gate_id,
    chaser: chaser.samples,
    target: target.samples,
  };
}

function interpolate(samples: readonly AbsoluteSample[], timeSec: number): AbsoluteSample {
  const clamped = Math.max(0, Math.min(samples.at(-1)?.timeSec ?? 0, timeSec));
  let rightIndex = samples.findIndex((sample) => sample.timeSec >= clamped);
  if (rightIndex < 0) rightIndex = samples.length - 1;
  const right = samples[rightIndex];
  if (!right) throw new Error("absolute ephemeris has no samples");
  const left = samples[Math.max(0, rightIndex - 1)] ?? right;
  const span = right.timeSec - left.timeSec;
  const amount = span > 0 ? (clamped - left.timeSec) / span : 0;
  const vector = (first: EciPosition, second: EciPosition): EciPosition => ({
    xKm: first.xKm + (second.xKm - first.xKm) * amount,
    yKm: first.yKm + (second.yKm - first.yKm) * amount,
    zKm: first.zKm + (second.zKm - first.zKm) * amount,
  });
  return {
    timeSec: clamped,
    position: vector(left.position, right.position),
    velocity: vector(left.velocity, right.velocity),
  };
}

export function absoluteStateAt(pair: AbsolutePair, timeSec: number) {
  return {
    chaser: interpolate(pair.chaser, timeSec),
    target: interpolate(pair.target, timeSec),
  };
}
