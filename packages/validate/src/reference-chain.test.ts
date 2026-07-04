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
 * Stage 0 numerics, step 1: validate the JS-side reference chain. The fixtures are
 * python-sgp4 (Vallado, fp64) 7-day ephemerides; satellite.js is the same Vallado
 * lineage in JS. If the two fp64 implementations agree tightly across LEO/MEO/GEO,
 * the JS reference is trustworthy and the sgp4.gl FP32 comparison can plug into
 * `compareEphemerides` unchanged when a WebGPU device is available.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as satellite from "satellite.js";
import { describe, expect, it } from "vitest";
import {
  compareEphemerides,
  type EphemerisFixture,
  fixtureSamples,
  type Sample,
} from "./compare.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const CASES = ["leo_iss_like", "meo_gps_like", "geo_like"] as const;

function loadFixture(name: string): EphemerisFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as EphemerisFixture;
}

function propagateWithSatelliteJs(fixture: EphemerisFixture): Sample[] {
  const satrec = satellite.twoline2satrec(fixture.line1, fixture.line2);
  return fixture.points.map(([minutes]) => {
    const out = satellite.sgp4(satrec, minutes);
    if (out === false || typeof out.position === "boolean") {
      throw new Error(`satellite.js propagation failed at t=${minutes} min`);
    }
    return {
      minutes,
      xKm: out.position.x,
      yKm: out.position.y,
      zKm: out.position.z,
    };
  });
}

// Measured reference agreement between the two fp64 Vallado ports (see the finding
// below): the near-Earth SGP4 branch (LEO) agrees to sub-meter; the deep-space SDP4
// branch (MEO/GEO, period >= 225 min) diverges at the meter level between
// implementation revisions. These bounds are the reference-uncertainty band any
// downstream FP32 comparison must state.
const REFERENCE_AGREEMENT_KM: Record<(typeof CASES)[number], number> = {
  leo_iss_like: 1e-3, // < 1 m: near-Earth branch, tight agreement
  meo_gps_like: 5e-3, // < 5 m: deep-space branch, meter-level port divergence
  geo_like: 5e-3, // < 5 m: deep-space branch, meter-level port divergence
};

describe("Stage 0 numerics reference chain (python-sgp4 fp64 vs satellite.js fp64)", () => {
  for (const name of CASES) {
    it(`${name}: two Vallado fp64 implementations agree within the stated band`, () => {
      const fixture = loadFixture(name);
      const reference = fixtureSamples(fixture);
      const candidate = propagateWithSatelliteJs(fixture);
      const result = compareEphemerides(reference, candidate);
      expect(result.n).toBe(fixture.points.length);
      expect(result.maxErrorKm).toBeLessThan(REFERENCE_AGREEMENT_KM[name]);
    });
  }

  it("FINDING: deep-space reference disagreement exceeds the fp32 representation floor", () => {
    // At MEO/GEO the two fp64 references differ by MORE than fp32 rounding of a
    // position (1.2-2.1 m floors vs 1.6-2.3 m port divergence). Consequence for the
    // sgp4.gl comparison: sub-3-m errors in deep-space regimes are inside reference
    // ambiguity and must be reported with this band, not as bare error numbers.
    for (const name of ["meo_gps_like", "geo_like"] as const) {
      const fixture = loadFixture(name);
      const candidate = propagateWithSatelliteJs(fixture);
      const result = compareEphemerides(fixtureSamples(fixture), candidate);
      expect(result.maxErrorKm).toBeGreaterThan(fixture.fp32_representation_floor_km * 0.5);
    }
    // LEO stays unambiguous: agreement well under its fp32 floor.
    const leo = loadFixture("leo_iss_like");
    const leoResult = compareEphemerides(fixtureSamples(leo), propagateWithSatelliteJs(leo));
    expect(leoResult.maxErrorKm).toBeLessThan(leo.fp32_representation_floor_km);
  });

  it("records the fp32 representation floor per regime (LEO < MEO < GEO)", () => {
    const floors = CASES.map((n) => loadFixture(n).fp32_representation_floor_km);
    expect(floors[0]).toBeLessThan(floors[1] ?? Number.NaN);
    expect(floors[1]).toBeLessThan(floors[2] ?? Number.NaN);
    // sub-meter at LEO, meters at GEO: the *floor* any FP32 pipeline inherits
    expect(floors[0]).toBeGreaterThan(0);
    expect(floors[2]).toBeLessThan(0.005); // < 5 m even at GEO
  });

  it("compareEphemerides is exact on identical inputs and loud on mismatches", () => {
    const fixture = loadFixture("leo_iss_like");
    const samples = fixtureSamples(fixture);
    const self = compareEphemerides(samples, samples);
    expect(self.maxErrorKm).toBe(0);
    expect(() => compareEphemerides(samples, samples.slice(1))).toThrow(/mismatch/);
  });
});
