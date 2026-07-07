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
 * Low-poly **triangle** mosaic Earth (spike). A geodesic icosphere (subdivided
 * icosahedron) rendered as flat-shaded triangles — the classic low-poly-art look. Each
 * triangle is one facet; its color is computed on the CPU from a swappable **palette**
 * (Landsat-style natural color, terrazzo pop, Imhof muted, viridis, blueprint) and
 * uploaded as a per-facet RGB buffer, so swapping palette is a cheap repaint. The flat
 * per-triangle normal makes adjacent facets catch the sun differently — the faceting.
 *
 * Fills reuse MosaicEarthRenderer's direct-color mode (keeps the smooth terminator,
 * ocean glint, fresnel limb). Coast/border line overlays still drape on top via
 * BasemapLayer, so country boundaries read over the low-poly surface.
 */
import { sunEciUnit } from "@dvgl/frames";
import { defaultMosaicStyle, MosaicEarthRenderer } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const A_KM = 6378.137;
const E2 = 6.69437999014e-3;

type V3 = [number, number, number];

function norm3(x: number, y: number, z: number): V3 {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
function mid(a: V3, b: V3): V3 {
  return norm3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}
function dirToEcef(d: V3, liftKm: number): V3 {
  const lat = Math.asin(Math.max(-1, Math.min(1, d[2])));
  const lon = Math.atan2(d[1], d[0]);
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const n = A_KM / Math.sqrt(1 - E2 * sLat * sLat);
  return [
    (n + liftKm) * cLat * Math.cos(lon),
    (n + liftKm) * cLat * Math.sin(lon),
    (n * (1 - E2) + liftKm) * sLat,
  ];
}
function reliefProxy(d: V3): number {
  const lon = Math.atan2(d[1], d[0]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[2])));
  const n =
    0.5 +
    0.32 * Math.sin(3.1 * lon + 1.3) * Math.cos(2.3 * lat) +
    0.18 * Math.sin(6.7 * lat + 0.5) * Math.cos(5.3 * lon);
  return Math.max(0, Math.min(1, n));
}
function hash01(i: number): number {
  let h = (i * 747796405 + 2891336453) >>> 0;
  h = ((h >>> ((h >>> 28) + 4)) ^ h) * 277803737;
  h >>>= 0;
  return ((h >>> 22) ^ h) / 4294967295;
}
function mixc(a: V3, b: V3, t: number): V3 {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
function hsl(h: number, s: number, l: number): V3 {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0), f(8), f(4)];
}

/** Per-facet feature record feeding the palettes. */
interface Feat {
  land: boolean;
  elev: number; // 0..1 relief proxy
  absLat: number; // 0..1
  hash: number; // 0..1 per facet
}

export type TriPaletteName = "landsat" | "terrazzo" | "imhof" | "viridis" | "blueprint";

const VIRIDIS: V3[] = [
  [0.267, 0.005, 0.329],
  [0.254, 0.265, 0.53],
  [0.164, 0.471, 0.558],
  [0.135, 0.659, 0.518],
  [0.478, 0.821, 0.318],
  [0.993, 0.906, 0.144],
];
function ramp(stops: V3[], t: number): V3 {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, stops.length - 1);
  return mixc(stops[i] as V3, stops[j] as V3, x - i);
}

/** name -> (feat) -> base RGB (jitter applied by the caller). */
const PALETTES: Record<TriPaletteName, (f: Feat) => V3> = {
  landsat: (f) => {
    if (!f.land) return mixc([0.02, 0.07, 0.16], [0.07, 0.26, 0.38], f.elev);
    if (f.absLat > 0.83) return [0.86, 0.89, 0.94]; // ice
    const arid = Math.max(
      0,
      Math.min(1, 0.35 * f.elev + Math.max(0, 0.55 - Math.abs(f.absLat - 0.32) * 2)),
    );
    const green: V3 = [0.16, 0.33, 0.13];
    const forest: V3 = [0.22, 0.4, 0.18];
    const veg = mixc(forest, green, f.elev);
    return mixc(veg, [0.62, 0.53, 0.32], arid); // -> arid tan
  },
  terrazzo: (f) => {
    // saturated distinct hue per facet: warm family on land, cool on ocean
    const base = f.land ? 25 + f.hash * 120 : 175 + f.hash * 70;
    return hsl(base, 0.55, f.land ? 0.5 : 0.42);
  },
  imhof: (f) => {
    if (!f.land) return mixc([0.09, 0.16, 0.22], [0.14, 0.3, 0.36], f.elev);
    return mixc([0.24, 0.29, 0.2], [0.6, 0.63, 0.68], f.elev); // olive -> pale grey-violet
  },
  viridis: (f) =>
    f.land
      ? ramp(VIRIDIS, 0.15 + 0.85 * f.elev)
      : mixc([0.03, 0.05, 0.12], [0.05, 0.12, 0.22], f.elev),
  blueprint: (f) =>
    f.land
      ? mixc([0.2, 0.42, 0.62], [0.5, 0.72, 0.9], f.elev)
      : mixc([0.04, 0.09, 0.2], [0.07, 0.15, 0.3], f.elev),
};

