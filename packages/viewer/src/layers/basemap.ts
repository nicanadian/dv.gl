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
 * — no per-frame CPU rebake. Land fill + coast/border lines all use the analytic horizon
 * cull (not the depth buffer), so lines drape on top of the filled land on the near side
 * and the far hemisphere is hidden at the limb.
 * Host owns fetching (parseBasemap), consistent with the façade's data-in contract.
 */
import { LineRenderer, TriRenderer } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const BASEMAP_MAGIC = 0x44564742; // "DVGB"

/**
 * Parse the baked basemap binary. v1 = coast + border line-lists; v2 adds a land
 * triangle-list (filled land). All ECEF km.
 */
export function parseBasemap(buf: ArrayBuffer): {
  coastlines: Float32Array;
  borders: Float32Array;
  land?: Float32Array;
} {
  const head = new Uint32Array(buf, 0, 5);
  if (head[0] !== BASEMAP_MAGIC) throw new Error("parseBasemap: bad magic");
  const version = head[1] ?? 1;
  const coastFloats = head[2] ?? 0;
  const borderFloats = head[3] ?? 0;
  const headerBytes = version >= 2 ? 20 : 16;
  const coastlines = new Float32Array(buf, headerBytes, coastFloats);
  const borders = new Float32Array(buf, headerBytes + coastFloats * 4, borderFloats);
  if (version < 2) return { coastlines, borders };
  const landFloats = head[4] ?? 0;
  const land = new Float32Array(buf, headerBytes + (coastFloats + borderFloats) * 4, landFloats);
  return { coastlines, borders, land };
}

export interface BasemapLayerOptions {
  /** Coastline vertices, ECEF km line-list (from parseBasemap). */
  readonly coastlines?: Float32Array;
  /** Country-border vertices, ECEF km line-list. */
  readonly borders?: Float32Array;
  /** Filled-land vertices, ECEF km triangle-list. */
  readonly land?: Float32Array;
  readonly coastColor?: readonly [number, number, number, number];
  readonly borderColor?: readonly [number, number, number, number];
  readonly landColor?: readonly [number, number, number, number];
}

function fill(verts: number, rgba: readonly [number, number, number, number]): Float32Array {
  const out = new Float32Array(verts * 4);
  for (let i = 0; i < verts; i += 1) out.set(rgba, i * 4);
  return out;
}

export class BasemapLayer implements Layer {
  private coastR: LineRenderer | undefined;
  private borderR: LineRenderer | undefined;
  private landR: TriRenderer | undefined;
  private readonly coast: Float32Array | undefined;
  private readonly borders: Float32Array | undefined;
  private readonly land: Float32Array | undefined;
  private readonly coastCol: readonly [number, number, number, number];
  private readonly borderCol: readonly [number, number, number, number];
  private readonly landCol: readonly [number, number, number, number];

  constructor(opts: BasemapLayerOptions) {
    this.coast = opts.coastlines;
    this.borders = opts.borders;
    this.land = opts.land;
    // high-contrast defaults so coastlines/borders read clearly over the filled land:
    // coast = crisp light cyan (land/ocean edge), border = warm amber (distinct hue).
    this.coastCol = opts.coastColor ?? [0.65, 0.92, 1.0, 0.95];
    this.borderCol = opts.borderColor ?? [1.0, 0.72, 0.32, 0.85];
    this.landCol = opts.landColor ?? [0.19, 0.36, 0.26, 1];
  }

  init(ctx: LayerContext): void {
    if (this.land && this.land.length >= 9) {
      const verts = this.land.length / 3;
      this.landR = new TriRenderer(ctx.device, {
        capacity: verts,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
      });
      this.landR.setTriangles(this.land, fill(verts, this.landCol), verts / 3);
    }
    if (this.coast && this.coast.length >= 6) {
      const verts = this.coast.length / 3;
      this.coastR = new LineRenderer(ctx.device, {
        capacity: verts,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
        horizonCull: true, // drape on top of the filled land, cut at the limb
      });
      this.coastR.setSegments(this.coast, fill(verts, this.coastCol), verts / 2);
    }
    if (this.borders && this.borders.length >= 6) {
      const verts = this.borders.length / 3;
      this.borderR = new LineRenderer(ctx.device, {
        capacity: verts,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
        horizonCull: true,
      });
      this.borderR.setSegments(this.borders, fill(verts, this.borderCol), verts / 2);
    }
  }

  update(frame: FrameContext): void {
    // in-shader Earth-fixed spin: the ECEF buffers rotate by Rz(+gmst) with the globe.
    // land is a draped fill -> horizon-cull it (no depth test) so it isn't chord-culled.
    this.landR?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad, true);
    this.coastR?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
    this.borderR?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.landR?.draw(pass); // filled land first, coastlines/borders on top
    this.coastR?.draw(pass);
    this.borderR?.draw(pass);
  }

  dispose(): void {
    this.landR = undefined;
    this.coastR = undefined;
    this.borderR = undefined;
  }
}
