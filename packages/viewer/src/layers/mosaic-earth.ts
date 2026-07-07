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
 * Stylized "mosaic" Earth layer (spike). Builds a faceted **quadsphere** (cube-sphere)
 * as the globe surface, derives a per-facet land/ocean mask from the baked basemap land
 * triangles (same data the coastlines come from — no new asset), and hands both to the
 * MosaicEarthRenderer for shaded-relief cartographic shading.
 *
 * The per-facet DATA field is the strategic unlock: `setDataField(values)` recolors the
 * exact same tessellation as a coverage / revisit / heat choropleth — flip a call and the
 * stylized Earth *becomes* the analysis. `setCartographic()` returns to the relief look.
 *
 * Draw it FIRST (before overlays) — it's an opaque, depth-writing surface; coast/border
 * line overlays then drape on top via BasemapLayer's horizon cull.
 */
import { sunEciUnit } from "@dvgl/frames";
import { MosaicEarthRenderer } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const A_KM = 6378.137;
const E2 = 6.69437999014e-3;

// 6 cube faces as (origin normal, right, up); cubePoint(s,t)=o+r*s+u*t, s,t in [-1,1].
const FACES: ReadonlyArray<{
  o: [number, number, number];
  r: [number, number, number];
  u: [number, number, number];
}> = [
  { o: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { o: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { o: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { o: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { o: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { o: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
];

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Unit direction -> WGS84 ECEF km at the given lift. */
function dirToEcef(d: readonly [number, number, number], liftKm: number): [number, number, number] {
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

/** Low-frequency value field in [0,1] for a hypsometric elevation proxy (spike only). */
function reliefProxy(d: readonly [number, number, number]): number {
  const lon = Math.atan2(d[1], d[0]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[2])));
  const n =
    0.5 +
    0.32 * Math.sin(3.1 * lon + 1.3) * Math.cos(2.3 * lat) +
    0.18 * Math.sin(6.7 * lat + 0.5) * Math.cos(5.3 * lon);
  return Math.max(0, Math.min(1, n));
}

export interface MosaicEarthLayerOptions {
  /** Baked basemap land triangle-list (ECEF km, stride 3, 3 verts/tri) — from parseBasemap. */
  readonly land?: Float32Array;
  /** Cells per cube-face edge. 56 -> ~19k facets (~2-3deg cells). Default 56. */
  readonly facesPerEdge?: number;
  /** Surface lift, km (sits just above the base ellipsoid). Default 3. */
  readonly liftKm?: number;
}

export class MosaicEarthLayer implements Layer {
  private readonly n: number;
  private readonly lift: number;
  private readonly land: Float32Array | undefined;
  private renderer: MosaicEarthRenderer | undefined;
  private facetCenters: [number, number, number][] = []; // unit dirs
  private facetData: Float32Array | undefined; // vec2(landMask, scalar) per facet
  private epochMs = 0;
  private dataMode = false;

  constructor(opts: MosaicEarthLayerOptions = {}) {
    this.n = Math.max(8, opts.facesPerEdge ?? 56);
    this.lift = opts.liftKm ?? 3;
    this.land = opts.land;
  }

  init(ctx: LayerContext): void {
    const n = this.n;
    const facetCount = 6 * n * n;
    // stride 9: pos(3) facetNormal(3) facetId(1) quadUV(2)
    const verts = new Float32Array(facetCount * 6 * 9);
    const centers: [number, number, number][] = new Array(facetCount);
    let fi = 0;
    let vo = 0;
    const cornerUV: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const push = (
      d: readonly [number, number, number],
      nrm: readonly [number, number, number],
      id: number,
      uv: readonly [number, number],
    ): void => {
      const p = dirToEcef(d, this.lift);
      verts[vo] = p[0];
      verts[vo + 1] = p[1];
      verts[vo + 2] = p[2];
      verts[vo + 3] = nrm[0];
      verts[vo + 4] = nrm[1];
      verts[vo + 5] = nrm[2];
      verts[vo + 6] = id;
      verts[vo + 7] = uv[0];
      verts[vo + 8] = uv[1];
      vo += 9;
    };
    for (const f of FACES) {
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          const s0 = (i / n) * 2 - 1;
          const s1 = ((i + 1) / n) * 2 - 1;
          const t0 = (j / n) * 2 - 1;
          const t1 = ((j + 1) / n) * 2 - 1;
          const at = (s: number, t: number): [number, number, number] =>
            norm3(
              f.o[0] + f.r[0] * s + f.u[0] * t,
              f.o[1] + f.r[1] * s + f.u[1] * t,
              f.o[2] + f.r[2] * s + f.u[2] * t,
            );
          const c00 = at(s0, t0);
          const c10 = at(s1, t0);
          const c11 = at(s1, t1);
          const c01 = at(s0, t1);
          const cc = norm3(
            c00[0] + c10[0] + c11[0] + c01[0],
            c00[1] + c10[1] + c11[1] + c01[1],
            c00[2] + c10[2] + c11[2] + c01[2],
          );
          centers[fi] = cc;
          // two triangles: (c00,c10,c11) + (c00,c11,c01), quad corners carry UV
          const quad: [number, number, number][] = [c00, c10, c11, c01];
          const tris: readonly [number, number, number][] = [
            [0, 1, 2],
            [0, 2, 3],
          ];
          for (const tri of tris) {
            for (const ci of tri) {
              push(quad[ci] as [number, number, number], cc, fi, cornerUV[ci] as [number, number]);
            }
          }
          fi += 1;
        }
      }
    }
    this.facetCenters = centers;

    // per-facet land mask (from baked land tris) + relief scalar
    const mask = this.buildLandMask(centers);
    const data = new Float32Array(facetCount * 2);
    for (let k = 0; k < facetCount; k += 1) {
      const land = mask[k] ?? 0;
      data[k * 2] = land;
      const relief = reliefProxy(centers[k] as [number, number, number]);
      // land: bias toward lowland; ocean: mid-depth variation
      data[k * 2 + 1] = land > 0.5 ? relief * relief : 0.25 + 0.5 * relief;
    }
    this.facetData = data;

    this.renderer = new MosaicEarthRenderer(ctx.device, {
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      vertices: verts,
      facetCount,
    });
    this.renderer.setFacetData(data);
  }

  /** Spherical point-in-triangle test of each facet center against the land tris. */
  private buildLandMask(centers: [number, number, number][]): Uint8Array {
    const out = new Uint8Array(centers.length);
    const land = this.land;
    if (!land || land.length < 9) return out;
    const triCount = Math.floor(land.length / 9);
    // precompute normalized verts + bounding cap per tri
    const a = new Float32Array(triCount * 3);
    const b = new Float32Array(triCount * 3);
    const c = new Float32Array(triCount * 3);
    const capC = new Float32Array(triCount * 3);
    const capCos = new Float32Array(triCount);
    for (let t = 0; t < triCount; t += 1) {
      const o = t * 9;
      const va = norm3(land[o] ?? 0, land[o + 1] ?? 0, land[o + 2] ?? 0);
      const vb = norm3(land[o + 3] ?? 0, land[o + 4] ?? 0, land[o + 5] ?? 0);
      const vc = norm3(land[o + 6] ?? 0, land[o + 7] ?? 0, land[o + 8] ?? 0);
      a.set(va, t * 3);
      b.set(vb, t * 3);
      c.set(vc, t * 3);
      const cen = norm3(va[0] + vb[0] + vc[0], va[1] + vb[1] + vc[1], va[2] + vb[2] + vc[2]);
      capC.set(cen, t * 3);
      capCos[t] = Math.min(
        cen[0] * va[0] + cen[1] * va[1] + cen[2] * va[2],
        cen[0] * vb[0] + cen[1] * vb[1] + cen[2] * vb[2],
        cen[0] * vc[0] + cen[1] * vc[1] + cen[2] * vc[2],
      );
    }
    const sideSign = (
      px: number,
      py: number,
      pz: number,
      ux: number,
      uy: number,
      uz: number,
      vx: number,
      vy: number,
      vz: number,
    ): number => {
      // sign of dot(cross(u,v), p)
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      return cx * px + cy * py + cz * pz;
    };
    for (let k = 0; k < centers.length; k += 1) {
      const p = centers[k] as [number, number, number];
      let hit = 0;
      for (let t = 0; t < triCount; t += 1) {
        const cc = t * 3;
        const dotCap =
          (capC[cc] ?? 0) * p[0] + (capC[cc + 1] ?? 0) * p[1] + (capC[cc + 2] ?? 0) * p[2];
        if (dotCap < (capCos[t] ?? 1) - 0.03) continue;
        const ax = a[cc] ?? 0;
        const ay = a[cc + 1] ?? 0;
        const az = a[cc + 2] ?? 0;
        const bx = b[cc] ?? 0;
        const by = b[cc + 1] ?? 0;
        const bz = b[cc + 2] ?? 0;
        const cx = c[cc] ?? 0;
        const cy = c[cc + 1] ?? 0;
        const cz = c[cc + 2] ?? 0;
        const s1 = sideSign(p[0], p[1], p[2], ax, ay, az, bx, by, bz);
        const s2 = sideSign(p[0], p[1], p[2], bx, by, bz, cx, cy, cz);
        const s3 = sideSign(p[0], p[1], p[2], cx, cy, cz, ax, ay, az);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) {
          hit = 1;
          break;
        }
      }
      out[k] = hit;
    }
    return out;
  }

  /** Recolor the mosaic as a per-facet choropleth (values 0..1, one per facet). */
  setDataField(values: Float32Array): void {
    this.renderer?.setScalar(values);
    this.dataMode = true;
  }

  /** Return to the shaded-relief cartographic look. */
  setCartographic(): void {
    if (this.facetData && this.renderer) this.renderer.setFacetData(this.facetData);
    this.dataMode = false;
  }

  /** Facet count (so a host can size a data field). */
  get facetCount(): number {
    return this.facetCenters.length;
  }

  /** Per-facet unit centers (ECI-fixed dirs), for a host to compute a data field. */
  get facetCenters_(): readonly [number, number, number][] {
    return this.facetCenters;
  }

  /**
   * A stand-in coverage/heat field for the data-substrate demo (until wired to live
   * FoR/coverage): a plausible LEO/SSO revisit pattern — higher toward the poles, with
   * low-frequency structure. Length = facetCount, values 0..1.
   */
  demoCoverageField(): Float32Array {
    const out = new Float32Array(this.facetCenters.length);
    for (let k = 0; k < this.facetCenters.length; k += 1) {
      const c = this.facetCenters[k] as [number, number, number];
      const absLat = Math.abs(Math.asin(Math.max(-1, Math.min(1, c[2])))) / (Math.PI / 2);
      const band = 0.35 + 0.65 * absLat; // SSO/polar revisit bias
      const v = band * (0.7 + 0.3 * reliefProxy(c));
      out[k] = Math.max(0, Math.min(1, v));
    }
    return out;
  }

  update(frame: FrameContext): void {
    if (!this.renderer) return;
    this.epochMs = frame.epochMs;
    const sun = sunEciUnit(this.epochMs + frame.timeSec * 1000);
    this.renderer.updateCamera(
      frame.viewProjRte,
      frame.eyeKm,
      frame.gmstRad,
      sun,
      frame.timeSec,
      this.dataMode,
    );
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer?.draw(pass);
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
