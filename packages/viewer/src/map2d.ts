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
 * Map2DView: the flat equirectangular peer of Scene. Same MissionClock, same data
 * inputs (a fleet source, a window source, collects, stations) -- but the world is
 * a lon/lat plane (x = lon/90, y = lat/90) drawn through an orthographic, letter-
 * boxed projection with no depth. It is a distinct VIEW, not a Layer over the globe:
 * geometry is re-projected to sub-satellite coordinates every frame. DOM-independent
 * (host owns the canvas + lifecycle), mirroring Scene.create/resize/start/stop/dispose.
 */
import { MissionClock } from "@dvgl/core";
import { ecefToGeodetic, gmst } from "@dvgl/frames";
import {
  type Collect,
  collectDims,
  collectFootprintCorners,
  collectState,
  collectTargetEcef,
  type GroundStation,
  RevisitGrid,
  stationEcef,
} from "@dvgl/orbits";
import { CoverageOverlay, LineRenderer, PointRenderer, TriRenderer } from "@dvgl/webgpu";
import type { FleetSource } from "./layers/satellites.js";
import type { WindowSource } from "./layers/tracks.js";
import type { PickHit } from "./types.js";

export interface Map2DViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly device?: GPUDevice;
  readonly epochMs?: number;
  readonly windowSeconds?: number;
  readonly rate?: number;
  readonly clearColor?: readonly [number, number, number, number];
  /** Age ramp saturates after this many hours since the last collect. Default 6. */
  readonly coverageWindowHours?: number;
}

const N_LAT = 120;
const N_LON = 240;
const EARTH_R_KM = 6371.0088;
const TRACK_SAMPLES = 129;
const RECOMPUTE_MIN = 12;
const STAMP_CAP_RAD = 90 / EARTH_R_KM;
const CAP = 128;
const EYE0: readonly [number, number, number] = [0, 0, 0];

/** Letterboxed orthographic projection: plane coords -> aspect-correct clip space. */
function orthoViewProj(w: number, h: number): Float32Array {
  const a = w / h;
  const sy = Math.min(0.95, 0.475 * a);
  const sx = sy / a;
  const m = new Float32Array(16);
  m[0] = sx;
  m[5] = sy;
  m[15] = 1;
  return m;
}

export class Map2DView {
  readonly clock: MissionClock;

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly ownsDevice: boolean;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly clear: [number, number, number, number];
  private readonly windowMin: number;

  private readonly pts: PointRenderer;
  private readonly grat: LineRenderer;
  private readonly trackLines: LineRenderer;
  private readonly collectFill: TriRenderer;
  private readonly collectLines: LineRenderer;
  private readonly coverage: CoverageOverlay;
  private stationPts: PointRenderer | undefined;
  private basemapLines: LineRenderer | undefined;
  private basemapSegs = 0;

  private readonly grid = new RevisitGrid(N_LAT, N_LON);
  private readonly ageBuf = new Uint8Array(N_LAT * N_LON);

  private fleet: FleetSource | undefined;
  private colors: Float32Array | undefined;
  private posBuf?: Float32Array;
  private planePos?: Float32Array;

  private trackSource: WindowSource | undefined;
  private winBuf?: Float32Array;
  private periods?: Float32Array;
  private trkPos?: Float32Array;
  private trkCol?: Float32Array;
  private lastCenterMin = Number.NEGATIVE_INFINITY;

  private collects: readonly Collect[] = [];
  private rings: Float32Array[] = [];
  private centers: [number, number, number][] = [];
  private satIdx: number[] = [];
  private satIdxReady = false;
  private readonly mcTri = new Float32Array(CAP * 4 * 3 * 3);
  private readonly mcTriC = new Float32Array(CAP * 4 * 3 * 4);
  private readonly mcSeg = new Float32Array(CAP * 6 * 2 * 3);
  private readonly mcSegC = new Float32Array(CAP * 6 * 2 * 4);

  private stations: GroundStation[] = [];
  private stationPlane?: Float32Array;

  private raf = 0;
  private lastT = 0;
  private running = false;
  private disposed = false;

  private readonly pickCbs = new Set<(hit: PickHit | null) => void>();
  private pickX = -1;
  private pickY = -1;
  private pickPending = false;

