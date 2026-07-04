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
 * Reference-comparison core for the Stage 0 numerics track. An ephemeris fixture is a
 * time series of TEME positions from a trusted double-precision reference
 * (python-sgp4, Vallado); `compareEphemerides` reports position error over time and
 * summary statistics between any candidate propagation and the reference.
 */

export interface EphemerisFixture {
  readonly name: string;
  readonly line1: string;
  readonly line2: string;
  readonly cadence_minutes: number;
  readonly days: number;
  readonly frame: string;
  readonly units: string;
  readonly generator: string;
  readonly fp32_representation_floor_km: number;
  /** Rows of [minutesSinceEpoch, x, y, z] in km, TEME. */
  readonly points: readonly (readonly [number, number, number, number])[];
}

export interface Sample {
  readonly minutes: number;
  readonly xKm: number;
  readonly yKm: number;
  readonly zKm: number;
}

export interface ComparisonResult {
  readonly n: number;
  readonly maxErrorKm: number;
  readonly rmsErrorKm: number;
  readonly finalErrorKm: number;
  /** [minutes, errorKm] series for plotting error growth. */
  readonly errorSeries: readonly (readonly [number, number])[];
}

/** Compare a candidate ephemeris against a reference at identical epochs. */
export function compareEphemerides(
  reference: readonly Sample[],
  candidate: readonly Sample[],
): ComparisonResult {
  if (reference.length !== candidate.length) {
    throw new Error(
      `sample count mismatch: reference ${reference.length} vs candidate ${candidate.length}`,
    );
  }
  const series: [number, number][] = [];
  let maxErr = 0;
  let sumSq = 0;
  for (let k = 0; k < reference.length; k += 1) {
    const r = reference[k];
    const c = candidate[k];
    if (r === undefined || c === undefined) continue;
    if (Math.abs(r.minutes - c.minutes) > 1e-9) {
      throw new Error(`epoch mismatch at index ${k}: ${r.minutes} vs ${c.minutes}`);
    }
    const dx = r.xKm - c.xKm;
    const dy = r.yKm - c.yKm;
    const dz = r.zKm - c.zKm;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    series.push([r.minutes, err]);
    if (err > maxErr) maxErr = err;
    sumSq += err * err;
  }
  const last = series[series.length - 1];
  return {
    n: series.length,
    maxErrorKm: maxErr,
    rmsErrorKm: Math.sqrt(sumSq / Math.max(1, series.length)),
    finalErrorKm: last === undefined ? Number.NaN : last[1],
    errorSeries: series,
  };
}

/** Convert a fixture's rows into Sample form. */
export function fixtureSamples(fixture: EphemerisFixture): Sample[] {
  return fixture.points.map(([minutes, x, y, z]) => ({
    minutes,
    xKm: x,
    yKm: y,
    zKm: z,
  }));
}
