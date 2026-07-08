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
 * Reference-style low-poly Earth: a feature-adaptive **irregular spherical Delaunay**
 * mesh (dense near coastlines/relief, coarse over ocean), colored per-triangle from a
 * real natural-color raster (NASA Blue Marble), with a thin triangle **wireframe** and
 * bold **country borders** on top. Two LOD levels cross-fade by camera altitude so the
 * triangles get smaller/denser as you zoom in.
 *
 * The point density is driven by the image's own edge magnitude — so coastlines and
 * mountains (high local contrast) automatically attract more points. Host supplies the
 * decoded raster (equirect RGBA) + optional border segments; the layer bakes the mesh in
 * init(). Fills reuse MosaicEarthRenderer (direct-color); the far side hides via horizon
 * cull, so the low-poly surface reads on the near hemisphere only.
 */
import { sunEciUnit } from "@dvgl/frames";
import { GeomorphEarthRenderer, ThickLineRenderer } from "@dvgl/webgpu";
import { geoDelaunay } from "d3-geo-voronoi";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const A_KM = 6378.137;
const E2 = 6.69437999014e-3;
const DEG = Math.PI / 180;

/** Decoded equirectangular raster (row-major RGBA, lon -180..180 across, lat 90..-90 down). */
export interface EquirectSampler {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

type V3 = [number, number, number];

function dirToEcef(latDeg: number, lonDeg: number, liftKm: number): V3 {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const sLat = Math.sin(la);
  const cLat = Math.cos(la);
  const n = A_KM / Math.sqrt(1 - E2 * sLat * sLat);
  return [
    (n + liftKm) * cLat * Math.cos(lo),
    (n + liftKm) * cLat * Math.sin(lo),
    (n * (1 - E2) + liftKm) * sLat,
  ];
}
function hashF(i: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function llToDir(latDeg: number, lonDeg: number): V3 {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}
/** Is unit point p inside the spherical triangle (a,b,c) (either winding)? */
function inSphTri(p: V3, a: V3, b: V3, c: V3): boolean {
  const side = (u: V3, v: V3): number =>
    (u[1] * v[2] - u[2] * v[1]) * p[0] +
    (u[2] * v[0] - u[0] * v[2]) * p[1] +
    (u[0] * v[1] - u[1] * v[0]) * p[2];
  const s1 = side(a, b);
  const s2 = side(b, c);
  const s3 = side(c, a);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
/** Point where the ray (origin, dir) meets the plane of ECEF triangle (A,B,C). */
function rayPlane(dir: V3, A: V3, B: V3, C: V3): V3 {
  const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
  const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
  const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  const denom = dir[0] * nx + dir[1] * ny + dir[2] * nz;
  if (Math.abs(denom) < 1e-9) return A;
  const t = (A[0] * nx + A[1] * ny + A[2] * nz) / denom;
  return [dir[0] * t, dir[1] * t, dir[2] * t];
}
function mix3(a: V3, b: V3, t: number): V3 {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

const OCEAN_DEEP: V3 = [0.02, 0.08, 0.19];
const OCEAN_MID: V3 = [0.05, 0.2, 0.36];
const OCEAN_SHALLOW: V3 = [0.11, 0.42, 0.5];
const OCEAN_POLAR: V3 = [0.13, 0.2, 0.3];

/**
 * Stylized ocean facet color: a bathymetric ramp (deep indigo -> teal) driven by a
 * low-frequency field + a coast-shallowness cue, tinted toward steel-blue near the
 * poles, with a small per-facet value jitter — so the sea reads as varied low-poly
 * facets instead of flat navy. `shallow` in [0,1] (1 = near coast).
 */
function oceanTint(lonDeg: number, latDeg: number, shallow: number, h: number): V3 {
  const lo = (lonDeg * Math.PI) / 180;
  const la = (latDeg * Math.PI) / 180;
  const n =
    0.5 +
    0.3 * Math.sin(2.7 * lo + 1.1) * Math.cos(2.1 * la) +
    0.2 * Math.sin(5.3 * la) * Math.cos(4.1 * lo);
  const t = Math.max(0, Math.min(1, 0.55 * n + 0.45 * shallow));
  let c =
    t > 0.5 ? mix3(OCEAN_MID, OCEAN_SHALLOW, (t - 0.5) * 2) : mix3(OCEAN_DEEP, OCEAN_MID, t * 2);
  const absLat = Math.abs(latDeg) / 90;
  c = mix3(c, OCEAN_POLAR, Math.max(0, (absLat - 0.55) / 0.45) * 0.6);
  const v = 1 + (h - 0.5) * 2 * 0.16; // stronger jitter for the sea's low-poly variety
  return [c[0] * v, c[1] * v, c[2] * v];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DelaunayEarthLayerOptions {
  /** Decoded natural-color raster (e.g. NASA Blue Marble equirect). Required for color. */
  readonly sampler: EquirectSampler;
  /** Country-border segments, ECEF km line-list (stride 3, 2 verts/seg) — from parseBasemap. */
  readonly borders?: Float32Array;
  /** Target point counts per LOD level (coarse -> fine). Default [2600, 9000]. */
  readonly levelPoints?: readonly number[];
  readonly liftKm?: number;
  readonly wireColor?: readonly [number, number, number, number];
  readonly borderColor?: readonly [number, number, number, number];
  readonly borderWidthPx?: number;
}

export class DelaunayEarthLayer implements Layer {
  private readonly sampler: EquirectSampler;
  private readonly borders: Float32Array | undefined;
  private readonly levelPoints: readonly number[];
  private readonly lift: number;
  private readonly borderCol: readonly [number, number, number, number];
  private readonly borderWidthPx: number;
  private geo: GeomorphEarthRenderer | undefined;
  private borderR: ThickLineRenderer | undefined;
  private grad: Float32Array | undefined; // GWxGH edge-magnitude density field
  private readonly GW = 512;
  private readonly GH = 256;
  private epochMs = 0;
  private visible = true;

  constructor(opts: DelaunayEarthLayerOptions) {
    this.sampler = opts.sampler;
    this.borders = opts.borders;
    this.levelPoints = opts.levelPoints ?? [5200, 21000];
    this.lift = opts.liftKm ?? 4;
    this.borderCol = opts.borderColor ?? [0.02, 0.02, 0.03, 0.95];
    this.borderWidthPx = opts.borderWidthPx ?? 2.4;
  }

  // ---- raster + density -----------------------------------------------------
  private sampleRgb(lonDeg: number, latDeg: number): V3 {
    const { width: w, height: h, data } = this.sampler;
    let px = Math.floor(((lonDeg + 180) / 360) * w);
    let py = Math.floor(((90 - latDeg) / 180) * h);
    px = ((px % w) + w) % w;
    py = Math.max(0, Math.min(h - 1, py));
    const i = (py * w + px) * 4;
    return [(data[i] ?? 0) / 255, (data[i + 1] ?? 0) / 255, (data[i + 2] ?? 0) / 255];
  }

  private buildDensity(): void {
    const { width: w, height: h, data } = this.sampler;
    const GW = this.GW;
    const GH = this.GH;
    const lum = new Float32Array(GW * GH);
    for (let y = 0; y < GH; y += 1) {
      const sy = Math.min(h - 1, Math.floor((y / GH) * h));
      for (let x = 0; x < GW; x += 1) {
        const sx = Math.min(w - 1, Math.floor((x / GW) * w));
        const i = (sy * w + sx) * 4;
        lum[y * GW + x] =
          (0.3 * (data[i] ?? 0) + 0.59 * (data[i + 1] ?? 0) + 0.11 * (data[i + 2] ?? 0)) / 255;
      }
    }
    const grad = new Float32Array(GW * GH);
    let max = 1e-6;
    for (let y = 1; y < GH - 1; y += 1) {
      for (let x = 1; x < GW - 1; x += 1) {
        const gx = (lum[y * GW + x + 1] ?? 0) - (lum[y * GW + x - 1] ?? 0);
        const gy = (lum[(y + 1) * GW + x] ?? 0) - (lum[(y - 1) * GW + x] ?? 0);
        const m = Math.hypot(gx, gy);
        grad[y * GW + x] = m;
        if (m > max) max = m;
      }
    }
    for (let i = 0; i < grad.length; i += 1) grad[i] = (grad[i] ?? 0) / max;
    this.grad = grad;
  }

  private density(lonDeg: number, latDeg: number): number {
    if (!this.grad) return 1;
    const x = Math.max(0, Math.min(this.GW - 1, Math.floor(((lonDeg + 180) / 360) * this.GW)));
    const y = Math.max(0, Math.min(this.GH - 1, Math.floor(((90 - latDeg) / 180) * this.GH)));
    const g = this.grad[y * this.GW + x] ?? 0;
    return 0.38 + 0.62 * g ** 0.5; // higher ocean floor -> the sea is faceted too, + coast pull
  }

  private generatePoints(n: number, seed: number): [number, number][] {
    const rng = mulberry32(seed);
    const pts: [number, number][] = [];
    const baseN = Math.floor(n * 0.5); // more even base so ocean isn't gigantic
    for (let i = 0; i < baseN; i += 1) {
      pts.push([rng() * 360 - 180, (Math.asin(rng() * 2 - 1) * 180) / Math.PI]);
    }
    let attempts = 0;
    const cap = n * 60;
    while (pts.length < n && attempts < cap) {
      attempts += 1;
      const lon = rng() * 360 - 180;
      const lat = (Math.asin(rng() * 2 - 1) * 180) / Math.PI;
      if (rng() < this.density(lon, lat)) pts.push([lon, lat]);
    }
    pts.push([0, 89.7], [90, -89.7], [-90, -89.7]); // seed poles
    return pts;
  }

  /** Stylized per-facet color: land = real Blue Marble + jitter; ocean = bathymetric. */
  private facetColor(clon: number, clat: number, f: number): V3 {
    const rgb = this.sampleRgb(clon, clat);
    const luma = 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
    const h = hashF(f);
    if (rgb[2] > rgb[0] + 0.015 && rgb[2] > rgb[1] + 0.01 && luma < 0.34) {
      return oceanTint(clon, clat, Math.min(1, luma * 3), h);
    }
    const v = 1 + (h - 0.5) * 2 * 0.09;
    return [rgb[0] * v, rgb[1] * v, rgb[2] * v];
  }

  /**
   * Build the geomorph mesh: an L0 point set + its Delaunay (parent mesh), then L1 =
   * L0 + inserted points. Each L1 vertex remembers where it sits on the parent mesh, so
   * it can morph from the coarse surface out to the sphere as the camera zooms in.
   */
  private buildGeomorph(ctx: LayerContext): void {
    const n0 = this.levelPoints[0] ?? 5200;
    const n1 = this.levelPoints[1] ?? 21000;
    const P0 = this.generatePoints(n0, 12345);
    const del0 = geoDelaunay(P0);
    const tris0 = del0.triangles;
    const dir0: V3[] = P0.map(([lon, lat]) => llToDir(lat, lon));
    const ecef0: V3[] = P0.map(([lon, lat]) => dirToEcef(lat, lon, this.lift));
    const incident: number[][] = P0.map(() => []);
    for (let t = 0; t < tris0.length; t += 1) {
      const tri = tris0[t] as number[];
      for (const idx of tri) (incident[idx] as number[]).push(t);
    }
    // L1 = L0 + inserted; parent position for each vertex
    const extra = this.generatePoints(n1, 6789).slice(0, Math.max(0, n1 - P0.length));
    const P1 = P0.concat(extra);
    const dir1: V3[] = P1.map(([lon, lat]) => llToDir(lat, lon));
    const ecef1: V3[] = P1.map(([lon, lat]) => dirToEcef(lat, lon, this.lift));
    const parent: V3[] = new Array(P1.length);
    for (let i = 0; i < P1.length; i += 1) {
      if (i < P0.length) {
        parent[i] = ecef1[i] as V3;
        continue;
      }
      const [lon, lat] = P1[i] as [number, number];
      const near = del0.find(lon, lat);
      const p = dir1[i] as V3;
      let pp: V3 | undefined;
      for (const t of incident[near] ?? []) {
        const tri = tris0[t] as number[];
        const a = tri[0] as number;
        const b = tri[1] as number;
        const c = tri[2] as number;
        if (inSphTri(p, dir0[a] as V3, dir0[b] as V3, dir0[c] as V3)) {
          pp = rayPlane(p, ecef0[a] as V3, ecef0[b] as V3, ecef0[c] as V3);
          break;
        }
      }
      parent[i] = pp ?? (ecef0[near] as V3);
    }
    // fine mesh (what we render, with geomorph)
    const tris1 = geoDelaunay(P1).triangles;
    const facetCount = tris1.length;
    const verts = new Float32Array(facetCount * 3 * 13);
    const colors = new Float32Array(facetCount * 4);
    const bary: [number, number][] = [
      [1, 0],
      [0, 1],
      [0, 0],
    ];
    let vo = 0;
    for (let f = 0; f < facetCount; f += 1) {
      const tri = tris1[f] as number[];
      const idxs = [tri[0] as number, tri[1] as number, tri[2] as number];
      const a = ecef1[idxs[0] as number] as V3;
      const b = ecef1[idxs[1] as number] as V3;
      const c = ecef1[idxs[2] as number] as V3;
      let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const cx = a[0] + b[0] + c[0];
      const cy = a[1] + b[1] + c[1];
      const cz = a[2] + b[2] + c[2];
      if (nx * cx + ny * cy + nz * cz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const cl = Math.hypot(cx, cy, cz) || 1;
      const clat = (Math.asin(Math.max(-1, Math.min(1, cz / cl))) * 180) / Math.PI;
      const clon = (Math.atan2(cy, cx) * 180) / Math.PI;
      const col = this.facetColor(clon, clat, f);
      colors[f * 4] = Math.max(0, Math.min(1, col[0]));
      colors[f * 4 + 1] = Math.max(0, Math.min(1, col[1]));
      colors[f * 4 + 2] = Math.max(0, Math.min(1, col[2]));
      colors[f * 4 + 3] = 1;
      for (let k = 0; k < 3; k += 1) {
        const idx = idxs[k] as number;
        const tp = ecef1[idx] as V3;
        const pp = parent[idx] as V3;
        const bb = bary[k] as [number, number];
        verts[vo] = tp[0];
        verts[vo + 1] = tp[1];
        verts[vo + 2] = tp[2];
        verts[vo + 3] = pp[0];
        verts[vo + 4] = pp[1];
        verts[vo + 5] = pp[2];
        verts[vo + 6] = nx;
        verts[vo + 7] = ny;
        verts[vo + 8] = nz;
        verts[vo + 9] = f;
        verts[vo + 10] = idx < P0.length ? 0 : 1; // birth level
        verts[vo + 11] = bb[0];
        verts[vo + 12] = bb[1];
        vo += 13;
      }
    }
    const geo = new GeomorphEarthRenderer(ctx.device, {
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      vertices: verts,
      facetCount,
    });
    geo.setFacetColors(colors);
    this.geo = geo;
  }

  init(ctx: LayerContext): void {
    this.buildDensity();
    this.buildGeomorph(ctx);
    if (this.borders && this.borders.length >= 6) {
      const segCount = this.borders.length / 6;
      const bcol = new Float32Array(segCount * 4);
      for (let i = 0; i < segCount; i += 1) bcol.set(this.borderCol, i * 4);
      this.borderR = new ThickLineRenderer(ctx.device, {
        capacity: segCount,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
        widthPx: this.borderWidthPx,
      });
      this.borderR.setSegments(this.borders, bcol, segCount);
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  update(frame: FrameContext): void {
    if (!this.geo) return;
    this.epochMs = frame.epochMs;
    const sun = sunEciUnit(this.epochMs + frame.timeSec * 1000);
    this.geo.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad, sun, 1);
    this.borderR?.updateCamera(
      frame.viewProjRte,
      frame.eyeKm,
      frame.width,
      frame.height,
      frame.gmstRad,
      true,
    );
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.visible || !this.geo) return;
    this.geo.draw(pass);
    this.borderR?.draw(pass);
  }

  dispose(): void {
    this.geo?.dispose();
    this.geo = undefined;
    this.borderR = undefined;
  }
}