const JITTER: Record<TriPaletteName, number> = {
  landsat: 0.1,
  terrazzo: 0.14,
  imhof: 0.06,
  viridis: 0.09,
  blueprint: 0.12,
};

export interface TriMosaicEarthLayerOptions {
  readonly land?: Float32Array;
  /** Icosphere subdivisions. 4 -> 5,120 tris (chunky); 5 -> 20,480 (default). */
  readonly subdivisions?: number;
  readonly liftKm?: number;
  readonly palette?: TriPaletteName;
}

export class TriMosaicEarthLayer implements Layer {
  private readonly subdiv: number;
  private readonly lift: number;
  private readonly land: Float32Array | undefined;
  private renderer: MosaicEarthRenderer | undefined;
  private feats: Feat[] = [];
  private palette: TriPaletteName;
  private epochMs = 0;
  private visible = true;

  constructor(opts: TriMosaicEarthLayerOptions = {}) {
    this.subdiv = Math.max(2, opts.subdivisions ?? 5);
    this.lift = opts.liftKm ?? 3;
    this.land = opts.land;
    this.palette = opts.palette ?? "landsat";
  }

  private icosphere(): V3[][] {
    // 12-vertex icosahedron
    const t = (1 + Math.sqrt(5)) / 2;
    const v: V3[] = [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ].map((p) => norm3(p[0] as number, p[1] as number, p[2] as number));
    const F = [
      [0, 11, 5],
      [0, 5, 1],
      [0, 1, 7],
      [0, 7, 10],
      [0, 10, 11],
      [1, 5, 9],
      [5, 11, 4],
      [11, 10, 2],
      [10, 7, 6],
      [7, 1, 8],
      [3, 9, 4],
      [3, 4, 2],
      [3, 2, 6],
      [3, 6, 8],
      [3, 8, 9],
      [4, 9, 5],
      [2, 4, 11],
      [6, 2, 10],
      [8, 6, 7],
      [9, 8, 1],
    ];
    let faces: V3[][] = F.map((f) => [
      v[f[0] as number] as V3,
      v[f[1] as number] as V3,
      v[f[2] as number] as V3,
    ]);
    for (let s = 0; s < this.subdiv; s += 1) {
      const next: V3[][] = [];
      for (const [a, b, c] of faces) {
        const ab = mid(a as V3, b as V3);
        const bc = mid(b as V3, c as V3);
        const ca = mid(c as V3, a as V3);
        next.push([a as V3, ab, ca], [ab, b as V3, bc], [ca, bc, c as V3], [ab, bc, ca]);
      }
      faces = next;
    }
    return faces;
  }

  init(ctx: LayerContext): void {
    const faces = this.icosphere();
    const facetCount = faces.length;
    const verts = new Float32Array(facetCount * 3 * 9);
    const centers: V3[] = new Array(facetCount);
    let vo = 0;
    for (let fi = 0; fi < facetCount; fi += 1) {
      const [a, b, c] = faces[fi] as [V3, V3, V3];
      const cc = norm3(a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]);
      centers[fi] = cc;
      // flat geometric normal (unit-sphere winding) -> the low-poly facet catch
      const nrm = norm3(
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      );
      const out = nrm[0] * cc[0] + nrm[1] * cc[1] + nrm[2] * cc[2] < 0 ? -1 : 1;
      for (const d of [a, b, c]) {
        const p = dirToEcef(d, this.lift);
        verts[vo] = p[0];
        verts[vo + 1] = p[1];
        verts[vo + 2] = p[2];
        verts[vo + 3] = nrm[0] * out;
        verts[vo + 4] = nrm[1] * out;
        verts[vo + 5] = nrm[2] * out;
        verts[vo + 6] = fi;
        verts[vo + 7] = 0.5; // quv -> no grout
        verts[vo + 8] = 0.5;
        vo += 9;
      }
    }

