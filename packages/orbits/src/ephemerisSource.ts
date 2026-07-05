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
 * Ephemeris-backed PropagationSource: OEM segments become @dvgl/core SampledTracks
 * and evaluation is an interpolation sweep instead of SGP4 -- the path real mission
 * products (OEM from design tools, operators, or the pdb simulator) take into the
 * renderer. Same seam as SatelliteJsSource, so points, trails, and the harness all
 * work unchanged.
 *
 * Objects outside their segment's time span are hidden (NaN, counted as failed)
 * rather than frozen at the ends -- a clamped satellite looks like real data.
 */
import { SampledTrack } from "@dvgl/core";
import { gmst } from "@dvgl/frames";
import type { OemSegment } from "./oem.js";
import type { PropagationSource } from "./propagation.js";

interface TrackEntry {
  readonly track: SampledTrack;
  /** Segment start/end in seconds since the source anchor. */
  readonly startSec: number;
  readonly endSec: number;
}

export class EphemerisSource implements PropagationSource {
  readonly rejected: { readonly name: string; readonly reason: string }[] = [];
  /** Anchor epoch (Unix ms): the earliest segment start across the file. */
  readonly epochMs: number;
  /** Scene-window length covering every segment, seconds. */
  readonly windowSeconds: number;
  private readonly entries: TrackEntry[] = [];
  private readonly scratch = new Float32Array(3);

  constructor(segments: readonly OemSegment[]) {
    if (segments.length === 0) throw new Error("EphemerisSource needs segments");
    this.epochMs = Math.min(...segments.map((s) => s.epochMs));
    let end = 0;
    for (const seg of segments) {
      const offsetSec = (seg.epochMs - this.epochMs) / 1000;
      try {
        const track = new SampledTrack(
          offsetSec === 0 ? seg.times : shiftTimes(seg.times, offsetSec),
          seg.positions,
          3,
        );
        this.entries.push({ track, startSec: track.startSec, endSec: track.endSec });
        end = Math.max(end, track.endSec);
      } catch (err) {
        this.rejected.push({ name: seg.objectName, reason: String(err) });
      }
    }
    if (this.entries.length === 0) throw new Error("no usable segments");
    this.windowSeconds = end;
  }

  get count(): number {
    return this.entries.length;
  }

  propagateInto(minutesSinceEpoch: number, out: Float32Array): { written: number; failed: number } {
    if (out.length < this.entries.length * 3) {
      throw new Error(
        `output buffer too small: need ${this.entries.length * 3}, got ${out.length}`,
      );
    }
    const tSec = minutesSinceEpoch * 60;
    let written = 0;
    let failed = 0;
    for (let k = 0; k < this.entries.length; k += 1) {
      const e = this.entries[k];
      const base = k * 3;
      if (e === undefined || tSec < e.startSec || tSec > e.endSec) {
        out[base] = Number.NaN;
        out[base + 1] = Number.NaN;
        out[base + 2] = Number.NaN;
        failed += 1;
        continue;
      }
      e.track.sampleInto(tSec, this.scratch);
      out[base] = this.scratch[0] ?? Number.NaN;
      out[base + 1] = this.scratch[1] ?? Number.NaN;
      out[base + 2] = this.scratch[2] ?? Number.NaN;
      written += 1;
    }
    return { written, failed };
  }

  /**
   * +/- one (radius-estimated, circular-approx) period around centerMinutes,
   * clamped to each segment's data span -- a track that stops at the boundary of
   * the ephemeris is honest; extrapolating it would not be.
   */
  sampleWindowInto(
    centerMinutes: number,
    samples: number,
    out: Float32Array,
    ecefEpochMs?: number,
  ): void {
    const n = this.entries.length;
    if (out.length < n * samples * 3) {
      throw new Error(`window buffer too small: need ${n * samples * 3}`);
    }
    const centerSec = centerMinutes * 60;
    for (let k = 0; k < n; k += 1) {
      const e = this.entries[k];
      if (e === undefined) continue;
      // instantaneous radius -> circular-approx period (documented approximation)
      e.track.sampleInto(Math.min(Math.max(centerSec, e.startSec), e.endSec), this.scratch);
      const r = Math.hypot(this.scratch[0] ?? 0, this.scratch[1] ?? 0, this.scratch[2] ?? 0);
      const periodSec = 2 * Math.PI * Math.sqrt((r * r * r) / MU_EARTH);
      for (let s = 0; s < samples; s += 1) {
        const frac = (s / (samples - 1)) * 2 - 1;
        const tSec = Math.min(Math.max(centerSec + frac * periodSec, e.startSec), e.endSec);
        e.track.sampleInto(tSec, this.scratch);
        const base = (k * samples + s) * 3;
        const x = this.scratch[0] ?? Number.NaN;
        const y = this.scratch[1] ?? Number.NaN;
        if (ecefEpochMs !== undefined) {
          const theta = gmst(ecefEpochMs + tSec * 1000);
          const c = Math.cos(theta);
          const si = Math.sin(theta);
          out[base] = c * x + si * y;
          out[base + 1] = -si * x + c * y;
        } else {
          out[base] = x;
          out[base + 1] = y;
        }
        out[base + 2] = this.scratch[2] ?? Number.NaN;
      }
    }
  }
}

const MU_EARTH = 398_600.4418; // km^3/s^2

function shiftTimes(times: Float64Array, offsetSec: number): Float64Array {
  const out = new Float64Array(times.length);
  for (let k = 0; k < times.length; k += 1) out[k] = (times[k] ?? 0) + offsetSec;
  return out;
}
