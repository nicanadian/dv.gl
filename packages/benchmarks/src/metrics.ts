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
 * Metric collection for the Stage 0 benchmark. Pure, allocation-conscious TypeScript
 * so the same collector runs on both render paths and is unit-testable headless.
 * The renderer integration only calls `frame()` and the scrub probe's two methods;
 * everything else is analysis after the run.
 */

/** Nearest-rank percentile over a sample array (copies + sorts; call after the run). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  if (p <= 0) return Math.min(...samples);
  if (p >= 100) return Math.max(...samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  const v = sorted[idx];
  return v === undefined ? Number.NaN : v;
}

export interface FrameStats {
  readonly frames: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/**
 * Fixed-capacity frame-time recorder. Preallocates its buffer so recording itself
 * does not allocate per frame (the harness must not perturb the GC behavior it is
 * trying to measure).
 */
export class FrameTimeRecorder {
  private readonly buf: Float64Array;
  private n = 0;
  private lastT: number | undefined;

  constructor(capacity = 100_000) {
    this.buf = new Float64Array(capacity);
  }

  /** Call once per presented frame with a monotonic timestamp in ms. */
  frame(nowMs: number): void {
    if (this.lastT !== undefined && this.n < this.buf.length) {
      this.buf[this.n] = nowMs - this.lastT;
      this.n += 1;
    }
    this.lastT = nowMs;
  }

  /** Drop everything recorded so far (used to discard warmup). */
  reset(): void {
    this.n = 0;
    this.lastT = undefined;
  }

  samples(): number[] {
    return Array.from(this.buf.subarray(0, this.n));
  }

  stats(): FrameStats {
    const s = this.samples();
    const mean = s.length === 0 ? Number.NaN : s.reduce((a, b) => a + b, 0) / s.length;
    return {
      frames: s.length,
      p50Ms: percentile(s, 50),
      p95Ms: percentile(s, 95),
      maxMs: s.length === 0 ? Number.NaN : Math.max(...s),
      meanMs: mean,
    };
  }
}

/**
 * Scrub-to-frame latency probe: the gate metric. `scrubInput()` at the input event,
 * `framePresented()` on every presented frame; the first frame after a pending scrub
 * closes that scrub's latency interval. One scrub at a time (matching the scripted
 * pattern, which never overlaps scrubs).
 */
export class ScrubLatencyProbe {
  private pendingSince: number | undefined;
  private readonly latencies: number[] = [];

  scrubInput(nowMs: number): void {
    this.pendingSince = nowMs;
  }

  framePresented(nowMs: number): void {
    if (this.pendingSince !== undefined) {
      this.latencies.push(nowMs - this.pendingSince);
      this.pendingSince = undefined;
    }
  }

  samples(): readonly number[] {
    return this.latencies;
  }

  p95Ms(): number {
    return percentile(this.latencies, 95);
  }
}

/** The published comparison: composed vs clean-sheet on the gate metric. */
export function gateRatio(composedP95Ms: number, cleanSheetP95Ms: number): number {
  return composedP95Ms / cleanSheetP95Ms;
}

/** Outcome A requires the clean-sheet path to be >=3x lower on p95 scrub latency. */
export const GATE_MIN_RATIO = 3.0;

export function passesGate(composedP95Ms: number, cleanSheetP95Ms: number): boolean {
  return gateRatio(composedP95Ms, cleanSheetP95Ms) >= GATE_MIN_RATIO;
}
