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
 * Relative-to-eye (RTE) precision math. GPU vertex math is fp32; Earth-scale
 * coordinates (1e7 m) burn most of a float's mantissa, so naive world-space rendering
 * jitters at the meter level as the camera moves. The standard fix: split each fp64
 * coordinate into a high/low fp32 pair, subtract the camera position in the SAME
 * split form on the GPU, and only then combine. The subtraction of the high parts is
 * exact (both are fp32-representable), so the residual arithmetic happens near the
 * origin where fp32 is dense.
 *
 * These helpers are pure CPU math and unit-tested headless; the WGSL side consumes
 * their output layout.
 */

/** Split an fp64 value into (high, low) fp32 parts with high = fround(x). */
export function splitDouble(x: number): { readonly high: number; readonly low: number } {
  const high = Math.fround(x);
  const low = Math.fround(x - high);
  return { high, low };
}

/**
 * Pack positions (km, fp64) into interleaved high/low fp32 buffers.
 * Layout: `high[3k..3k+2]` and `low[3k..3k+2]` for object k.
 */
export function packRte(
  positionsKm: readonly number[] | Float64Array,
  high: Float32Array,
  low: Float32Array,
): void {
  const n = positionsKm.length;
  if (high.length < n || low.length < n) {
    throw new Error(`RTE buffers too small: need ${n}`);
  }
  for (let k = 0; k < n; k += 1) {
    const x = positionsKm[k];
    if (x === undefined) continue;
    const h = Math.fround(x);
    high[k] = h;
    low[k] = Math.fround(x - h);
  }
}

/** Reconstruct fp64-ish value from a split pair (for tests/diagnostics). */
export function combineSplit(high: number, low: number): number {
  return high + low;
}

/**
 * Camera position in split form for the uniform buffer, so the GPU can compute
 * (posHigh - eyeHigh) + (posLow - eyeLow) per vertex.
 */
export function splitCamera(eyeKm: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(8); // 2x vec3 padded to vec4 for WGSL alignment
  for (let i = 0; i < 3; i += 1) {
    const c = eyeKm[i];
    if (c === undefined) continue;
    const h = Math.fround(c);
    out[i] = h;
    out[4 + i] = Math.fround(c - h);
  }
  return out;
}
