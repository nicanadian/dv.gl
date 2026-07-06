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
 * Name tags for the fleet. This layer draws NOTHING on the GPU -- text belongs to
 * the host's DOM/canvas. Each frame it projects the live Fleet to screen, culls
 * objects behind the globe limb, runs priority declutter, and emits the surviving
 * set (as [0,1] drawable fractions) through onLabels(). The host decides how to
 * render them. Keeping the layer DOM-free is what lets it live in the façade.
 */
import { declutterLabels, type LabelBox } from "@dvgl/core";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

/** A visible label: position as a fraction of the drawable, origin top-left. */
export interface LabelHit {
  readonly index: number;
  readonly name: string;
  /** Horizontal anchor in [0,1] across the drawable width. */
  readonly x: number;
  /** Vertical anchor in [0,1] down the drawable height. */
  readonly y: number;
}

export type LabelsCallback = (labels: readonly LabelHit[]) => void;

export interface LabelsLayerOptions {
  readonly fleet: Fleet;
  /** Approx glyph advance (device px) used to size declutter boxes. Default 6.3. */
  readonly charWidthPx?: number;
  /** Label box height (device px) used for declutter. Default 14. */
  readonly labelHeightPx?: number;
}

const EARTH_R2 = 6371 * 6371;

export class LabelsLayer implements Layer {
  private readonly fleet: Fleet;
  private readonly charW: number;
  private readonly labelH: number;
  private readonly cbs = new Set<LabelsCallback>();
  private priorityIndex = -1;

  constructor(opts: LabelsLayerOptions) {
    this.fleet = opts.fleet;
    this.charW = opts.charWidthPx ?? 6.3;
    this.labelH = opts.labelHeightPx ?? 14;
  }

  init(_ctx: LayerContext): void {}

  /** Register a sink for the decluttered label set; returns a disposer. */
  onLabels(cb: LabelsCallback): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }

  /** Bias one object (e.g. the hovered/selected one) to always win overlaps. */
  setPriorityIndex(index: number): void {
    this.priorityIndex = index;
  }

  update(frame: FrameContext): void {
    if (this.cbs.size === 0) return;
    const pos = this.fleet.positions;
    const count = this.fleet.count;
    if (!pos || count === 0) {
      this.emit([]);
      return;
    }
    const colors = this.fleet.colors;
    const names = this.fleet.names;
    const w = frame.width;
    const h = frame.height;
    const [ex, ey, ez] = frame.eyeKm;
    const vp = frame.viewProjRte;
    const cand: { index: number; name: string; x: number; y: number; box: LabelBox }[] = [];
    for (let k = 0; k < count; k += 1) {
      if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
      const px = pos[k * 3] ?? Number.NaN;
      const py = pos[k * 3 + 1] ?? Number.NaN;
      const pz = pos[k * 3 + 2] ?? Number.NaN;
      if (!Number.isFinite(px)) continue;
      // far-side cull: hide labels for objects behind the globe limb
      if (px * ex + py * ey + pz * ez < EARTH_R2) continue;
      const rx = px - ex;
      const ry = py - ey;
      const rz = pz - ez;
      const cw = (vp[3] ?? 0) * rx + (vp[7] ?? 0) * ry + (vp[11] ?? 0) * rz + (vp[15] ?? 0);
      if (cw <= 0) continue;
      const cx = (vp[0] ?? 0) * rx + (vp[4] ?? 0) * ry + (vp[8] ?? 0) * rz + (vp[12] ?? 0);
      const cy = (vp[1] ?? 0) * rx + (vp[5] ?? 0) * ry + (vp[9] ?? 0) * rz + (vp[13] ?? 0);
      const sx = ((cx / cw) * 0.5 + 0.5) * w;
      const sy = (1 - ((cy / cw) * 0.5 + 0.5)) * h;
      const name = names?.[k] ?? `#${k}`;
      cand.push({
        index: k,
        name,
        x: sx / w,
        y: sy / h,
        box: {
          x: sx + 6,
          y: sy - 7,
          w: name.length * this.charW + 6,
          h: this.labelH,
          priority: k === this.priorityIndex ? 1000 : 1,
        },
      });
    }
    const vis = declutterLabels(cand.map((c) => c.box));
    const out: LabelHit[] = [];
    cand.forEach((c, i) => {
      if (vis[i]) out.push({ index: c.index, name: c.name, x: c.x, y: c.y });
    });
    this.emit(out);
  }

  private emit(labels: readonly LabelHit[]): void {
    for (const cb of this.cbs) cb(labels);
  }

  draw(_pass: GPURenderPassEncoder): void {}

  dispose(): void {
    this.cbs.clear();
  }
}
