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
import * as satellite from "satellite.js";
import type { CatalogObject } from "./catalog.js";

type SatRec = ReturnType<typeof satellite.twoline2satrec>;

export interface PropagationSource {
  /** Number of objects this source was initialized with. */
  readonly count: number;
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

/**
 * CPU SGP4 source backed by satellite.js (fp64 Vallado). Invalid TLEs are dropped at
 * init and reported, never silently propagated.
 */
export class SatelliteJsSource implements PropagationSource {
  private readonly recs: Rec[] = [];
  readonly rejected: { readonly name: string; readonly reason: string }[] = [];

  constructor(objects: readonly CatalogObject[], scenarioEpochMs?: number) {
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
      const probe = satellite.sgp4(satrec, 0) as unknown as
        | false
        | { position: boolean | { x: number } };
      if (
        !Number.isFinite(satrec.jdsatepoch) ||
        probe === false ||
        typeof probe.position === "boolean" ||
        !Number.isFinite(probe.position.x)
      ) {
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
      this.recs.push({ satrec, epochOffsetMinutes });
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
      // The 5.x typings say sgp4 never returns false, but older API surfaces did;
      // widen at the boundary and keep the defensive check.
      const result = satellite.sgp4(rec.satrec, t) as unknown as
        | false
        | { position: boolean | { x: number; y: number; z: number } };
      const base = k * 3;
      if (result === false || typeof result.position === "boolean") {
        out[base] = Number.NaN;
        out[base + 1] = Number.NaN;
        out[base + 2] = Number.NaN;
        failed += 1;
      } else {
        out[base] = result.position.x;
        out[base + 1] = result.position.y;
        out[base + 2] = result.position.z;
        written += 1;
      }
    }
    return { written, failed };
  }
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
