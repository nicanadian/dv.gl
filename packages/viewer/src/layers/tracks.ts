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
 * Orbit / ground tracks: a +/- one-period window around the current time, sampled
 * from a window-capable source. The window is resampled only when scene time drifts
 * far enough (default 12 min); every frame the "now" split advances continuously so
 * the past half fades behind the live position. In "ground" mode the samples are
 * surface-projected; in earth-fixed sampling successive revs separate into the
 * ground-track weave instead of overlaying.
 */
import { ecefToSurface } from "@dvgl/frames";
import { OrbitTrackRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

/** The subset of a propagation source that can emit a windowed sample buffer. */
export interface WindowSource {
  readonly count: number;
  /**
   * Write [object][sample][xyz] km (stride 3) for a +/-1-period window around
   * `centerMinutes` into `out`. With `ecefEpochMs` (Unix ms of scene time zero)
   * each sample is rotated to the Earth-fixed frame by GMST at its own epoch.
   */
  sampleWindowInto(
    centerMinutes: number,
    samples: number,
    out: Float32Array,
    ecefEpochMs?: number,
    periodsOut?: Float32Array,
  ): void;
}

export interface TracksLayerOptions {
  readonly source: WindowSource;
  /** Optional fleet to source per-object colors from. */
  readonly fleet?: Fleet;
  /** Samples per object per window (odd; the middle sample is "now"). Default 129. */
  readonly samples?: number;
  /** "orbit" draws the inertial/earth-fixed track; "ground" projects to the surface. */
  readonly mode?: "orbit" | "ground";
  /** Sample in ECEF so the track holds still under an earth-fixed camera. */
  readonly earthFixed?: boolean;
  /** Resample the window when scene time drifts this many minutes. Default 12. */
  readonly recomputeMinutes?: number;
}

const SURFACE_LIFT_KM = 8;

export class TracksLayer implements Layer {
  private ctx?: LayerContext;
  private renderer: OrbitTrackRenderer | undefined;
  private winBuf?: Float32Array;
  private surfBuf?: Float32Array;
  private periods?: Float32Array;
  private lastCenterMin = Number.NEGATIVE_INFINITY;
  private readonly source: WindowSource;
  private readonly fleet: Fleet | undefined;
  private readonly samples: number;
  private readonly mode: "orbit" | "ground";
  private readonly earthFixed: boolean;
  private readonly recomputeMin: number;

  constructor(opts: TracksLayerOptions) {
    this.source = opts.source;
    this.fleet = opts.fleet;
    this.samples = opts.samples ?? 129;
    this.mode = opts.mode ?? "orbit";
    this.earthFixed = opts.earthFixed ?? false;
    this.recomputeMin = opts.recomputeMinutes ?? 12;
  }

  init(ctx: LayerContext): void {
    this.ctx = ctx;
  }

  /** True when the window must be sampled in the Earth-fixed frame. */
  private get ecef(): boolean {
    return this.earthFixed || this.mode === "ground";
  }

  update(frame: FrameContext): void {
    if (!this.ctx) return;
    const count = this.source.count;
    if (count === 0) return;
    if (!this.renderer) {
      this.renderer = new OrbitTrackRenderer(this.ctx.device, {
        capacity: count,
        samples: this.samples,
        format: this.ctx.format,
        depthFormat: this.ctx.depthFormat,
      });
      this.winBuf = new Float32Array(count * this.samples * 3);
      this.periods = new Float32Array(count);
      if (this.mode === "ground") this.surfBuf = new Float32Array(count * this.samples * 3);
    }
    const r = this.renderer;
    const win = this.winBuf;
    const per = this.periods;
    if (!win || !per) return;
    const centerMin = frame.timeSec / 60;

    if (Math.abs(centerMin - this.lastCenterMin) > this.recomputeMin) {
      this.lastCenterMin = centerMin;
      this.source.sampleWindowInto(
        centerMin,
        this.samples,
        win,
        this.ecef ? frame.epochMs : undefined,
        per,
      );
      let buf = win;
      if (this.mode === "ground" && this.surfBuf) {
        const n = count * this.samples * 3;
        for (let k = 0; k < n; k += 3) {
          const s = ecefToSurface(
            win[k] ?? Number.NaN,
            win[k + 1] ?? Number.NaN,
            win[k + 2] ?? Number.NaN,
            SURFACE_LIFT_KM,
          );
          this.surfBuf[k] = s[0];
          this.surfBuf[k + 1] = s[1];
          this.surfBuf[k + 2] = s[2];
        }
        buf = this.surfBuf;
      }
      r.setWindow(buf, count, per);
    }

    // colors follow the live fleet (family filters recolor the tracks too)
    if (this.fleet?.colors) r.setColors(this.fleet.colors);
    r.updateCamera(
      frame.viewProjRte,
      frame.eyeKm,
      this.ecef ? frame.gmstRad : 0, // ECEF data spins with the globe
      centerMin - this.lastCenterMin, // continuous now-split within the window
    );
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer?.draw(pass);
  }

  dispose(): void {
    this.renderer = undefined;
  }
}
