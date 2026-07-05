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
 * Stage 0 numerics, step 2: sgp4.gl (fp32, GPU) against the python-sgp4 fp64 Vallado
 * fixtures, through the same compareEphemerides used for the fp64 reference chain.
 * Step 1 (headless, @dvgl/validate tests) established the reference-uncertainty band:
 * the two fp64 Vallado ports agree to <0.34 m at LEO but only ~1.6/2.3 m at MEO/GEO
 * (deep-space branch), so deep-space errors below ~3 m are inside reference ambiguity.
 *
 * Batching trick: to evaluate one satellite at N epochs in a single GPU call, the
 * satellite is registered N times (fresh consts each -- register_const_set consumes
 * its handles) and propagated once with times[k] = epoch_k.
 */
import {
  compareEphemerides,
  type EphemerisFixture,
  fixtureSamples,
  type Sample,
} from "@dvgl/validate";
import geoFixture from "../../../packages/validate/fixtures/geo_like.json";
import leoFixture from "../../../packages/validate/fixtures/leo_iss_like.json";
import meoFixture from "../../../packages/validate/fixtures/meo_gps_like.json";

const FIXTURES = [leoFixture, meoFixture, geoFixture] as unknown as EphemerisFixture[];

async function main(): Promise<void> {
  const out = document.getElementById("out");
  const say = (t: string): void => {
    if (out) out.textContent += `${t}\n`;
  };
  try {
    const sgp4gl = await import("sgp4.gl");
    const wasmUrl = (await import("sgp4.gl/wasm?url")).default;
    await sgp4gl.init(wasmUrl);
    const propagator = await sgp4gl.GpuPropagator.new_for_web();
    const enc = new TextEncoder();
    say("sgp4.gl 0.1.5-beta initialized (WASM+GPU)\n");

    const results: Record<string, unknown>[] = [];
    for (const fixture of FIXTURES) {
      const epochs = fixture.points.map(([m]) => m);
      const n = epochs.length;
      // one clone per epoch, single GPU dispatch for the whole 7-day series
      const consts: unknown[] = [];
      for (let k = 0; k < n; k += 1) {
        const el = sgp4gl.WasmElements.from_tle(
          enc.encode(fixture.name),
          enc.encode(fixture.line1),
          enc.encode(fixture.line2),
        );
        consts.push(sgp4gl.WasmGpuConsts.from_constants(sgp4gl.WasmConstants.from_elements(el)));
      }
      const setId = propagator.register_const_set(consts as never);
      const times = new Float64Array(epochs as number[]);
      const raw: Float32Array = await propagator.propagate_registered_f32(setId, times);
      propagator.unregister_const_set?.(setId);

      const candidate: Sample[] = epochs.map((minutes, k) => ({
        minutes: minutes as number,
        xKm: raw[k * 6] ?? Number.NaN,
        yKm: raw[k * 6 + 1] ?? Number.NaN,
        zKm: raw[k * 6 + 2] ?? Number.NaN,
      }));
      const cmp = compareEphemerides(fixtureSamples(fixture), candidate);
      const floorM = fixture.fp32_representation_floor_km * 1000;
      const result = {
        regime: fixture.name,
        n: cmp.n,
        maxErrorM: cmp.maxErrorKm * 1000,
        rmsErrorM: cmp.rmsErrorKm * 1000,
        finalErrorM: cmp.finalErrorKm * 1000,
        fp32FloorM: floorM,
        referenceBandM: fixture.name.startsWith("leo") ? 0.34 : 3.0,
      };
      results.push(result);
      say(
        `${fixture.name}: max ${result.maxErrorM.toFixed(2)} m, ` +
          `rms ${result.rmsErrorM.toFixed(2)} m, final(7d) ${result.finalErrorM.toFixed(2)} m ` +
          `(fp32 floor ${floorM.toFixed(2)} m, reference band ~${result.referenceBandM} m)`,
      );
    }
    console.log("NUMERICS RESULT", JSON.stringify(results));
    say("\ndone");
  } catch (err) {
    say(String(err));
    throw err;
  }
}

void main();
