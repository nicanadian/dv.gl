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
 * Revisit / age-of-collection grid: for each cell, the scene time it was LAST
 * collected. The operator question is "where are we going stale" -- not how many
 * times a cell was hit (a vanity metric), but how long since the last look. This
 * is COVERAGE in the honest sense ("did see, how recently"), distinct from access
 * ("could see"): the grid only records where a footprint actually stamped.
 *
 * Row convention: row 0 is the NORTH edge (lat +90 decreasing), so `ageTexture`
 * fills a top-down raster ready to upload as an equirectangular texture.
 *
 * dv.gl provides the mechanism (accumulate + age); the app owns what "collected"
 * means and the colour ramp / window thresholds.
 */

function unit(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

export class RevisitGrid {
  readonly nLat: number;
  readonly nLon: number;
  /** Scene time (minutes) each cell was last collected; -Infinity = never. */
  readonly last: Float32Array;
  private readonly cellUnit: Float32Array;

  constructor(nLat = 120, nLon = 240) {
    this.nLat = nLat;
    this.nLon = nLon;
    this.last = new Float32Array(nLat * nLon).fill(Number.NEGATIVE_INFINITY);
    this.cellUnit = new Float32Array(nLat * nLon * 3);
    for (let i = 0; i < nLat; i += 1) {
      const lat = this.cellLat(i);
      for (let j = 0; j < nLon; j += 1) {
        const u = unit(lat, this.cellLon(j));
        const b = (i * nLon + j) * 3;
        this.cellUnit[b] = u[0];
        this.cellUnit[b + 1] = u[1];
        this.cellUnit[b + 2] = u[2];
      }
    }
  }

  /** Row 0 = north (+90), increasing i goes south. */
  cellLat(i: number): number {
    return 90 - ((i + 0.5) / this.nLat) * 180;
  }
  cellLon(j: number): number {
    return -180 + ((j + 0.5) / this.nLon) * 360;
  }

  /** Forget all history -- call on a scrub so the field never shows future looks. */
  reset(): void {
    this.last.fill(Number.NEGATIVE_INFINITY);
  }

  /**
   * Record a collection at scene time `nowMin`: every cell within
   * `centralAngleRad` of the sub-satellite point has its last-seen time set to
   * `nowMin` (a later look overwrites an earlier one).
   */
  stamp(subLatDeg: number, subLonDeg: number, centralAngleRad: number, nowMin: number): void {
    if (!(centralAngleRad > 0) || !Number.isFinite(nowMin)) return;
    const u = unit(subLatDeg, subLonDeg);
    const cosLambda = Math.cos(centralAngleRad);
    const lambdaDeg = (centralAngleRad * 180) / Math.PI;
    // rows run north->south, so the covered latitude band maps to a row window
    const iLo = Math.max(0, Math.floor(((90 - (subLatDeg + lambdaDeg)) / 180) * this.nLat));
    const iHi = Math.min(
      this.nLat - 1,
      Math.ceil(((90 - (subLatDeg - lambdaDeg)) / 180) * this.nLat),
    );
    for (let i = iLo; i <= iHi; i += 1) {
      for (let j = 0; j < this.nLon; j += 1) {
        const b = (i * this.nLon + j) * 3;
        const dot =
          u[0] * (this.cellUnit[b] ?? 0) +
          u[1] * (this.cellUnit[b + 1] ?? 0) +
          u[2] * (this.cellUnit[b + 2] ?? 0);
        if (dot >= cosLambda) {
          const idx = i * this.nLon + j;
          const prev = this.last[idx] ?? Number.NEGATIVE_INFINITY;
          if (nowMin > prev) this.last[idx] = nowMin;
        }
      }
    }
  }

  /**
   * Fill `out` (length nLat*nLon, row-major top-down) with an age bucket per cell:
   * 0 = never collected (render transparent); 1..255 = age scaled over `windowMin`
   * (1 = just collected/fresh, 255 = >= a window old/stale). Ready for an R8 texture.
   */
  ageTexture(nowMin: number, windowMin: number, out: Uint8Array): void {
    const w = windowMin > 0 ? windowMin : 1;
    for (let k = 0; k < this.last.length; k += 1) {
      const last = this.last[k] ?? Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(last)) {
        out[k] = 0;
        continue;
      }
      const frac = Math.min(1, Math.max(0, (nowMin - last) / w));
      out[k] = 1 + Math.round(frac * 254);
    }
  }

  /** Number of cells collected at least once. */
  countCovered(): number {
    let n = 0;
    for (const v of this.last) if (Number.isFinite(v)) n += 1;
    return n;
  }
}
