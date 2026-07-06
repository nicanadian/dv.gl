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
 * SatellitesLayer: the fleet as GPU points, propagated each frame from a data
 * source and id-pickable. The host owns the data (a PropagationSource -- SGP4
 * catalog or ephemeris) and, optionally, per-object colours; the layer owns the
 * GPU buffers and the pick encoding.
 */
import { decodePickedIndex, PointRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

/** Minimal data contract: evaluate `count` objects' positions at a scene time. */
export interface FleetSource {
  readonly count: number;
  readonly names?: readonly string[];
  propagateInto(minutesSinceEpoch: number, out: Float32Array): { written: number; failed: number };
}

export interface SatellitesLayerOptions {
  readonly pointSizePx?: number;
}

export class SatellitesLayer implements Layer, Fleet {
  private ctx?: LayerContext;
  private renderer: PointRenderer | undefined;
  private source?: FleetSource;
  private posBuf?: Float32Array;
  private prevPos?: Float32Array;
  private velBuf?: Float32Array;
  private prevMin = Number.NaN;
  private colorBuf?: Float32Array;
  private readonly pointSizePx: number;

  constructor(opts: SatellitesLayerOptions = {}) {
    this.pointSizePx = opts.pointSizePx ?? 5;
  }

  /** Set (or replace) the fleet data source; rebuilds GPU buffers for its count. */
  setSource(source: FleetSource): void {
    this.source = source;
    this.posBuf = new Float32Array(source.count * 3);
    this.prevPos = new Float32Array(source.count * 3);
    this.velBuf = new Float32Array(source.count * 3);
    this.prevMin = Number.NaN;
    if (this.ctx) this.rebuild();
  }

  /** Per-object RGBA colours (stride 4). Alpha 0 hides an object. */
  setColors(colors: Float32Array): void {
    this.colorBuf = colors;
    this.renderer?.setColors(colors);
  }

  get count(): number {
    return this.source?.count ?? 0;
  }
  get names(): readonly string[] | undefined {
    return this.source?.names;
  }
  // --- Fleet: live state other layers read each frame ---
  get positions(): Float32Array | undefined {
    return this.posBuf;
  }
  get velocities(): Float32Array | undefined {
    return this.velBuf;
  }
  get colors(): Float32Array | undefined {
    return this.colorBuf;
  }

  init(ctx: LayerContext): void {
    this.ctx = ctx;
    if (this.source) this.rebuild();
  }

  private rebuild(): void {
    if (!this.ctx || !this.source) return;
    this.renderer = new PointRenderer(this.ctx.device, {
      capacity: this.source.count,
      format: this.ctx.format,
      depthFormat: this.ctx.depthFormat,
      pointSizePx: this.pointSizePx,
      ...(this.ctx.pickFormat ? { pickFormat: this.ctx.pickFormat } : {}),
    });
    if (this.colorBuf) this.renderer.setColors(this.colorBuf);
  }

  update(frame: FrameContext): void {
    if (!this.source || !this.renderer || !this.posBuf) return;
    const minutes = frame.timeSec / 60;
    this.source.propagateInto(minutes, this.posBuf);
    // finite-difference along-track velocity direction (for tracks/heading/FoR)
    if (this.prevPos && this.velBuf && Number.isFinite(this.prevMin) && minutes !== this.prevMin) {
      for (let k = 0; k < this.source.count; k += 1) {
        const dx = (this.posBuf[k * 3] ?? 0) - (this.prevPos[k * 3] ?? 0);
        const dy = (this.posBuf[k * 3 + 1] ?? 0) - (this.prevPos[k * 3 + 1] ?? 0);
        const dz = (this.posBuf[k * 3 + 2] ?? 0) - (this.prevPos[k * 3 + 2] ?? 0);
        const l = Math.hypot(dx, dy, dz) || 1;
        this.velBuf[k * 3] = dx / l;
        this.velBuf[k * 3 + 1] = dy / l;
        this.velBuf[k * 3 + 2] = dz / l;
      }
    }
    if (this.prevPos) this.prevPos.set(this.posBuf.subarray(0, this.source.count * 3));
    this.prevMin = minutes;
    this.renderer.updatePositions(this.posBuf, this.source.count);
    this.renderer.updateCamera(frame.viewProjRte, frame.eyeKm, frame.width, frame.height);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer?.draw(pass);
  }

  drawIds(pass: GPURenderPassEncoder): void {
    this.renderer?.drawIds(pass);
  }

  pickDecode(rgba: Uint8Array): number {
    return decodePickedIndex(rgba);
  }

  dispose(): void {
    // PointRenderer's GPU buffers are released when the device is destroyed; there
    // is no per-object teardown to do here yet.
    this.renderer = undefined;
  }
}
