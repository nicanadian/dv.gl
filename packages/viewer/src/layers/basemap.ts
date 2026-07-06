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
 * Coastlines + country borders on the globe, so a pass is legible ("where is this?").
 * The vectors are Earth-fixed (ECEF km, baked from Natural Earth 110m); the layer draws
 * them with LineRenderer's in-shader GMST spin so a static buffer rotates with the globe
 * — no per-frame CPU rebake. Depth-tested against the Earth mesh, so far-side lines hide.
 * Host owns fetching (parseBasemap), consistent with the façade's data-in contract.
 */
import { LineRenderer } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const BASEMAP_MAGIC = 0x44564742; // "DVGB"

/** Parse the baked basemap binary into ECEF-km line-list vertex buffers. */
export function parseBasemap(buf: ArrayBuffer): {
  coastlines: Float32Array;
  borders: Float32Array;
} {
  const head = new Uint32Array(buf, 0, 4);
  if (head[0] !== BASEMAP_MAGIC) throw new Error("parseBasemap: bad magic");
  const coastFloats = head[2] ?? 0;
  const borderFloats = head[3] ?? 0;
  return {
    coastlines: new Float32Array(buf, 16, coastFloats),
    borders: new Float32Array(buf, 16 + coastFloats * 4, borderFloats),
  };
}

export interface BasemapLayerOptions {
  /** Coastline vertices, ECEF km line-list (from parseBasemap). */
  readonly coastlines?: Float32Array;
  /** Country-border vertices, ECEF km line-list. */
  readonly borders?: Float32Array;
  readonly coastColor?: readonly [number, number, number, number];
  readonly borderColor?: readonly [number, number, number, number];
}

function fill(verts: number, rgba: readonly [number, number, number, number]): Float32Array {
  const out = new Float32Array(verts * 4);
  for (let i = 0; i < verts; i += 1) out.set(rgba, i * 4);
  return out;
}

export class BasemapLayer implements Layer {
  private coastR: LineRenderer | undefined;
  private borderR: LineRenderer | undefined;
  private readonly coast: Float32Array | undefined;
  private readonly borders: Float32Array | undefined;
  private readonly coastCol: readonly [number, number, number, number];
  private readonly borderCol: readonly [number, number, number, number];

  constructor(opts: BasemapLayerOptions) {
    this.coast = opts.coastlines;
    this.borders = opts.borders;
    this.coastCol = opts.coastColor ?? [0.42, 0.55, 0.72, 0.85];
    this.borderCol = opts.borderColor ?? [0.35, 0.42, 0.55, 0.6];
  }

  init(ctx: LayerContext): void {
    if (this.coast && this.coast.length >= 6) {
      const verts = this.coast.length / 3;
      this.coastR = new LineRenderer(ctx.device, {
        capacity: verts,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
      });
      this.coastR.setSegments(this.coast, fill(verts, this.coastCol), verts / 2);
    }
    if (this.borders && this.borders.length >= 6) {
      const verts = this.borders.length / 3;
      this.borderR = new LineRenderer(ctx.device, {
        capacity: verts,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
      });
      this.borderR.setSegments(this.borders, fill(verts, this.borderCol), verts / 2);
    }
  }

  update(frame: FrameContext): void {
    // in-shader Earth-fixed spin: the ECEF buffer rotates by Rz(+gmst) with the globe
    this.coastR?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
    this.borderR?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.coastR?.draw(pass);
    this.borderR?.draw(pass);
  }

  dispose(): void {
    this.coastR = undefined;
    this.borderR = undefined;
  }
}