  private constructor(opts: Map2DViewOptions, device: GPUDevice, ownsDevice: boolean) {
    this.canvas = opts.canvas;
    this.device = device;
    this.ownsDevice = ownsDevice;
    this.clear = [...(opts.clearColor ?? [0.02, 0.03, 0.06, 1])] as [
      number,
      number,
      number,
      number,
    ];
    this.windowMin = (opts.coverageWindowHours ?? 6) * 60;
    this.clock = new MissionClock({
      epochMs: opts.epochMs ?? 0,
      windowSeconds: opts.windowSeconds ?? 24 * 3600,
      rate: opts.rate ?? 60,
    });

    const context = this.canvas.getContext("webgpu");
    if (!context) throw new Error("no WebGPU canvas context");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    const f = this.format;
    this.pts = new PointRenderer(device, { capacity: 4096, format: f, pointSizePx: 4 });
    this.grat = new LineRenderer(device, { capacity: 4096, format: f });
    this.trackLines = new LineRenderer(device, { capacity: 4096 * TRACK_SAMPLES, format: f });
    this.collectFill = new TriRenderer(device, { capacity: CAP * 4 * 3, format: f });
    this.collectLines = new LineRenderer(device, { capacity: CAP * 6 * 2, format: f });
    this.coverage = new CoverageOverlay(device, {
      mode: "plane",
      gridW: N_LON,
      gridH: N_LAT,
      format: f,
      alpha: 0.55,
      steps: 6,
    });
    this.buildGraticule();
  }

  static async create(opts: Map2DViewOptions): Promise<Map2DView> {
    let device = opts.device;
    let ownsDevice = false;
    if (!device) {
      if (!navigator.gpu) throw new Error("WebGPU unavailable");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("no WebGPU adapter");
      device = await adapter.requestDevice();
      ownsDevice = true;
    }
    return new Map2DView(opts, device, ownsDevice);
  }

  private buildGraticule(): void {
    const seg: number[] = [];
    const col: number[] = [];
    const push = (x0: number, y0: number, x1: number, y1: number, a: number): void => {
      seg.push(x0, y0, 0, x1, y1, 0);
      col.push(0.22, 0.38, 0.55, a, 0.22, 0.38, 0.55, a);
    };
    for (let lon = -180; lon <= 180; lon += 30)
      push(lon / 90, -1, lon / 90, 1, lon === 0 ? 0.7 : 0.4);
    for (let lat = -90; lat <= 90; lat += 30)
      push(-2, lat / 90, 2, lat / 90, lat === 0 ? 0.7 : 0.4);
    this.grat.setSegments(new Float32Array(seg), new Float32Array(col), seg.length / 6);
  }

  setFleetSource(source: FleetSource): void {
    this.fleet = source;
    this.posBuf = new Float32Array(source.count * 3);
    this.planePos = new Float32Array(source.count * 3);
    this.satIdxReady = false;
  }

  setColors(rgba: Float32Array): void {
    this.colors = rgba;
    this.pts.setColors(rgba);
  }

