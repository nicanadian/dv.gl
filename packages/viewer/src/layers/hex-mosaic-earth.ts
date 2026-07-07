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
 * H3 hexagonal "mosaic" Earth (spike). Same shaded-relief look as MosaicEarthLayer, but
 * the facets are Uber **H3** cells — near-equal-area hexagons (+12 pentagons). Equal-area
 * cells make a coverage/heat choropleth *quantitatively honest* (a bright cell means more
 * density, not a bigger cell), which the plain cube-sphere can't promise.
 *
 * Each cell is a triangle fan (center + boundary); fills reuse the MosaicEarthRenderer,
 * hex edges are drawn as horizon-culled lines (the "grout"). Per-facet data field +
 * demoCoverageField mirror the quad layer.
 */
import { sunEciUnit } from "@dvgl/frames";
import { LineRenderer, MosaicEarthRenderer } from "@dvgl/webgpu";
import { cellToBoundary, cellToChildren, cellToLatLng, getRes0Cells } from "h3-js";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const A_KM = 6378.137;
const E2 = 6.69437999014e-3;
const DEG = Math.PI / 180;

function latLonToDir(latDeg: number, lonDeg: number): [number, number, number] {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}

function dirToEcef(d: readonly [number, number, number], liftKm: number): [number, number, number] {
  const sLat = d[2];
  const n = A_KM / Math.sqrt(1 - E2 * sLat * sLat);
  const cLat = Math.hypot(d[0], d[1]) || 1e-9;
  const lonX = d[0] / cLat;
  const lonY = d[1] / cLat;
  return [(n + liftKm) * cLat * lonX, (n + liftKm) * cLat * lonY, (n * (1 - E2) + liftKm) * sLat];
}

function reliefProxy(d: readonly [number, number, number]): number {
  const lon = Math.atan2(d[1], d[0]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[2])));
  const n =
    0.5 +
    0.32 * Math.sin(3.1 * lon + 1.3) * Math.cos(2.3 * lat) +
    0.18 * Math.sin(6.7 * lat + 0.5) * Math.cos(5.3 * lon);
  return Math.max(0, Math.min(1, n));
}

export interface HexMosaicEarthLayerOptions {
  /** Baked basemap land triangle-list (ECEF km, from parseBasemap) for the land mask. */
  readonly land?: Float32Array;
  /** H3 resolution. 2 -> 5,882 cells (~big, clearly hexagonal); 3 -> 41k. Default 2. */
  readonly resolution?: number;
  /** Surface lift, km. Default 3. */
  readonly liftKm?: number;
}

export class HexMosaicEarthLayer implements Layer {
  private readonly res: number;
  private readonly lift: number;
  private readonly land: Float32Array | undefined;
  private renderer: MosaicEarthRenderer | undefined;
  private edges: LineRenderer | undefined;
  private centers: [number, number, number][] = [];
  private facetData: Float32Array | undefined;
  private epochMs = 0;
  private dataMode = false;
  private visible = true;

  constructor(opts: HexMosaicEarthLayerOptions = {}) {
    this.res = opts.resolution ?? 2;
    this.lift = opts.liftKm ?? 3;
    this.land = opts.land;
  }

