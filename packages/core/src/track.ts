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
 * Columnar sampled track: the core data structure of the mission-time model.
 * Times in one Float64Array (scene seconds must survive 7-day windows at ms
 * precision -- fp32 cannot), values in one Float32Array with a fixed stride
 * (position xyz, attitude quaternions, scalar telemetry...).
 *
 * `sampleInto` writes into a caller-owned buffer and allocates nothing, and it
 * memoizes the last bracketing index: playback advances time monotonically, so
 * the common case is O(1) instead of a fresh binary search per frame. This is
 * the "allocation-free animation path" of the product hypothesis in miniature.
 */

export type Interpolation = "linear" | "hold";

export interface SampledTrackOptions {
  readonly interpolation?: Interpolation;
}

export class SampledTrack {
  readonly count: number;
  readonly stride: number;
  readonly interpolation: Interpolation;
  private readonly times: Float64Array;
  private readonly values: Float32Array;
  private memo = 0; // last bracketing left index; sequential access hits it

  constructor(
    times: Float64Array,
    values: Float32Array,
    stride: number,
    options?: SampledTrackOptions,
  ) {
    if (stride <= 0 || !Number.isInteger(stride)) {
      throw new Error(`stride must be a positive integer, got ${stride}`);
    }
    if (times.length === 0) throw new Error("track needs at least one sample");
    if (values.length !== times.length * stride) {
      throw new Error(`values length ${values.length} != times ${times.length} x stride ${stride}`);
    }
    for (let k = 1; k < times.length; k += 1) {
      const a = times[k - 1];
      const b = times[k];
      if (a === undefined || b === undefined || !(b > a)) {
        throw new Error(`times must be strictly increasing (violated at index ${k})`);
      }
    }
    this.times = times;
    this.values = values;
    this.count = times.length;
    this.stride = stride;
    this.interpolation = options?.interpolation ?? "linear";
  }

  get startSec(): number {
    return this.times[0] ?? Number.NaN;
  }

  get endSec(): number {
    return this.times[this.count - 1] ?? Number.NaN;
  }

  /**
   * Sample the track at scene time t into `out` at `outOffset`. Clamps beyond the
   * ends. Allocation-free. Returns false only if `out` is too small.
   */
  sampleInto(tSec: number, out: Float32Array, outOffset = 0): boolean {
    const s = this.stride;
    if (out.length < outOffset + s) return false;

    const i = this.bracket(tSec);
    const t0 = this.times[i] ?? 0;
    const base0 = i * s;

    if (i >= this.count - 1 || tSec <= t0 || this.interpolation === "hold") {
      for (let c = 0; c < s; c += 1) out[outOffset + c] = this.values[base0 + c] ?? 0;
      return true;
    }
    const t1 = this.times[i + 1] ?? t0;
    const u = t1 > t0 ? (tSec - t0) / (t1 - t0) : 0;
    const base1 = base0 + s;
    for (let c = 0; c < s; c += 1) {
      const v0 = this.values[base0 + c] ?? 0;
      const v1 = this.values[base1 + c] ?? 0;
      out[outOffset + c] = v0 + u * (v1 - v0);
    }
    return true;
  }

  /**
   * Largest index i with times[i] <= t (clamped to [0, count-1]). Checks the
   * memoized bracket and its neighbor before falling back to binary search.
   */
  private bracket(tSec: number): number {
    const times = this.times;
    const n = this.count;
    const first = times[0] ?? 0;
    if (tSec <= first) {
      this.memo = 0;
      return 0;
    }
    const last = times[n - 1] ?? 0;
    if (tSec >= last) {
      this.memo = n - 1;
      return n - 1;
    }
    // fast path: same bracket as last call, or the next one (sequential playback)
    let i = this.memo;
    if ((times[i] ?? 0) <= tSec) {
      if (tSec < (times[i + 1] ?? Number.POSITIVE_INFINITY)) return i;
      if (tSec < (times[i + 2] ?? Number.POSITIVE_INFINITY)) {
        this.memo = i + 1;
        return i + 1;
      }
    }
    // fall back: binary search
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if ((times[mid] ?? 0) <= tSec) lo = mid;
      else hi = mid;
    }
    i = lo;
    this.memo = i;
    return i;
  }
}