  /** Provide a window source to draw sub-satellite ground tracks. */
  setTrackSource(source: WindowSource): void {
    this.trackSource = source;
    this.winBuf = new Float32Array(source.count * TRACK_SAMPLES * 3);
    this.periods = new Float32Array(source.count);
    this.trkPos = new Float32Array(source.count * TRACK_SAMPLES * 2 * 3);
    this.trkCol = new Float32Array(source.count * TRACK_SAMPLES * 2 * 4);
    this.lastCenterMin = Number.NEGATIVE_INFINITY;
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

  setStations(stations: GroundStation[]): void {
    this.stations = stations;
    this.stationPlane = new Float32Array(stations.length * 3);
    if (!this.stationPts && stations.length > 0) {
      this.stationPts = new PointRenderer(this.device, {
        capacity: stations.length,
        format: this.format,
        pointSizePx: 7,
      });
      this.stationPts.setColors(new Float32Array(stations.flatMap(() => [0.7, 1, 0.7, 1])));
    }
    for (let i = 0; i < stations.length; i += 1) {
      const e = stationEcef(stations[i] as GroundStation).ecef;
      const g = ecefToGeodetic(e[0], e[1], e[2]);
      this.stationPlane[i * 3] = g.lonDeg / 90;
      this.stationPlane[i * 3 + 1] = g.latDeg / 90;
      this.stationPlane[i * 3 + 2] = 0;
    }
  }

  /**
   * Reproject Earth-fixed (ECEF km) coastline/border line-lists to sub-satellite plane
   * coords, splitting antimeridian-crossing segments so they don't streak across the map.
   */
  setBasemap(coastlines?: Float32Array, borders?: Float32Array): void {
    const src: [Float32Array | undefined, readonly [number, number, number, number]][] = [
      [coastlines, [0.42, 0.55, 0.72, 0.85]],
      [borders, [0.35, 0.42, 0.55, 0.6]],
    ];
    const totalSegs = (coastlines?.length ?? 0) / 6 + (borders?.length ?? 0) / 6;
    const pos = new Float32Array(totalSegs * 6);
    const col = new Float32Array(totalSegs * 8);
    let seg = 0;
    for (const [buf, c] of src) {
      if (!buf) continue;
      for (let i = 0; i + 6 <= buf.length; i += 6) {
        const a = ecefToGeodetic(buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0);
        const b = ecefToGeodetic(buf[i + 3] ?? 0, buf[i + 4] ?? 0, buf[i + 5] ?? 0);
        const ax = a.lonDeg / 90;
        const bx = b.lonDeg / 90;
        if (Math.abs(ax - bx) > 2) continue; // antimeridian crossing: drop the streak
        const p = seg * 6;
        pos[p] = ax;
        pos[p + 1] = a.latDeg / 90;
        pos[p + 3] = bx;
        pos[p + 4] = b.latDeg / 90;
        col.set([c[0], c[1], c[2], c[3], c[0], c[1], c[2], c[3]], seg * 8);
        seg += 1;
      }
    }
    this.basemapSegs = seg;
    if (seg > 0) {
      if (!this.basemapLines) {
        this.basemapLines = new LineRenderer(this.device, {
          capacity: seg * 2,
          format: this.format,
        });
      }
      this.basemapLines.setSegments(pos.subarray(0, seg * 6), col.subarray(0, seg * 8), seg);
    }
  }

  /** Subscribe to picks (nearest sub-satellite dot under the cursor, or null). */
  onPick(cb: (hit: PickHit | null) => void): () => void {
    this.pickCbs.add(cb);
    return () => {
      this.pickCbs.delete(cb);
    };
  }

  /** Queue a pick at a device-pixel coordinate; result arrives via onPick next frame. */
  pickAt(xDevicePx: number, yDevicePx: number): void {
    this.pickX = Math.round(xDevicePx);
    this.pickY = Math.round(yDevicePx);
    this.pickPending = true;
  }

  resize(widthPx: number, heightPx: number): void {
    this.canvas.width = Math.max(1, widthPx);
    this.canvas.height = Math.max(1, heightPx);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.ownsDevice) this.device.destroy();
  }

  private ensureSatIdx(): void {
    if (this.satIdxReady || !this.fleet) return;
    const names = this.fleet.names;
    if (!names) return;
    const m = new Map<string, number>();
    names.forEach((n, i) => {
      m.set(n.split("/").pop() ?? n, i);
    });
    this.satIdx = this.collects.map((c) => m.get(c.sat) ?? -1);
    this.satIdxReady = true;
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (this.clock.playing) this.clock.advance(dt);
    this.renderOnce();
    this.raf = requestAnimationFrame(this.loop);
  };

  renderOnce(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const vp = orthoViewProj(w, h);
    const minutes = this.clock.currentSeconds / 60;
    const nowSec = this.clock.currentSeconds;
    const theta = gmst(this.clock.currentUnixMs());
    const cc = Math.cos(theta);
    const ss = Math.sin(theta);
    this.ensureSatIdx();

    // fleet sub-satellite dots
    let count = 0;
    if (this.fleet && this.posBuf && this.planePos) {
      count = this.fleet.count;
      this.fleet.propagateInto(minutes, this.posBuf);
      const pos = this.posBuf;
      const plane = this.planePos;
      for (let k = 0; k < count; k += 1) {
        const x = pos[k * 3] ?? Number.NaN;
        const y = pos[k * 3 + 1] ?? Number.NaN;
        const z = pos[k * 3 + 2] ?? Number.NaN;
        if (!Number.isFinite(x)) {
          plane[k * 3] = 1e12;
          plane[k * 3 + 1] = 1e12;
          plane[k * 3 + 2] = 1e12;
          continue;
        }
        const g = ecefToGeodetic(cc * x + ss * y, -ss * x + cc * y, z);
        plane[k * 3] = g.lonDeg / 90;
        plane[k * 3 + 1] = g.latDeg / 90;
        plane[k * 3 + 2] = 0;
      }
      this.pts.updatePositions(plane, count);
      this.pts.updateCamera(vp, EYE0, w, h);
    }

    // C1: resolve a queued nearest-dot pick against the plane coords just projected
    if (this.pickPending && this.planePos && count > 0) {
      this.pickPending = false;
      const asp = w / h;
      const syp = Math.min(0.95, 0.475 * asp);
      const sxp = syp / asp;
      let best = -1;
      let bestD2 = 16 * 16; // device-px hit radius squared
      const colors = this.colors;
      for (let k = 0; k < count; k += 1) {
        if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
        const plx = this.planePos[k * 3] ?? 1e12;
        if (plx > 1e11) continue;
        const ply = this.planePos[k * 3 + 1] ?? 0;
        const sxk = (sxp * plx * 0.5 + 0.5) * w;
        const syk = (1 - (syp * ply * 0.5 + 0.5)) * h;
        const dx = sxk - this.pickX;
        const dy = syk - this.pickY;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = k;
        }
      }
      const names = this.fleet?.names;
      const hit: PickHit | null =
        best >= 0 ? { index: best, ...(names?.[best] ? { name: names[best] } : {}) } : null;
      for (const cb of this.pickCbs) cb(hit);
    }

