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
 * The pluggable propagation seam. Both benchmark render paths consume the SAME
 * PropagationSource instance (a fairness rule); the source writes packed positions
 * into a caller-owned Float32Array so the hot path never allocates per epoch.
 *
 * Implementations:
 * - `SatelliteJsSource` (here): CPU fp64 Vallado SGP4 via satellite.js. The v0 runner
 *   uses this on both paths.
 * - sgp4.gl (planned): GPU SGP4 in WebGPU compute. Plugs in behind this same
 *   interface (vendored/pinned fork per the dependency posture); swapping it in does
 *   not change the harness or either path's consumption of the buffers.
 */
import { gmst } from "@dvgl/frames";
import * as satellite from "satellite.js";
import type { CatalogObject } from "./catalog.js";

type SatRec = ReturnType<typeof satellite.twoline2satrec>;

export interface PropagationSource {
  /** Number of objects this source was initialized with. */
  readonly count: number;
  /**
   * Evaluate every object across a time window of +/- one orbital period around
   * `centerMinutes`, `samples` points per object (odd; the middle sample is the
   * center). Writes [object][sample][xyz] km, stride 3, into `out`
   * (length >= count*samples*3). Optional: not every source can afford it.
   */
  /**
   * When `ecefEpochMs` is given (the absolute Unix ms of scene time zero), each
   * sample is rotated into the Earth-fixed frame by GMST AT THAT SAMPLE'S OWN
   * epoch -- the frame in which successive revs separate into the ground-track
   * weave instead of overlaying.
   */
  sampleWindowInto?(
    centerMinutes: number,
    samples: number,
    out: Float32Array,
    ecefEpochMs?: number,
  ): void;
  /**
   * Write TEME positions (km) at `minutesSinceEpoch` into `out` with stride 3
   * (x,y,z per object, in catalog order). Objects that fail to propagate are
   * written as NaN and counted in the return value's `failed`.
   */
  propagateInto(
    minutesSinceEpoch: number,
    out: Float32Array,
  ): { readonly written: number; readonly failed: number };
}

interface Rec {
  readonly satrec: SatRec;
  /** Offset of this object's TLE epoch from the scenario epoch, minutes. */
  readonly epochOffsetMinutes: number;
}

export interface SourceOptions {
  /**
   * Workload multiplier: each valid object is instantiated `replicate` times, with
   * replica k phase-shifted by k * `replicaPhaseMinutes` along its own orbit. The
   * replicas are physically plausible distinct objects (same elements, different
   * phase), so a 16k catalog scales to a 64k/160k stress workload without a bigger
   * snapshot. Default 1 (no replication).
   */
  readonly replicate?: number;
  /** Phase step between replicas, minutes. Default 17 (co-prime-ish with periods). */
  readonly replicaPhaseMinutes?: number;
}

/**
 * CPU SGP4 source backed by satellite.js (fp64 Vallado). Invalid TLEs are dropped at
 * init and reported, never silently propagated.
 */
export class SatelliteJsSource implements PropagationSource {
  private readonly recs: Rec[] = [];
  readonly rejected: { readonly name: string; readonly reason: string }[] = [];

  constructor(
    objects: readonly CatalogObject[],
    scenarioEpochMs?: number,
    options?: SourceOptions,
  ) {
    const replicate = Math.max(1, Math.floor(options?.replicate ?? 1));
    const phase = options?.replicaPhaseMinutes ?? 17;
    for (const o of objects) {
      let satrec: SatRec;
      try {
        satrec = satellite.twoline2satrec(o.line1, o.line2);
      } catch (err) {
        this.rejected.push({ name: o.name, reason: String(err) });
        continue;
      }
      if (satrec.error !== 0) {
        this.rejected.push({ name: o.name, reason: `satrec error ${satrec.error}` });
        continue;
      }
      // twoline2satrec is lenient: garbage lines can parse to NaN elements with
      // error still 0. Gate on an actual propagation at the TLE's own epoch.
      const probe = readPosition(satellite.sgp4(satrec, 0));
      if (!Number.isFinite(satrec.jdsatepoch) || probe === undefined) {
        this.rejected.push({ name: o.name, reason: "non-finite propagation at epoch" });
        continue;
      }
      // satellite.js propagates in minutes since the TLE's own epoch. To evaluate the
      // whole catalog at one shared scenario time, precompute each object's offset.
      let epochOffsetMinutes = 0;
      if (scenarioEpochMs !== undefined) {
        const tleEpochMs = jdayToUnixMs(satrec.jdsatepoch);
        epochOffsetMinutes = (scenarioEpochMs - tleEpochMs) / 60_000;
      }
      for (let r = 0; r < replicate; r += 1) {
        this.recs.push({ satrec, epochOffsetMinutes: epochOffsetMinutes + r * phase });
      }
    }
  }

