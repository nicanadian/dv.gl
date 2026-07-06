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
 * Tasked collects on the ground: a planned box (blue outline) that becomes an
 * ACTIVE collect (amber box + a spacecraft->target beam) during its window, then a
 * just-completed one (green). Footprint boxes are Earth-fixed (GMST-rotated); the
 * beam's spacecraft end comes from the live Fleet.
 */
import {
  type Collect,
  collectDims,
  collectFootprintCorners,
  collectState,
  collectTargetEcef,
} from "@dvgl/orbits";
import { LineRenderer, TriRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

const CAP = 128; // max collects drawn at once (state-windowed)

export interface CollectsLayerOptions {
  readonly fleet: Fleet;
  readonly collects?: readonly Collect[];
  /** Show planned collects this many seconds ahead. Default 3600. */
  readonly leadSec?: number;
  /** Keep just-completed collects this many seconds. Default 900. */
  readonly trailSec?: number;
}

export class CollectsLayer implements Layer {
  private readonly fleet: Fleet;
  private fill: TriRenderer | undefined;
  private lines: LineRenderer | undefined;
  private triPos?: Float32Array;
  private triCol?: Float32Array;
  private segPos?: Float32Array;
  private segCol?: Float32Array;
  private collects: readonly Collect[] = [];
  private rings: Float32Array[] = [];
  private centers: [number, number, number][] = [];
  private satIdx: number[] = [];
  private satIdxReady = false;
  private readonly leadSec: number;
  private readonly trailSec: number;

  constructor(opts: CollectsLayerOptions) {
    this.fleet = opts.fleet;
    this.leadSec = opts.leadSec ?? 3600;
    this.trailSec = opts.trailSec ?? 900;
    if (opts.collects) this.setCollects(opts.collects);
  }

  setCollects(collects: readonly Collect[]): void {
    this.collects = collects;
    this.rings = collects.map((c) => {
      const d = collectDims(c);
      return collectFootprintCorners(
        c.targetLatDeg,
        c.targetLonDeg,
        d.crossKm,
        d.alongKm,
        c.lookAngleDeg,
        5,
      );
    });
    this.centers = collects.map((c) => collectTargetEcef(c.targetLatDeg, c.targetLonDeg, 5));
    this.satIdxReady = false;
  }

  init(ctx: LayerContext): void {
    // 4-corner footprint -> a 4-triangle fan; outline = 4 edges + 1 beam
    this.fill = new TriRenderer(ctx.device, {
      capacity: CAP * 4 * 3,
      format: ctx.format,
      depthFormat: ctx.depthFormat,
    });
    this.lines = new LineRenderer(ctx.device, {
      capacity: CAP * 5 * 2,
      format: ctx.format,
      depthFormat: ctx.depthFormat,
    });
    this.triPos = new Float32Array(CAP * 4 * 3 * 3);
    this.triCol = new Float32Array(CAP * 4 * 3 * 4);
    this.segPos = new Float32Array(CAP * 5 * 2 * 3);
    this.segCol = new Float32Array(CAP * 5 * 2 * 4);
  }

  private ensureSatIdx(): void {
    if (this.satIdxReady) return;
    const names = this.fleet.names;
    if (!names) return;
    const m = new Map<string, number>();
    names.forEach((n, i) => {
      m.set(n.split("/").pop() ?? n, i);
    });
    this.satIdx = this.collects.map((c) => m.get(c.sat) ?? -1);
    this.satIdxReady = true;
  }

  update(frame: FrameContext): void {
    if (!this.fill || !this.lines || !this.triPos || !this.triCol || !this.segPos || !this.segCol)
      return;
    this.ensureSatIdx();
    const triPos = this.triPos;
    const triCol = this.triCol;
    const segPos = this.segPos;
    const segCol = this.segCol;
    const nowSec = frame.timeSec;
    const cgm = Math.cos(frame.gmstRad);
    const sgm = Math.sin(frame.gmstRad);
    const pos = this.fleet.positions;
    let ft = 0;
    let sv = 0;
    let shown = 0;
    for (let ci = 0; ci < this.collects.length && shown < CAP; ci += 1) {
      const c = this.collects[ci];
      if (!c) continue;
      const st = collectState(c, nowSec, this.leadSec, this.trailSec);
      if (st === "idle") continue;
      const ring = this.rings[ci];
      const ctr = this.centers[ci];
      if (!ring || !ctr) continue;
      shown += 1;
      let cr = 0.7;
      let cg = 0.8;
      let cb = 1.0;
      let fillA = 0;
      let lineA = 0.55;
      if (st === "active") {
        cr = 1;
        cg = 0.85;
        cb = 0.35;
        fillA = 0.32;
        lineA = 0.95;
      } else if (st === "recent") {
        cr = 0.55;
        cg = 0.9;
        cb = 0.6;
        fillA = 0.14;
      }
      const cx = cgm * ctr[0] - sgm * ctr[1];
      const cy = sgm * ctr[0] + cgm * ctr[1];
      const cz = ctr[2];
      const seg = ring.length / 3;
      const wr = new Float32Array(seg * 3);
      for (let j = 0; j < seg; j += 1) {
        const x = ring[j * 3] ?? 0;
        const y = ring[j * 3 + 1] ?? 0;
        wr[j * 3] = cgm * x - sgm * y;
        wr[j * 3 + 1] = sgm * x + cgm * y;
        wr[j * 3 + 2] = ring[j * 3 + 2] ?? 0;
      }
      for (let j = 0; j < seg; j += 1) {
        const k = (j + 1) % seg;
        const p = sv * 6;
        segPos[p] = wr[j * 3] ?? 0;
        segPos[p + 1] = wr[j * 3 + 1] ?? 0;
        segPos[p + 2] = wr[j * 3 + 2] ?? 0;
        segPos[p + 3] = wr[k * 3] ?? 0;
        segPos[p + 4] = wr[k * 3 + 1] ?? 0;
        segPos[p + 5] = wr[k * 3 + 2] ?? 0;
        segCol.set([cr, cg, cb, lineA, cr, cg, cb, lineA], sv * 8);
        sv += 1;
        if (fillA > 0) {
          const t = ft * 3;
          triPos[t] = cx;
          triPos[t + 1] = cy;
          triPos[t + 2] = cz;
          triPos[t + 3] = wr[j * 3] ?? 0;
          triPos[t + 4] = wr[j * 3 + 1] ?? 0;
          triPos[t + 5] = wr[j * 3 + 2] ?? 0;
          triPos[t + 6] = wr[k * 3] ?? 0;
          triPos[t + 7] = wr[k * 3 + 1] ?? 0;
          triPos[t + 8] = wr[k * 3 + 2] ?? 0;
          triCol.set([cr, cg, cb, fillA], ft * 4);
          triCol.set([cr, cg, cb, fillA], (ft + 1) * 4);
          triCol.set([cr, cg, cb, fillA], (ft + 2) * 4);
          ft += 3;
        }
      }
      const si = this.satIdx[ci] ?? -1;
      if (st === "active" && si >= 0 && pos) {
        const sx = pos[si * 3];
        if (Number.isFinite(sx)) {
          const p = sv * 6;
          segPos[p] = sx ?? 0;
          segPos[p + 1] = pos[si * 3 + 1] ?? 0;
          segPos[p + 2] = pos[si * 3 + 2] ?? 0;
          segPos[p + 3] = cx;
          segPos[p + 4] = cy;
          segPos[p + 5] = cz;
          segCol.set([1, 0.85, 0.35, 0.9, 1, 0.85, 0.35, 0.9], sv * 8);
          sv += 1;
        }
      }
    }
    this.fill.setTriangles(triPos, triCol, ft / 3);
    this.fill.updateCamera(frame.viewProjRte, frame.eyeKm);
    this.lines.setSegments(segPos, segCol, sv);
    this.lines.updateCamera(frame.viewProjRte, frame.eyeKm);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.fill?.draw(pass);
    this.lines?.draw(pass);
  }

  dispose(): void {
    this.fill = undefined;
    this.lines = undefined;
  }
}