    this.grat.updateCamera(vp, EYE0);
    if (this.basemapSegs > 0) this.basemapLines?.updateCamera(vp, EYE0);

    // ground tracks (reproject the ECEF window to sub-satellite lon/lat)
    const tv = this.updateTracks(minutes, vp);

    // coverage: age-of-collection from completed collects
    this.grid.reset();
    for (const c of this.collects) {
      if (c.endSec <= nowSec)
        this.grid.stamp(c.targetLatDeg, c.targetLonDeg, STAMP_CAP_RAD, c.endSec / 60);
    }
    this.grid.ageTexture(minutes, this.windowMin, this.ageBuf);
    this.coverage.setField(this.ageBuf);
    this.coverage.updateCamera(vp, EYE0, 0);

    // collect footprints + active beams
    const [mcT, mcS] = this.updateCollects(nowSec, vp, cc, ss);

    if (this.stationPts && this.stationPlane) {
      this.stationPts.updatePositions(this.stationPlane, this.stations.length);
      this.stationPts.updateCamera(vp, EYE0, w, h);
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: this.clear[3] },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    this.coverage.draw(pass);
    if (this.basemapSegs > 0) this.basemapLines?.draw(pass);
    this.grat.draw(pass);
    if (tv > 0) this.trackLines.draw(pass);
    this.stationPts?.draw(pass);
    if (mcS > 0) {
      if (mcT > 0) this.collectFill.draw(pass);
      this.collectLines.draw(pass);
    }
    if (count > 0) this.pts.draw(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Reproject the ECEF orbit window to antimeridian-split ground-track polylines. */
  private updateTracks(minutes: number, vp: Float32Array): number {
    const src = this.trackSource;
    const win = this.winBuf;
    const per = this.periods;
    const tp = this.trkPos;
    const tc = this.trkCol;
    if (!src || !win || !per || !tp || !tc) return 0;
    if (Math.abs(minutes - this.lastCenterMin) > RECOMPUTE_MIN) {
      this.lastCenterMin = minutes;
      src.sampleWindowInto(minutes, TRACK_SAMPLES, win, this.clock.epochMs, per);
    }
    const count = src.count;
    const colors = this.colors;
    let tv = 0;
    for (let k = 0; k < count; k += 1) {
      if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
      const cr = colors?.[k * 4] ?? 0.6;
      const cg = colors?.[k * 4 + 1] ?? 0.8;
      const cb = colors?.[k * 4 + 2] ?? 1;
      const period = per[k] || 90;
      const fracNow = (minutes - this.lastCenterMin) / period;
      const base = k * TRACK_SAMPLES * 3;
      let plon = Number.NaN;
      let plat = Number.NaN;
      let pok = false;
      for (let s = 0; s < TRACK_SAMPLES; s += 1) {
        const b = base + s * 3;
        const x = win[b] ?? Number.NaN;
        let lon = Number.NaN;
        let lat = Number.NaN;
        let ok = false;
        if (Number.isFinite(x)) {
          const g = ecefToGeodetic(x, win[b + 1] ?? 0, win[b + 2] ?? 0);
          lon = g.lonDeg;
          lat = g.latDeg;
          ok = true;
        }
        if (pok && ok && Math.abs(lon - plon) < 180) {
          // luminance carries past (full) vs next-rev (dimmed); no alpha/dash tricks
          const fracSeg = ((s - 0.5) / (TRACK_SAMPLES - 1)) * 2 - 1;
          const lum = fracSeg <= fracNow ? 1 : 0.4;
          tp[tv * 3] = plon / 90;
          tp[tv * 3 + 1] = plat / 90;
          tc[tv * 4] = cr * lum;
          tc[tv * 4 + 1] = cg * lum;
          tc[tv * 4 + 2] = cb * lum;
          tc[tv * 4 + 3] = 0.85;
          tv += 1;
          tp[tv * 3] = lon / 90;
          tp[tv * 3 + 1] = lat / 90;
          tc[tv * 4] = cr * lum;
          tc[tv * 4 + 1] = cg * lum;
          tc[tv * 4 + 2] = cb * lum;
          tc[tv * 4 + 3] = 0.85;
          tv += 1;
        }
        plon = lon;
        plat = lat;
        pok = ok;
      }
    }
    if (tv > 0) {
      this.trackLines.setSegments(tp.subarray(0, tv * 3), tc.subarray(0, tv * 4), tv / 2);
      this.trackLines.updateCamera(vp, EYE0);
    }
    return tv;
  }

  /** Project collect boxes to the plane, fill/outline by state, beam while active. */
  private updateCollects(
    nowSec: number,
    vp: Float32Array,
    cc: number,
    ss: number,
  ): [number, number] {
    let mcT = 0;
    let mcS = 0;
    if (this.collects.length === 0) return [0, 0];
    const pos = this.posBuf;
    let shown = 0;
    for (let ci = 0; ci < this.collects.length && shown < CAP; ci += 1) {
      const c = this.collects[ci];
      if (!c) continue;
      const st = collectState(c, nowSec, 3600, 900);
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
      const seg = ring.length / 3;
      const px = new Float32Array(seg * 2);
      let xmin = Number.POSITIVE_INFINITY;
      let xmax = Number.NEGATIVE_INFINITY;
      for (let j = 0; j < seg; j += 1) {
        const g = ecefToGeodetic(ring[j * 3] ?? 0, ring[j * 3 + 1] ?? 0, ring[j * 3 + 2] ?? 0);
        px[j * 2] = g.lonDeg / 90;
        px[j * 2 + 1] = g.latDeg / 90;
        xmin = Math.min(xmin, px[j * 2] ?? 0);
        xmax = Math.max(xmax, px[j * 2] ?? 0);
      }
      if (xmax - xmin > 2) continue; // antimeridian: skip smeared box
      const gc = ecefToGeodetic(ctr[0], ctr[1], ctr[2]);
      const cxp = gc.lonDeg / 90;
      const cyp = gc.latDeg / 90;
      for (let j = 0; j < seg; j += 1) {
        const k = (j + 1) % seg;
        const p = mcS * 6;
        this.mcSeg[p] = px[j * 2] ?? 0;
        this.mcSeg[p + 1] = px[j * 2 + 1] ?? 0;
        this.mcSeg[p + 3] = px[k * 2] ?? 0;
        this.mcSeg[p + 4] = px[k * 2 + 1] ?? 0;
        this.mcSegC.set([cr, cg, cb, lineA, cr, cg, cb, lineA], mcS * 8);
        mcS += 1;
        if (fillA > 0) {
          const t = mcT * 3;
          this.mcTri[t] = cxp;
          this.mcTri[t + 1] = cyp;
          this.mcTri[t + 3] = px[j * 2] ?? 0;
          this.mcTri[t + 4] = px[j * 2 + 1] ?? 0;
          this.mcTri[t + 6] = px[k * 2] ?? 0;
          this.mcTri[t + 7] = px[k * 2 + 1] ?? 0;
          this.mcTriC.set([cr, cg, cb, fillA], mcT * 4);
          this.mcTriC.set([cr, cg, cb, fillA], (mcT + 1) * 4);
          this.mcTriC.set([cr, cg, cb, fillA], (mcT + 2) * 4);
          mcT += 3;
        }
      }
      const si = this.satIdx[ci] ?? -1;
      if (st === "active" && si >= 0 && pos) {
        const x = pos[si * 3] ?? Number.NaN;
        if (Number.isFinite(x)) {
          const y = pos[si * 3 + 1] ?? 0;
          const z = pos[si * 3 + 2] ?? 0;
          const g = ecefToGeodetic(cc * x + ss * y, -ss * x + cc * y, z);
          const p = mcS * 6;
          this.mcSeg[p] = g.lonDeg / 90;
          this.mcSeg[p + 1] = g.latDeg / 90;
          this.mcSeg[p + 3] = cxp;
          this.mcSeg[p + 4] = cyp;
          this.mcSegC.set([1, 0.85, 0.35, 0.9, 1, 0.85, 0.35, 0.9], mcS * 8);
          mcS += 1;
        }
      }
    }
    if (mcT > 0) {
      this.collectFill.setTriangles(this.mcTri, this.mcTriC, mcT / 3);
      this.collectFill.updateCamera(vp, EYE0);
    }
    if (mcS > 0) {
      this.collectLines.setSegments(this.mcSeg, this.mcSegC, mcS);
      this.collectLines.updateCamera(vp, EYE0);
    }
    return [mcT, mcS];
  }
}