  get count(): number {
    return this.recs.length;
  }

  propagateInto(minutesSinceEpoch: number, out: Float32Array): { written: number; failed: number } {
    if (out.length < this.recs.length * 3) {
      throw new Error(`output buffer too small: need ${this.recs.length * 3}, got ${out.length}`);
    }
    let written = 0;
    let failed = 0;
    for (let k = 0; k < this.recs.length; k += 1) {
      const rec = this.recs[k];
      if (rec === undefined) continue;
      const t = minutesSinceEpoch + rec.epochOffsetMinutes;
      const pos = readPosition(satellite.sgp4(rec.satrec, t));
      const base = k * 3;
      if (pos === undefined) {
        out[base] = Number.NaN;
        out[base + 1] = Number.NaN;
        out[base + 2] = Number.NaN;
        failed += 1;
      } else {
        out[base] = pos.x;
        out[base + 1] = pos.y;
        out[base + 2] = pos.z;
        written += 1;
      }
    }
    return { written, failed };
  }

  /** Orbital period of object k, minutes (exact, from the mean motion). */
  periodMinutes(k: number): number {
    const rec = this.recs[k];
    if (rec === undefined) return Number.NaN;
    return (2 * Math.PI) / rec.satrec.no;
  }

  /** +/- one period around centerMinutes, `samples` points per object. */
  sampleWindowInto(
    centerMinutes: number,
    samples: number,
    out: Float32Array,
    ecefEpochMs?: number,
  ): void {
    const n = this.recs.length;
    if (out.length < n * samples * 3) {
      throw new Error(`window buffer too small: need ${n * samples * 3}`);
    }
    for (let k = 0; k < n; k += 1) {
      const rec = this.recs[k];
      if (rec === undefined) continue;
      const period = (2 * Math.PI) / rec.satrec.no;
      for (let s = 0; s < samples; s += 1) {
        const frac = (s / (samples - 1)) * 2 - 1; // [-1, 1]
        const tMin = centerMinutes + frac * period;
        const pos = readPosition(satellite.sgp4(rec.satrec, tMin + rec.epochOffsetMinutes));
        const base = (k * samples + s) * 3;
        if (pos === undefined) {
          out[base] = Number.NaN;
          out[base + 1] = Number.NaN;
          out[base + 2] = Number.NaN;
        } else if (ecefEpochMs !== undefined) {
          // rotate THIS sample by GMST at its own epoch: the ground-track weave
          const theta = gmst(ecefEpochMs + tMin * 60_000);
          const c = Math.cos(theta);
          const si = Math.sin(theta);
          out[base] = c * pos.x + si * pos.y;
          out[base + 1] = -si * pos.x + c * pos.y;
          out[base + 2] = pos.z;
        } else {
          out[base] = pos.x;
          out[base + 1] = pos.y;
          out[base + 2] = pos.z;
        }
      }
    }
  }
}

/**
 * Extract a finite position from whatever satellite.js sgp4 returned. Observed
 * failure shapes across versions and orbit regimes: `false`, `position: false`,
 * `position: undefined` (objects that error mid-window, e.g. decayed or deep-space
 * edge cases in a real catalog), and NaN components. All map to `undefined`.
 */
export function readPosition(result: unknown): { x: number; y: number; z: number } | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const pos = (result as { position?: unknown }).position;
  if (pos === null || typeof pos !== "object") return undefined;
  const p = pos as { x?: unknown; y?: unknown; z?: unknown };
  if (
    typeof p.x !== "number" ||
    typeof p.y !== "number" ||
    typeof p.z !== "number" ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    !Number.isFinite(p.z)
  ) {
    return undefined;
  }
  return { x: p.x, y: p.y, z: p.z };
}

/** Julian day to Unix epoch milliseconds. */
export function jdayToUnixMs(jd: number): number {
  return (jd - 2440587.5) * 86_400_000;
}

/**
 * Epoch (Unix ms) of the first valid TLE in the catalog — the deterministic scenario
 * epoch the runner anchors its 7-day window to.
 */
export function catalogEpochMs(objects: readonly CatalogObject[]): number | undefined {
  for (const o of objects) {
    try {
      const satrec = satellite.twoline2satrec(o.line1, o.line2);
      if (satrec.error === 0) return jdayToUnixMs(satrec.jdsatepoch);
    } catch {
      // skip unparseable entries; the source reports them at init
    }
  }
  return undefined;
}
