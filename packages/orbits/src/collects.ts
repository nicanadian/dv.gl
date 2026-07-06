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

/**
 * Tasked collects: a scheduler's planned imaging activities, each an owning
 * satellite + time window + ground target. This is what a "footprint" actually is
 * -- a planned/active collect on the ground, not a nominal sensor swath. dv.gl
 * gives the time model + ground geometry; the app owns styling and how a collect
 * drives coverage.
 *
 * The upstream scheduler (pdb csched) emits a target POINT + look angle, not a
 * footprint polygon, so we synthesize the ground box here from target + size.
 */

const EARTH_R_KM = 6371.0088;

export interface Collect {
  readonly id: string;
  readonly sat: string;
  /** Seconds since the mission epoch. */
  readonly startSec: number;
  readonly endSec: number;
  readonly targetLatDeg: number;
  readonly targetLonDeg: number;
  readonly lookAngleDeg?: number | undefined;
  readonly sensor?: string | undefined;
  readonly gsdM?: number | undefined;
  readonly priority?: number | undefined;
}

interface RawCollect {
  id: string;
  sat: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  targetLatDeg: number;
  targetLonDeg: number;
  lookAngleDeg?: number;
  sensor?: string;
  gsdM?: number;
  priority?: number;
}

/**
 * Parse a mission.collects.json ({epoch, collects[]}) into Collects with times in
 * seconds relative to `epochMs` (the same epoch the ephemeris/clock uses). Drops
 * entries with non-finite times or targets; sorts by start.
 */
export function parseCollects(
  raw: { collects?: readonly RawCollect[] },
  epochMs: number,
): Collect[] {
  const out: Collect[] = [];
  for (const c of raw.collects ?? []) {
    const startSec = (Date.parse(c.start) - epochMs) / 1000;
    const endSec = (Date.parse(c.end) - epochMs) / 1000;
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      !Number.isFinite(c.targetLatDeg) ||
      !Number.isFinite(c.targetLonDeg)
    ) {
      continue;
    }
    out.push({
      id: c.id,
      sat: c.sat,
      startSec,
      endSec: Math.max(endSec, startSec),
      targetLatDeg: c.targetLatDeg,
      targetLonDeg: c.targetLonDeg,
      lookAngleDeg: c.lookAngleDeg,
      sensor: c.sensor,
      gsdM: c.gsdM,
      priority: c.priority,
    });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

export type CollectState = "upcoming" | "active" | "recent" | "idle";

/**
 * Where a collect sits relative to scene time `nowSec`: `active` during its
 * window, `upcoming` within `leadSec` before it, `recent` within `trailSec`
 * after, else `idle` (not worth drawing).
 */
export function collectState(
  c: Collect,
  nowSec: number,
  leadSec: number,
  trailSec: number,
): CollectState {
  if (nowSec >= c.startSec && nowSec <= c.endSec) return "active";
  if (nowSec < c.startSec && c.startSec - nowSec <= leadSec) return "upcoming";
  if (nowSec > c.endSec && nowSec - c.endSec <= trailSec) return "recent";
  return "idle";
}

function unit(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

/**
 * A closed ring of `segments` ground points (ECEF km, stride 3, lifted `bumpKm`)
 * of radius `radiusKm` around the target -- the collect's footprint box on the
 * ground. Frame-agnostic on the sphere; the caller rotates ECEF->world by GMST.
 */
export function collectGroundRing(
  latDeg: number,
  lonDeg: number,
  radiusKm: number,
  segments = 20,
  bumpKm = 4,
): Float32Array {
  const u = unit(latDeg, lonDeg);
  // tangent basis orthogonal to u
  const ref: [number, number, number] = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1x = u[1] * ref[2] - u[2] * ref[1];
  const e1y = u[2] * ref[0] - u[0] * ref[2];
  const e1z = u[0] * ref[1] - u[1] * ref[0];
  const e1l = Math.hypot(e1x, e1y, e1z) || 1;
  const e1: [number, number, number] = [e1x / e1l, e1y / e1l, e1z / e1l];
  const e2: [number, number, number] = [
    u[1] * e1[2] - u[2] * e1[1],
    u[2] * e1[0] - u[0] * e1[2],
    u[0] * e1[1] - u[1] * e1[0],
  ];
  const alpha = radiusKm / EARTH_R_KM; // small central angle
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const rad = EARTH_R_KM + bumpKm;
  const out = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i += 1) {
    const phi = (i / segments) * 2 * Math.PI;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let c = 0; c < 3; c += 1) {
      const dir = ca * (u[c] ?? 0) + sa * (cp * (e1[c] ?? 0) + sp * (e2[c] ?? 0));
      out[i * 3 + c] = dir * rad;
    }
  }
  return out;
}

/** Target point on the surface (ECEF km, lifted `bumpKm`). */
export function collectTargetEcef(
  latDeg: number,
  lonDeg: number,
  bumpKm = 4,
): [number, number, number] {
  const u = unit(latDeg, lonDeg);
  const r = EARTH_R_KM + bumpKm;
  return [u[0] * r, u[1] * r, u[2] * r];
}
