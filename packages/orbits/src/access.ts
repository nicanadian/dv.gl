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
 * Ground-station access geometry: elevation angle of a satellite above a station's
 * local horizon, and the visibility windows (an @dvgl/core IntervalSet) where the
 * satellite is above the station's elevation mask. Pure geometry -- the app owns
 * what a station IS (catalog, SLA, band); dv.gl answers "can this station see this
 * object, and when."
 *
 * Convention: satellite positions come from a PropagationSource in TEME (inertial);
 * the station is Earth-fixed. Each evaluation rotates the satellite into ECEF at
 * that instant via GMST, then computes the topocentric elevation against the
 * station's geodetic up.
 */
import { IntervalSet } from "@dvgl/core";
import { geodeticToEcef, gmst } from "@dvgl/frames";
import type { PropagationSource } from "./propagation.js";

export interface GroundStation {
  readonly name: string;
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly heightKm?: number;
  /** Minimum elevation for a usable pass, degrees. Default 5. */
  readonly minElevationDeg?: number;
}

export interface StationEcef {
  readonly ecef: readonly [number, number, number];
  /** Geodetic up (local vertical) unit vector at the station. */
  readonly up: readonly [number, number, number];
}

/** Precompute a station's fixed ECEF position and local-up vector. */
export function stationEcef(station: GroundStation): StationEcef {
  const ecef = geodeticToEcef(station.latDeg, station.lonDeg, station.heightKm ?? 0);
  const lat = (station.latDeg * Math.PI) / 180;
  const lon = (station.lonDeg * Math.PI) / 180;
  const up: [number, number, number] = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
  return { ecef, up };
}

/**
 * Elevation of an ECEF satellite position above the station's local horizon,
 * degrees. Negative means below the horizon.
 */
export function elevationDeg(st: StationEcef, satEcef: readonly [number, number, number]): number {
  const dx = satEcef[0] - st.ecef[0];
  const dy = satEcef[1] - st.ecef[1];
  const dz = satEcef[2] - st.ecef[2];
  const range = Math.hypot(dx, dy, dz);
  if (range < 1e-9) return 90;
  const dot = (dx * st.up[0] + dy * st.up[1] + dz * st.up[2]) / range;
  return (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Rotate a TEME position into ECEF at absolute time `unixMs`. */
function temeToEcefPoint(
  x: number,
  y: number,
  z: number,
  unixMs: number,
): [number, number, number] {
  const theta = gmst(unixMs);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c * x + s * y, -s * x + c * y, z];
}

export interface AccessOptions {
  /** Scene-time window start/end, minutes since epoch. */
  readonly startMinutes: number;
  readonly endMinutes: number;
  /** Coarse sample step, minutes. Default 0.5 (30 s). */
  readonly stepMinutes?: number;
}

/**
 * Visibility windows of object `objectIndex` from `station` over the given scene-
 * time span. Samples elevation on a coarse grid, then refines each mask crossing by
 * bisection so rise/set times are accurate to ~1 s regardless of step. Returns an
 * IntervalSet in scene-seconds.
 */
export function accessWindows(
  station: GroundStation,
  source: PropagationSource,
  epochMs: number,
  objectIndex: number,
  options: AccessOptions,
): IntervalSet {
  const st = stationEcef(station);
  const mask = station.minElevationDeg ?? 5;
  const step = options.stepMinutes ?? 0.5;
  const scratch = new Float32Array(source.count * 3);
  const base = objectIndex * 3;

  const elevAt = (tMin: number): number => {
    source.propagateInto(tMin, scratch);
    const x = scratch[base] ?? Number.NaN;
    const y = scratch[base + 1] ?? Number.NaN;
    const z = scratch[base + 2] ?? Number.NaN;
    if (!Number.isFinite(x)) return Number.NEGATIVE_INFINITY;
    return elevationDeg(st, temeToEcefPoint(x, y, z, epochMs + tMin * 60_000));
  };

  const raw: { startSec: number; endSec: number }[] = [];
  let prevT = options.startMinutes;
  let prevE = elevAt(prevT);
  let inPass = prevE >= mask;
  let riseSec = inPass ? prevT * 60 : Number.NaN;

  const crossing = (a: number, b: number): number => {
    // bisect for the time where elevation == mask between a (min) and b (min)
    let lo = a;
    let hi = b;
    for (let i = 0; i < 24; i += 1) {
      const midT = (lo + hi) / 2;
      const midE = elevAt(midT);
      if (midE >= mask === elevAt(lo) >= mask) lo = midT;
      else hi = midT;
    }
    return ((lo + hi) / 2) * 60;
  };

  for (let t = options.startMinutes + step; t <= options.endMinutes + 1e-9; t += step) {
    const e = elevAt(t);
    const above = e >= mask;
    if (above && !inPass) {
      riseSec = crossing(prevT, t);
      inPass = true;
    } else if (!above && inPass) {
      raw.push({ startSec: riseSec, endSec: crossing(prevT, t) });
      inPass = false;
    }
    prevT = t;
    prevE = e;
  }
  if (inPass) raw.push({ startSec: riseSec, endSec: options.endMinutes * 60 });
  void prevE;
  return IntervalSet.from(raw);
}