    const mask = this.buildLandMask(centers);
    this.feats = centers.map((c, i) => ({
      land: (mask[i] ?? 0) > 0.5,
      elev: reliefProxy(c),
      absLat: Math.abs(Math.asin(Math.max(-1, Math.min(1, c[2])))) / (Math.PI / 2),
      hash: hash01(i),
    }));

    this.renderer = new MosaicEarthRenderer(ctx.device, {
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      vertices: verts,
      facetCount,
    });
    // stronger facet-catch + no grout for the low-poly read
    const style = defaultMosaicStyle();
    style[17] = 0.34; // knobs.y facetShade
    this.renderer.setStyle(style);
    const fd = new Float32Array(facetCount * 2);
    for (let i = 0; i < facetCount; i += 1) fd[i * 2] = (this.feats[i] as Feat).land ? 1 : 0;
    this.renderer.setFacetData(fd);
    this.repaint();
  }

  private repaint(): void {
    if (!this.renderer) return;
    const fn = PALETTES[this.palette];
    const jit = JITTER[this.palette];
    const n = this.feats.length;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      const f = this.feats[i] as Feat;
      const c = fn(f);
      const v = 1 + (f.hash - 0.5) * 2 * jit;
      rgba[i * 4] = Math.max(0, Math.min(1, c[0] * v));
      rgba[i * 4 + 1] = Math.max(0, Math.min(1, c[1] * v));
      rgba[i * 4 + 2] = Math.max(0, Math.min(1, c[2] * v));
      rgba[i * 4 + 3] = 1;
    }
    this.renderer.setFacetColors(rgba);
  }

  setPalette(name: TriPaletteName): void {
    this.palette = name;
    this.repaint();
  }

  get paletteName(): TriPaletteName {
    return this.palette;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  private buildLandMask(centers: V3[]): Uint8Array {
    const out = new Uint8Array(centers.length);
    const land = this.land;
    if (!land || land.length < 9) return out;
    const triCount = Math.floor(land.length / 9);
    for (let t = 0; t < triCount; t += 1) {
      const o = t * 9;
      const a = norm3(land[o] ?? 0, land[o + 1] ?? 0, land[o + 2] ?? 0);
      const b = norm3(land[o + 3] ?? 0, land[o + 4] ?? 0, land[o + 5] ?? 0);
      const c = norm3(land[o + 6] ?? 0, land[o + 7] ?? 0, land[o + 8] ?? 0);
      const cen = norm3(a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]);
      const capCos = Math.min(
        cen[0] * a[0] + cen[1] * a[1] + cen[2] * a[2],
        cen[0] * b[0] + cen[1] * b[1] + cen[2] * b[2],
        cen[0] * c[0] + cen[1] * c[1] + cen[2] * c[2],
      );
      for (let k = 0; k < centers.length; k += 1) {
        if (out[k]) continue;
        const p = centers[k] as V3;
        if (cen[0] * p[0] + cen[1] * p[1] + cen[2] * p[2] < capCos - 0.03) continue;
        const side = (u: V3, w: V3): number =>
          (u[1] * w[2] - u[2] * w[1]) * p[0] +
          (u[2] * w[0] - u[0] * w[2]) * p[1] +
          (u[0] * w[1] - u[1] * w[0]) * p[2];
        const s1 = side(a, b);
        const s2 = side(b, c);
        const s3 = side(c, a);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) out[k] = 1;
      }
    }
    return out;
  }

  update(frame: FrameContext): void {
    if (!this.renderer) return;
    this.epochMs = frame.epochMs;
    const sun = sunEciUnit(this.epochMs + frame.timeSec * 1000);
    this.renderer.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad, sun, frame.timeSec);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.visible) this.renderer?.draw(pass);
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