  init(ctx: LayerContext): void {
    const cells = getRes0Cells().flatMap((c) => cellToChildren(c, this.res));
    const centers: [number, number, number][] = [];
    const boundaries: [number, number, number][][] = [];
    let vertTotal = 0;
    let edgeTotal = 0;
    for (const cell of cells) {
      const [clat, clon] = cellToLatLng(cell);
      centers.push(latLonToDir(clat, clon));
      const bnd = cellToBoundary(cell).map(([la, lo]) => latLonToDir(la, lo));
      boundaries.push(bnd);
      vertTotal += bnd.length * 3; // fan: one tri per boundary edge
      edgeTotal += bnd.length; // one segment per boundary edge
    }
    this.centers = centers;

    const verts = new Float32Array(vertTotal * 9);
    const ep = new Float32Array(edgeTotal * 2 * 3);
    const ec = new Float32Array(edgeTotal * 2 * 4);
    let vo = 0;
    let eo = 0;
    let es = 0;
    const edgeRgba = [0.06, 0.07, 0.09, 0.85];
    const put = (
      d: readonly [number, number, number],
      nrm: readonly [number, number, number],
      id: number,
    ): void => {
      const p = dirToEcef(d, this.lift);
      verts[vo] = p[0];
      verts[vo + 1] = p[1];
      verts[vo + 2] = p[2];
      verts[vo + 3] = nrm[0];
      verts[vo + 4] = nrm[1];
      verts[vo + 5] = nrm[2];
      verts[vo + 6] = id;
      verts[vo + 7] = 0.5; // quadUV -> no shader grout (edges drawn as lines)
      verts[vo + 8] = 0.5;
      vo += 9;
    };
    for (let ci = 0; ci < boundaries.length; ci += 1) {
      const bnd = boundaries[ci] as [number, number, number][];
      const cc = centers[ci] as [number, number, number];
      const m = bnd.length;
      for (let i = 0; i < m; i += 1) {
        const a = bnd[i] as [number, number, number];
        const b = bnd[(i + 1) % m] as [number, number, number];
        put(cc, cc, ci);
        put(a, cc, ci);
        put(b, cc, ci);
        const pa = dirToEcef(a, this.lift);
        const pb = dirToEcef(b, this.lift);
        ep[eo] = pa[0];
        ep[eo + 1] = pa[1];
        ep[eo + 2] = pa[2];
        ep[eo + 3] = pb[0];
        ep[eo + 4] = pb[1];
        ep[eo + 5] = pb[2];
        ec.set(edgeRgba, es * 8);
        ec.set(edgeRgba, es * 8 + 4);
        eo += 6;
        es += 1;
      }
    }
    // per-cell land mask + relief scalar
    const mask = this.buildLandMask(centers);
    const data = new Float32Array(centers.length * 2);
    for (let k = 0; k < centers.length; k += 1) {
      const land = mask[k] ?? 0;
      data[k * 2] = land;
      const relief = reliefProxy(centers[k] as [number, number, number]);
      data[k * 2 + 1] = land > 0.5 ? relief * relief : 0.25 + 0.5 * relief;
    }
    this.facetData = data;

    this.renderer = new MosaicEarthRenderer(ctx.device, {
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      vertices: verts,
      facetCount: centers.length,
    });
    this.renderer.setFacetData(data);
    this.edges = new LineRenderer(ctx.device, {
      capacity: es * 2,
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      horizonCull: true,
    });
    this.edges.setSegments(ep, ec, es);
  }

  private buildLandMask(centers: [number, number, number][]): Uint8Array {
    const out = new Uint8Array(centers.length);
    const land = this.land;
    if (!land || land.length < 9) return out;
    const triCount = Math.floor(land.length / 9);
    const nrm = (x: number, y: number, z: number): [number, number, number] => {
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    for (let t = 0; t < triCount; t += 1) {
      const o = t * 9;
      const a = nrm(land[o] ?? 0, land[o + 1] ?? 0, land[o + 2] ?? 0);
      const b = nrm(land[o + 3] ?? 0, land[o + 4] ?? 0, land[o + 5] ?? 0);
      const c = nrm(land[o + 6] ?? 0, land[o + 7] ?? 0, land[o + 8] ?? 0);
      const cen = nrm(a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]);
      const capCos = Math.min(
        cen[0] * a[0] + cen[1] * a[1] + cen[2] * a[2],
        cen[0] * b[0] + cen[1] * b[1] + cen[2] * b[2],
        cen[0] * c[0] + cen[1] * c[1] + cen[2] * c[2],
      );
      for (let k = 0; k < centers.length; k += 1) {
        if (out[k]) continue;
        const p = centers[k] as [number, number, number];
        if (cen[0] * p[0] + cen[1] * p[1] + cen[2] * p[2] < capCos - 0.03) continue;
        const side = (u: [number, number, number], v: [number, number, number]): number =>
          (u[1] * v[2] - u[2] * v[1]) * p[0] +
          (u[2] * v[0] - u[0] * v[2]) * p[1] +
          (u[0] * v[1] - u[1] * v[0]) * p[2];
        const s1 = side(a, b);
        const s2 = side(b, c);
        const s3 = side(c, a);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) out[k] = 1;
      }
    }
    return out;
  }

  setDataField(values: Float32Array): void {
    this.renderer?.setScalar(values);
    this.dataMode = true;
  }

  setCartographic(): void {
    if (this.facetData && this.renderer) this.renderer.setFacetData(this.facetData);
    this.dataMode = false;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  get facetCount(): number {
    return this.centers.length;
  }

  /** Equal-area demo coverage field (poleward revisit bias) — honest per H3 cells. */
  demoCoverageField(): Float32Array {
    const out = new Float32Array(this.centers.length);
    for (let k = 0; k < this.centers.length; k += 1) {
      const c = this.centers[k] as [number, number, number];
      const absLat = Math.abs(Math.asin(Math.max(-1, Math.min(1, c[2])))) / (Math.PI / 2);
      out[k] = Math.max(0, Math.min(1, (0.35 + 0.65 * absLat) * (0.7 + 0.3 * reliefProxy(c))));
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
    this.edges?.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.visible) return;
    this.renderer?.draw(pass);
    this.edges?.draw(pass);
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
    this.edges = undefined;
  }
}
