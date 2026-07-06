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

/** Short along-track velocity leaders at each satellite (which way is forward). */
import { LineRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

const LEADER_KM = 500;

export class HeadingLayer implements Layer {
  private ctx?: LayerContext;
  private lines: LineRenderer | undefined;
  private seg?: Float32Array;
  private col?: Float32Array;
  private readonly fleet: Fleet;

  constructor(opts: { fleet: Fleet }) {
    this.fleet = opts.fleet;
  }

  init(ctx: LayerContext): void {
    this.ctx = ctx;
  }

  private ensure(count: number): void {
    if (this.lines || !this.ctx) return;
    this.lines = new LineRenderer(this.ctx.device, {
      capacity: count * 2,
      format: this.ctx.format,
      depthFormat: this.ctx.depthFormat,
    });
    this.seg = new Float32Array(count * 2 * 3);
    this.col = new Float32Array(count * 2 * 4);
  }

  update(frame: FrameContext): void {
    const pos = this.fleet.positions;
    const vel = this.fleet.velocities;
    const colors = this.fleet.colors;
    const count = this.fleet.count;
    if (!pos || !vel || count === 0) return;
    this.ensure(count);
    if (!this.lines || !this.seg || !this.col) return;
    let hs = 0;
    for (let k = 0; k < count; k += 1) {
      if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
      const x = pos[k * 3] ?? Number.NaN;
      if (!Number.isFinite(x)) continue;
      const y = pos[k * 3 + 1] ?? 0;
      const z = pos[k * 3 + 2] ?? 0;
      const p = hs * 6;
      this.seg[p] = x;
      this.seg[p + 1] = y;
      this.seg[p + 2] = z;
      this.seg[p + 3] = x + (vel[k * 3] ?? 0) * LEADER_KM;
      this.seg[p + 4] = y + (vel[k * 3 + 1] ?? 0) * LEADER_KM;
      this.seg[p + 5] = z + (vel[k * 3 + 2] ?? 0) * LEADER_KM;
      this.col.set([1, 1, 1, 0.9, 1, 1, 1, 0.9], hs * 8);
      hs += 1;
    }
    this.lines.setSegments(this.seg, this.col, hs);
    this.lines.updateCamera(frame.viewProjRte, frame.eyeKm);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.lines?.draw(pass);
  }

  dispose(): void {
    this.lines = undefined;
  }
}
