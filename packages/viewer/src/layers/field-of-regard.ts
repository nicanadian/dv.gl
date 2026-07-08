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
 * Field-of-regard: the wide, faint ground band each sensor could steer to (a SAR
 * side-looking strip / an EO cross-track band), filled + outlined for every visible
 * satellite. "Could see", distinct from a footprint ("pointed") or coverage ("did
 * see"). Reads the live Fleet each frame.
 */
import { type SwathOptions, sensorSwathEdges } from "@dvgl/orbits";
import { LineRenderer, TriRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

const SEG = 14;
const OUTLINE = SEG * 2 + 2;
const SAR: SwathOptions = {
  side: "right",
  innerOffNadirDeg: 15,
  outerOffNadirDeg: 50,
  alongHalfDeg: 5,
  segments: SEG,
};
const EO: SwathOptions = {
  side: "both",
  innerOffNadirDeg: 0,
  outerOffNadirDeg: 45,
  alongHalfDeg: 5,
  segments: SEG,
};

function isSar(name: string | undefined): boolean {
  const tail = (name ?? "").split("/").pop() ?? "";
  return /^sar/i.test(tail.replace(/[\s_-]*\d+$/, ""));
}

export interface FieldOfRegardLayerOptions {
  readonly fleet: Fleet;
  readonly fillAlpha?: number;
  readonly lineAlpha?: number;
  /** Override the per-sat swath (e.g. a narrow nadir sensor footprint) for all sats. */
  readonly swath?: SwathOptions;
}

export class FieldOfRegardLayer implements Layer {
  private ctx?: LayerContext;
  private fill: TriRenderer | undefined;
  private lines: LineRenderer | undefined;
  private triPos?: Float32Array;
  private triCol?: Float32Array;
  private segPos?: Float32Array;
  private segCol?: Float32Array;
  private readonly fleet: Fleet;
  private readonly fillAlpha: number;
  private readonly lineAlpha: number;
  private readonly swathOverride: SwathOptions | undefined;

  constructor(opts: FieldOfRegardLayerOptions) {
    this.fleet = opts.fleet;
    this.fillAlpha = opts.fillAlpha ?? 0.13;
    this.lineAlpha = opts.lineAlpha ?? 0.55;
    this.swathOverride = opts.swath;
  }

  init(ctx: LayerContext): void {
    this.ctx = ctx;
  }

  private ensure(count: number): void {
    if (this.fill || !this.ctx) return;
    const c = this.ctx;
    this.fill = new TriRenderer(c.device, {
      capacity: count * (SEG - 1) * 2 * 3,
      format: c.format,
      depthFormat: c.depthFormat,
    });
    this.lines = new LineRenderer(c.device, {
      capacity: count * OUTLINE * 2,
      format: c.format,
      depthFormat: c.depthFormat,
    });
    this.triPos = new Float32Array(count * (SEG - 1) * 2 * 3 * 3);
    this.triCol = new Float32Array(count * (SEG - 1) * 2 * 3 * 4);
    this.segPos = new Float32Array(count * OUTLINE * 2 * 3);
    this.segCol = new Float32Array(count * OUTLINE * 2 * 4);
  }

  update(frame: FrameContext): void {
    const pos = this.fleet.positions;
    const vel = this.fleet.velocities;
    const colors = this.fleet.colors;
    const names = this.fleet.names;
    const count = this.fleet.count;
    if (!pos || !vel || count === 0) return;
    this.ensure(count);
    if (!this.fill || !this.lines || !this.triPos || !this.triCol || !this.segPos || !this.segCol)
      return;
    const triPos = this.triPos;
    const triCol = this.triCol;
    const segPos = this.segPos;
    const segCol = this.segCol;
    let ft = 0;
    let fs = 0;
    const tri = (e: Float32Array, j: number, r: number, g: number, b: number): void => {
      triPos[ft * 3] = e[j * 3] ?? 0;
      triPos[ft * 3 + 1] = e[j * 3 + 1] ?? 0;
      triPos[ft * 3 + 2] = e[j * 3 + 2] ?? 0;
      triCol.set([r, g, b, this.fillAlpha], ft * 4);
      ft += 1;
    };
    const out = (
      a: Float32Array,
      ai: number,
      b: Float32Array,
      bi: number,
      r: number,
      g: number,
      bl: number,
    ): void => {
      const p = fs * 6;
      segPos[p] = a[ai * 3] ?? 0;
      segPos[p + 1] = a[ai * 3 + 1] ?? 0;
      segPos[p + 2] = a[ai * 3 + 2] ?? 0;
      segPos[p + 3] = b[bi * 3] ?? 0;
      segPos[p + 4] = b[bi * 3 + 1] ?? 0;
      segPos[p + 5] = b[bi * 3 + 2] ?? 0;
      segCol.set([r, g, bl, this.lineAlpha, r, g, bl, this.lineAlpha], fs * 8);
      fs += 1;
    };
    for (let k = 0; k < count; k += 1) {
      if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
      const x = pos[k * 3] ?? Number.NaN;
      if (!Number.isFinite(x)) continue;
      const vx = vel[k * 3] ?? 0;
      const vy = vel[k * 3 + 1] ?? 0;
      const vz = vel[k * 3 + 2] ?? 0;
      if (vx === 0 && vy === 0 && vz === 0) continue;
      const { near, far } = sensorSwathEdges(
        [x, pos[k * 3 + 1] ?? 0, pos[k * 3 + 2] ?? 0],
        [vx, vy, vz],
        this.swathOverride ?? (isSar(names?.[k]) ? SAR : EO),
      );
      const seg = near.length / 3;
      const cr = colors?.[k * 4] ?? 0.6;
      const cg = colors?.[k * 4 + 1] ?? 0.85;
      const cb = colors?.[k * 4 + 2] ?? 1;
      for (let j = 0; j < seg - 1; j += 1) {
        tri(near, j, cr, cg, cb);
        tri(far, j, cr, cg, cb);
        tri(near, j + 1, cr, cg, cb);
        tri(far, j, cr, cg, cb);
        tri(far, j + 1, cr, cg, cb);
        tri(near, j + 1, cr, cg, cb);
        out(near, j, near, j + 1, cr, cg, cb);
        out(far, j, far, j + 1, cr, cg, cb);
      }
      out(near, 0, far, 0, cr, cg, cb);
      out(near, seg - 1, far, seg - 1, cr, cg, cb);
    }
    this.fill.setTriangles(triPos, triCol, ft / 3);
    // draped swath fill -> horizon-cull (no depth test) so wide flat tris aren't chord-culled
    this.fill.updateCamera(frame.viewProjRte, frame.eyeKm, undefined, true);
    this.lines.setSegments(segPos, segCol, fs);
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
