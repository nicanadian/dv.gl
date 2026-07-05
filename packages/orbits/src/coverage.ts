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
 * Coverage accumulation over an equirectangular lat/lon grid: stamp each sensor
 * footprint (a small cap around a sub-satellite point) and accumulate how many
 * times each cell has been seen. The mechanism dv.gl provides -- "where has the
 * fleet looked, how often"; the app owns the colour map, thresholds, and what
 * "covered" means (billing, requirement satisfaction).
 */

function unit(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

export class CoverageGrid {
  readonly nLat: number;
  readonly nLon: number;
  /** Accumulated hit count per cell, row-major [lat][lon]. */
  readonly data: Float32Array;
  private readonly cellUnit: Float32Array; // precomputed cell-centre unit vectors

  constructor(nLat = 90, nLon = 180) {
    this.nLat = nLat;
    this.nLon = nLon;
    this.data = new Float32Array(nLat * nLon);
    this.cellUnit = new Float32Array(nLat * nLon * 3);
    for (let i = 0; i < nLat; i += 1) {
      const lat = -90 + ((i + 0.5) / nLat) * 180;
      for (let j = 0; j < nLon; j += 1) {
        const lon = -180 + ((j + 0.5) / nLon) * 360;
        const u = unit(lat, lon);
        const b = (i * nLon + j) * 3;
        this.cellUnit[b] = u[0];
        this.cellUnit[b + 1] = u[1];
        this.cellUnit[b + 2] = u[2];
      }
    }
  }

  reset(): void {
    this.data.fill(0);
  }

  /** Lat (deg) of grid row i, lon (deg) of grid col j -- the cell centre. */
  cellLat(i: number): number {
    return -90 + ((i + 0.5) / this.nLat) * 180;
  }
  cellLon(j: number): number {
    return -180 + ((j + 0.5) / this.nLon) * 360;
  }

  /**
   * Add `weight` to every cell within `centralAngleRad` of the sub-satellite
   * point (a spherical cap). Only rows within the cap's latitude band are tested.
   */
  stamp(subLatDeg: number, subLonDeg: number, centralAngleRad: number, weight = 1): void {
    if (!(centralAngleRad > 0)) return;
    const u = unit(subLatDeg, subLonDeg);
    const cosLambda = Math.cos(centralAngleRad);
    const lambdaDeg = (centralAngleRad * 180) / Math.PI;
    const iLo = Math.max(0, Math.floor(((subLatDeg - lambdaDeg + 90) / 180) * this.nLat));
    const iHi = Math.min(
      this.nLat - 1,
      Math.ceil(((subLatDeg + lambdaDeg + 90) / 180) * this.nLat),
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
          this.data[idx] = (this.data[idx] ?? 0) + weight;
        }
      }
    }
  }

  /** Number of cells with any coverage. */
  countCovered(): number {
    let n = 0;
    for (const v of this.data) if (v > 0) n += 1;
    return n;
  }

  /** Peak accumulation over all cells. */
  max(): number {
    let m = 0;
    for (const v of this.data) if (v > m) m = v;
    return m;
  }

  /** Visit each covered cell with its centre lat/lon and value. */
  forEachCovered(cb: (latDeg: number, lonDeg: number, value: number) => void): void {
    for (let i = 0; i < this.nLat; i += 1) {
      for (let j = 0; j < this.nLon; j += 1) {
        const v = this.data[i * this.nLon + j] ?? 0;
        if (v > 0) cb(this.cellLat(i), this.cellLon(j), v);
      }
    }
  }
}
